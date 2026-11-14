using FamilyRmm.Agent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Win32;

namespace FamilyRmm.Agent;

// Watches the host's network adapters and reports *why* a device went offline.
// When a cable is unplugged or Wi-Fi drops, it tells the server immediately so
// the dashboard can distinguish "cable pulled" from "agent stopped".
public sealed class NetworkWatchdogWorker : BackgroundService
{
    private readonly ILogger<NetworkWatchdogWorker> _logger;
    private readonly AgentOptions _options;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly HttpClient _client;
    private readonly AgentIdentityStore _identity;
    private readonly List<string> _activeAdapters = new();
    private string _lastReportedReason = "connected";

    public NetworkWatchdogWorker(ILogger<NetworkWatchdogWorker> logger, IOptions<AgentOptions> options, IHostApplicationLifetime lifetime, HttpClient client, AgentIdentityStore identity)
    {
        _logger = logger;
        _options = options.Value;
        _lifetime = lifetime;
        _client = client;
        _identity = identity;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(8), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var reason = DetectNetworkState();
                if (reason != _lastReportedReason)
                {
                    _lastReportedReason = reason;
                    _logger.LogInformation("Network watchdog: {Reason}", reason);
                    await ReportAsync(reason, stoppingToken);
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                _logger.LogDebug("Network watchdog check failed: {Message}", exception.Message);
            }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private string DetectNetworkState()
    {
        var adapters = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter => adapter.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up &&
                              adapter.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
            .ToList();
        _activeAdapters.Clear();
        foreach (var adapter in adapters) _activeAdapters.Add(adapter.Id);
        if (adapters.Count == 0) return "cable_pulled";
        // Distinguish Wi-Fi vs wired by the active adapter type.
        return adapters.Any(a => a.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211)
            ? "connected_wifi" : "connected_wired";
    }

    private async Task ReportAsync(string reason, CancellationToken token)
    {
        if (!_identity.IsEnrolled) return;
        var body = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { reason, at = DateTimeOffset.UtcNow });
        using var response = await EnrollmentProtocol.SendSignedAsync(_client, HttpMethod.Post, $"{_options.ServerUrl}/api/agent/presence/network-reason", body, _identity.Current.DeviceId, _identity.OpenPrivateKey(), token);
        if (!response.IsSuccessStatusCode)
            _logger.LogWarning("Network reason report returned HTTP {Status}", (int)response.StatusCode);
    }
}