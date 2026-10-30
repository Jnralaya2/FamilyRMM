using System.Text.Json;

namespace FamilyRmm.Agent;

public sealed class AgentOptions
{
    public required string ServerUrl { get; init; }
    public required JsonElement EnrollmentGrant { get; init; }
    public string AgentVersion { get; init; } = "0.1.0";
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
        var grant = root.GetProperty("enrollmentGrant").Clone();
        if (grant.ValueKind != JsonValueKind.Object || grant.GetProperty("manifest").ValueKind != JsonValueKind.Object || grant.GetProperty("signature").ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("The signed enrollment grant is invalid.");
        return new AgentOptions { ServerUrl = serverUrl, EnrollmentGrant = grant, AgentVersion = root.TryGetProperty("agentVersion", out var version) ? version.GetString() ?? "0.1.0" : "0.1.0" };
    }
}
