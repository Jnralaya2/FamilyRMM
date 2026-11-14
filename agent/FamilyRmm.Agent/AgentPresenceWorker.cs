using System.Net.NetworkInformation;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;

namespace FamilyRmm.Agent;

/// <summary>
/// Maintains an authenticated, independent presence channel so deployments or
/// inventory work cannot make a healthy device appear offline.
/// </summary>
public sealed class AgentPresenceWorker(
    ILogger<AgentPresenceWorker> logger,
    AgentOptions options,
    AgentIdentityStore identities) : BackgroundService
{
    private static readonly TimeSpan PresenceHeartbeatInterval = TimeSpan.FromSeconds(30);
    private readonly SemaphoreSlim _networkChanged = new(0, 1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        NetworkChange.NetworkAvailabilityChanged += OnNetworkAvailabilityChanged;
        NetworkChange.NetworkAddressChanged += OnNetworkAddressChanged;
        var retryDelay = TimeSpan.FromSeconds(2);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                if (!identities.IsEnrolled)
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                    continue;
                }

                try
                {
                    await ConnectAndMaintainAsync(stoppingToken);
                    retryDelay = TimeSpan.FromSeconds(2);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception exception)
                {
                    logger.LogWarning("Presence connection failed; retrying in {RetrySeconds}s: {Error}",
                        retryDelay.TotalSeconds, exception.Message);
                    await WaitBeforeRetryAsync(retryDelay, stoppingToken);
                    retryDelay = TimeSpan.FromSeconds(Math.Min(retryDelay.TotalSeconds * 2, 60));
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            NetworkChange.NetworkAvailabilityChanged -= OnNetworkAvailabilityChanged;
            NetworkChange.NetworkAddressChanged -= OnNetworkAddressChanged;
        }
    }

    private async Task ConnectAndMaintainAsync(CancellationToken stoppingToken)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
        socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(5);

        var identity = identities.Current;
        var privateKey = identities.OpenPrivateKey();
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var signedMessage = Encoding.UTF8.GetBytes($"familyrmm-agent-presence-v1\n{identity.DeviceId}\n{timestamp}\n{nonce}");
        var signature = Convert.ToBase64String(privateKey.SignData(signedMessage, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        socket.Options.SetRequestHeader("x-device-id", identity.DeviceId);
        socket.Options.SetRequestHeader("x-device-timestamp", timestamp);
        socket.Options.SetRequestHeader("x-device-nonce", nonce);
        socket.Options.SetRequestHeader("x-device-signature", signature);

        await socket.ConnectAsync(BuildPresenceUri(options.ServerUrl), stoppingToken);
        logger.LogInformation("Authenticated presence connection established for device {DeviceId}.", identity.DeviceId);
        await MaintainConnectionAsync(socket, stoppingToken);
        throw new WebSocketException("The presence connection closed; reconnecting.");
    }

    private async Task MaintainConnectionAsync(ClientWebSocket socket, CancellationToken stoppingToken)
    {
        using var session = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var sender = SendHeartbeatsAsync(socket, session.Token);
        var receiver = ReceiveUntilClosedAsync(socket, session.Token);
        var networkChange = _networkChanged.WaitAsync(session.Token);
        var completed = await Task.WhenAny(sender, receiver, networkChange);
        session.Cancel();
        socket.Abort();
        try { await completed; } catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested) { }
        if (stoppingToken.IsCancellationRequested) return;
        if (completed == networkChange)
            throw new IOException("A network interface changed; reconnecting the presence channel.");
        if (completed == sender) await sender;
        if (completed == receiver) await receiver;
    }

    private static async Task SendHeartbeatsAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var message = JsonSerializer.SerializeToUtf8Bytes(new
        {
            type = "heartbeat",
            sentAt = DateTimeOffset.UtcNow,
        });
        while (!cancellationToken.IsCancellationRequested)
        {
            await socket.SendAsync(message, WebSocketMessageType.Text, true, cancellationToken);
            await Task.Delay(PresenceHeartbeatInterval, cancellationToken);
        }
    }

    private static async Task ReceiveUntilClosedAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[1024];
        while (!cancellationToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) return;
            // Presence acknowledgements are informational. Heartbeats and all
            // management commands continue through their existing signed APIs.
        }
    }

    private async Task WaitBeforeRetryAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var timer = Task.Delay(delay, wait.Token);
        var networkChange = _networkChanged.WaitAsync(wait.Token);
        var completed = await Task.WhenAny(timer, networkChange);
        wait.Cancel();
        if (completed == networkChange)
        {
            try { await networkChange; } catch (OperationCanceledException) { }
            logger.LogInformation("Network change detected; retrying the presence connection immediately.");
        }
        else
        {
            try { await timer; } catch (OperationCanceledException) { }
        }
    }

    private void OnNetworkAvailabilityChanged(object? sender, NetworkAvailabilityEventArgs eventArgs) => SignalNetworkChange();
    private void OnNetworkAddressChanged(object? sender, EventArgs eventArgs) => SignalNetworkChange();

    private void SignalNetworkChange()
    {
        try { if (_networkChanged.CurrentCount == 0) _networkChanged.Release(); }
        catch (ObjectDisposedException) { }
        catch (SemaphoreFullException) { }
    }

    private static Uri BuildPresenceUri(string serverUrl)
    {
        var uri = new Uri(serverUrl, UriKind.Absolute);
        var builder = new UriBuilder(uri)
        {
            Scheme = uri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = "/api/agent/presence",
            Query = "",
            Fragment = "",
        };
        return builder.Uri;
    }
}
