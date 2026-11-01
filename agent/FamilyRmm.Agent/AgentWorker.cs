using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Hosting;

namespace FamilyRmm.Agent;

public sealed class AgentWorker(ILogger<AgentWorker> logger, AgentOptions options, AgentIdentityStore identities, HttpClient client) : BackgroundService
{
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan SoftwareInventoryInterval = TimeSpan.FromHours(24);
    private DateTimeOffset _lastSoftwareInventory = DateTimeOffset.MinValue;
    private readonly string _statusPath = Path.Combine(identities.DataDirectory, "status.json");

#if AGENT_TEST_HARNESS
    public async Task<bool> ReconcileEnrollmentOnceAsync(CancellationToken cancellationToken)
    {
        client.Timeout = TimeSpan.FromSeconds(30);
        var identityKey = identities.OpenPrivateKey();
        return await EnsureEnrollmentAsync(identityKey, cancellationToken);
    }
#endif

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        client.Timeout = TimeSpan.FromSeconds(30);
        var identityKey = identities.OpenPrivateKey();
        await SetStatus("starting", "Checking the RMM server and installer authorization.", cancellationToken);
        if (!await EnsureEnrollmentAsync(identityKey, cancellationToken))
            throw new InvalidOperationException("Enrollment is waiting for administrator approval.");
        await SendHeartbeat(identityKey, cancellationToken);
        await SendSoftwareInventory(identityKey, cancellationToken);
        await DeploymentProtocol.ProcessNextAsync(client, options, identities, identityKey, cancellationToken);
        await SetStatus("connected", "Device is registered and checking in.", cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        client.Timeout = TimeSpan.FromSeconds(30);
        var identityKey = identities.OpenPrivateKey();
        var serverKey = default(AgentServerKey);
        await SetStatus("starting", "Checking the RMM server and installer authorization.", stoppingToken);
        var backoff = TimeSpan.FromSeconds(5);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await EnsureEnrollmentAsync(identityKey, stoppingToken))
                {
                    await SetStatus("pending", "Enrollment is waiting for administrator approval.", stoppingToken);
                    await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
                    continue;
                }

                await SendHeartbeat(identityKey, stoppingToken);
                if (DateTimeOffset.UtcNow - _lastSoftwareInventory >= SoftwareInventoryInterval)
                {
                    await SendSoftwareInventory(identityKey, stoppingToken);
                    _lastSoftwareInventory = DateTimeOffset.UtcNow;
                }
                await DeploymentProtocol.ProcessNextAsync(client, options, identities, identityKey, stoppingToken);
                await SetStatus("connected", "Device is registered and checking in.", stoppingToken);
                backoff = TimeSpan.FromSeconds(5);
                await Task.Delay(HeartbeatInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (HttpRequestException exception) when (exception.StatusCode == HttpStatusCode.Forbidden)
            {
                // Preserve the server's structured denial reason in the local
                // status file. EnrollmentProtocol includes only the API's
                // bounded `error` field here; hiding it made grant/config
                // failures indistinguishable from a genuinely revoked key.
                var reason = string.IsNullOrWhiteSpace(exception.Message)
                    ? "The server denied this device."
                    : exception.Message[..Math.Min(exception.Message.Length, 400)];
                logger.LogError("The RMM server denied this device: {Reason}", reason);
                await SetStatus("revoked", reason, stoppingToken);
                await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
            }
            catch (Exception exception)
            {
                logger.LogWarning("RMM connection failed: {Error}", exception.Message);
                await SetStatus("disconnected", "Cannot reach the RMM server. Retrying automatically.", stoppingToken);
                await Task.Delay(backoff, stoppingToken);
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 300));
            }
        }
    }

    private async Task<bool> EnsureEnrollmentAsync(System.Security.Cryptography.ECDsa identityKey, CancellationToken cancellationToken)
    {
        if (identities.IsEnrolled)
        {
            try
            {
                var status = await EnrollmentProtocol.GetEnrollmentStatusAsync(client, identities, identityKey, options, cancellationToken);
                if (string.Equals(status, "approved", StringComparison.OrdinalIgnoreCase)) return true;
                identities.MarkEnrollmentPending();
                if (string.Equals(status, "pending", StringComparison.OrdinalIgnoreCase)) return false;
            }
            catch (HttpRequestException exception) when (exception.StatusCode == HttpStatusCode.Forbidden)
            {
                // A persisted local "enrolled" flag is not proof that the server
                // still has this device. Re-submit the signed enrollment request;
                // a missing server record becomes pending, while a revoked or
                // cross-workspace identity is still rejected by the server.
                logger.LogWarning("The server no longer recognizes device {DeviceId}; requesting enrollment again.", identities.Current.DeviceId);
                identities.MarkEnrollmentPending();
            }
        }

        var serverKey = await EnrollmentProtocol.ValidateGrantAsync(client, options, cancellationToken);
        var result = await EnrollmentProtocol.EnrollAsync(client, options, identities, serverKey, cancellationToken);
        if (!string.Equals(result.Status, "approved", StringComparison.OrdinalIgnoreCase) || !result.CheckInAllowed)
        {
            identities.MarkEnrollmentPending();
            return false;
        }

        identities.MarkEnrolled();
        logger.LogInformation("Device registration completed for {DeviceId}.", identities.Current.DeviceId);
        return true;
    }

    private async Task SendHeartbeat(System.Security.Cryptography.ECDsa key, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(WindowsInventory.Hardware(options.AgentVersion));
        using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/heartbeat", body, identities.Current.DeviceId, key, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Forbidden) throw new HttpRequestException("The device is not authorized.", null, response.StatusCode);
        response.EnsureSuccessStatusCode();
    }

    private async Task SendSoftwareInventory(System.Security.Cryptography.ECDsa key, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { software = WindowsInventory.Software() });
        using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/inventory", body, identities.Current.DeviceId, key, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Forbidden) throw new HttpRequestException("The device is not authorized.", null, response.StatusCode);
        response.EnsureSuccessStatusCode();
    }

    private async Task SetStatus(string status, string message, CancellationToken cancellationToken)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_statusPath)!);
            var state = new { status, message, deviceId = identities.Current?.DeviceId, serverUrl = options.ServerUrl, updatedAt = DateTimeOffset.UtcNow };
            await File.WriteAllBytesAsync(_statusPath, JsonSerializer.SerializeToUtf8Bytes(state), cancellationToken);
        }
        catch (Exception exception) { logger.LogDebug("Could not persist local status: {Error}", exception.Message); }
    }
}
