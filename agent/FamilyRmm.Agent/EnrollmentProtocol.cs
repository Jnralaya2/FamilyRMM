using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace FamilyRmm.Agent;

public sealed record DeviceIdentity(string DeviceId, string PublicKeyPem, string EncryptedPrivateKey);
public sealed record EnrollmentReply(string DeviceId, string Status, bool CheckInAllowed);
public sealed record AgentServerKey(string Algorithm, string PublicKey, string ServerUrl);

public static class EnrollmentProtocol
{
    public static async Task<AgentServerKey> ValidateGrantAsync(HttpClient client, AgentOptions options, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync($"{options.ServerUrl}/api/enrollment/public-key", cancellationToken);
        response.EnsureSuccessStatusCode();
        var key = await response.Content.ReadFromJsonAsync<AgentServerKey>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("The RMM server returned an invalid enrollment key.");
        if (key.Algorithm != "ECDSA-P256-SHA256" || key.ServerUrl.TrimEnd('/') != options.ServerUrl)
            throw new InvalidOperationException("The installer grant targets a different RMM server or signing algorithm.");
        if (!string.IsNullOrWhiteSpace(options.TaskSigningPublicKey) && options.TaskSigningPublicKey.Trim() != key.PublicKey.Trim())
            throw new InvalidOperationException("The server deployment signing key differs from the key pinned in the installer.");
        if (options.HasEnrollmentGrant)
        {
            var manifest = options.EnrollmentGrant.GetProperty("manifest");
            if (manifest.GetProperty("serverUrl").GetString()?.TrimEnd('/') != options.ServerUrl ||
                manifest.GetProperty("audience").GetString()?.TrimEnd('/') != options.ServerUrl ||
                manifest.GetProperty("version").GetInt32() != 1 ||
                manifest.GetProperty("expiresAt").GetDateTimeOffset() <= DateTimeOffset.UtcNow)
                throw new InvalidOperationException("The enrollment authorization is expired or belongs to another RMM server.");
            var signatureText = options.EnrollmentGrant.GetProperty("signature").GetString() ?? "";
            using var serverKey = ECDsa.Create();
            serverKey.ImportFromPem(key.PublicKey);
            if (!serverKey.VerifyData(CanonicalJson(manifest), FromBase64Url(signatureText), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence))
                throw new InvalidOperationException("The enrollment authorization signature is invalid.");
        }
        return key;
    }

    public static async Task<EnrollmentReply> EnrollAsync(HttpClient client, AgentOptions options, AgentIdentityStore identities, AgentServerKey serverKey, CancellationToken cancellationToken)
    {
        var identityKey = identities.OpenPrivateKey();
        var identity = identities.Current;
        var nonce = ToBase64Url(RandomNumberGenerator.GetBytes(24));
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var grantId = options.HasEnrollmentGrant ? options.EnrollmentGrant.GetProperty("manifest").GetProperty("grantId").GetString() : null;
        var proofMessage = Encoding.UTF8.GetBytes(options.HasEnrollmentGrant
            ? $"{grantId}\n{identity.DeviceId}\n{timestamp}\n{nonce}"
            : $"{identity.DeviceId}\n{timestamp}\n{nonce}");
        var proof = ToBase64Url(identityKey.SignData(proofMessage, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
        var payload = new
        {
            enrollmentGrant = options.HasEnrollmentGrant ? options.EnrollmentGrant : (JsonElement?)null,
            deviceId = identity.DeviceId,
            name = Environment.MachineName,
            operatingSystem = "Windows",
            osVersion = Environment.OSVersion.Version.ToString(),
            architecture = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
            agentVersion = options.AgentVersion,
            devicePublicKey = identity.PublicKeyPem,
            clientNonce = nonce,
            timestamp,
            proofSignature = proof,
        };
        using var response = await client.PostAsJsonAsync($"{options.ServerUrl}/api/agent/enroll", payload, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
            var error = $"HTTP {(int)response.StatusCode}";
            try { using var errorJson = JsonDocument.Parse(responseText); if (errorJson.RootElement.TryGetProperty("error", out var message)) error = message.GetString() ?? error; } catch { }
            throw new HttpRequestException($"Enrollment was rejected: {error}", null, response.StatusCode);
        }
        return await response.Content.ReadFromJsonAsync<EnrollmentReply>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("The RMM server returned an invalid enrollment response.");
    }

    public static async Task<string> GetEnrollmentStatusAsync(HttpClient client, AgentIdentityStore identities, ECDsa key, AgentOptions options, CancellationToken cancellationToken)
    {
        using var response = await SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/enroll/status", "{}"u8.ToArray(), identities.Current.DeviceId, key, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.Forbidden)
        {
            var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
            var error = "The device is not authorized.";
            try
            {
                using var errorJson = JsonDocument.Parse(responseText);
                if (errorJson.RootElement.TryGetProperty("error", out var message)) error = message.GetString() ?? error;
            }
            catch { /* Keep the bounded default message for non-JSON responses. */ }
            throw new HttpRequestException($"Enrollment status was rejected: {error}", null, response.StatusCode);
        }
        response.EnsureSuccessStatusCode();
        using var status = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return status.RootElement.GetProperty("status").GetString() ?? "pending";
    }

    public static async Task<HttpResponseMessage> SendSignedAsync(HttpClient client, HttpMethod method, string url, byte[] body, string deviceId, ECDsa key, CancellationToken cancellationToken)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        var nonce = ToBase64Url(RandomNumberGenerator.GetBytes(24));
        var prefix = Encoding.UTF8.GetBytes($"{timestamp}\n{nonce}\n");
        var message = new byte[prefix.Length + body.Length];
        Buffer.BlockCopy(prefix, 0, message, 0, prefix.Length);
        Buffer.BlockCopy(body, 0, message, prefix.Length, body.Length);
        var signature = ToBase64Url(key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
        using var request = new HttpRequestMessage(method, url) { Content = new ByteArrayContent(body) };
        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        request.Headers.Add("x-device-id", deviceId);
        request.Headers.Add("x-device-timestamp", timestamp);
        request.Headers.Add("x-device-nonce", nonce);
        request.Headers.Add("x-device-signature", signature);
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    }

    public static byte[] CanonicalJson(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) WriteCanonical(writer, element);
        return stream.ToArray();
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal))
                { writer.WritePropertyName(property.Name); WriteCanonical(writer, property.Value); }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray(); foreach (var item in value.EnumerateArray()) WriteCanonical(writer, item); writer.WriteEndArray(); break;
            case JsonValueKind.String: writer.WriteStringValue(value.GetString()); break;
            case JsonValueKind.Number: writer.WriteRawValue(value.GetRawText()); break;
            case JsonValueKind.True: writer.WriteBooleanValue(true); break;
            case JsonValueKind.False: writer.WriteBooleanValue(false); break;
            case JsonValueKind.Null: writer.WriteNullValue(); break;
            default: throw new InvalidOperationException("Unsupported enrollment manifest value.");
        }
    }

    public static byte[] FromBase64Url(string value) => Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
    public static string ToBase64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
