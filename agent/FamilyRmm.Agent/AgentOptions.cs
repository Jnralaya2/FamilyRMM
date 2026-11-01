using System.Text.Json;

namespace FamilyRmm.Agent;

public sealed class AgentOptions
{
    public required string ServerUrl { get; init; }
    public JsonElement EnrollmentGrant { get; init; }
    public bool HasEnrollmentGrant => EnrollmentGrant.ValueKind == JsonValueKind.Object && EnrollmentGrant.TryGetProperty("manifest", out _);
    public string AgentVersion { get; init; } = "0.2.4";
    public string? TaskSigningPublicKey { get; init; }
    public DateTimeOffset GrantExpiresAt
    {
        get
        {
            try { return EnrollmentGrant.GetProperty("manifest").GetProperty("expiresAt").GetDateTimeOffset(); }
            catch { return DateTimeOffset.MinValue; }
        }
    }

    public static AgentOptions Load(string path)
    {
        if (!File.Exists(path)) throw new InvalidOperationException("The signed installer configuration file is missing.");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path), new JsonDocumentOptions { MaxDepth = 16 });
        var root = document.RootElement;
        var serverUrl = root.GetProperty("serverUrl").GetString()?.TrimEnd('/') ?? "";
        if (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var server) || server.Scheme != Uri.UriSchemeHttps && !(server.IsLoopback && server.Scheme == Uri.UriSchemeHttp))
            throw new InvalidOperationException("The RMM server URL must use HTTPS (HTTP is allowed only for local development). ");
        var grant = root.TryGetProperty("enrollmentGrant", out var enrollmentGrant) ? enrollmentGrant.Clone() : default;
        if (grant.ValueKind != JsonValueKind.Undefined &&
            (grant.ValueKind != JsonValueKind.Object || !grant.TryGetProperty("manifest", out var manifest) || manifest.ValueKind != JsonValueKind.Object ||
             !grant.TryGetProperty("signature", out var signature) || signature.ValueKind != JsonValueKind.String))
            throw new InvalidOperationException("The signed enrollment grant is invalid.");
        var taskSigningPublicKey = root.TryGetProperty("taskSigningPublicKey", out var taskKey) && taskKey.ValueKind == JsonValueKind.String ? taskKey.GetString() : null;
        if (!string.IsNullOrWhiteSpace(taskSigningPublicKey))
        {
            using var parsedTaskKey = System.Security.Cryptography.ECDsa.Create();
            parsedTaskKey.ImportFromPem(taskSigningPublicKey);
            if (parsedTaskKey.KeySize != 256) throw new InvalidOperationException("The deployment task signing key is invalid.");
        }
        return new AgentOptions { ServerUrl = serverUrl, EnrollmentGrant = grant, AgentVersion = root.TryGetProperty("agentVersion", out var version) ? version.GetString() ?? "0.2.4" : "0.2.4", TaskSigningPublicKey = taskSigningPublicKey };
    }
}
