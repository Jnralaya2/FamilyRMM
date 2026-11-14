#if WINDOWS
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace FamilyRmm.Agent;

public sealed class RemoteSessionWorker(ILogger<RemoteSessionWorker> logger, AgentOptions options, AgentIdentityStore identities, HttpClient client) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var identityKey = identities.OpenPrivateKey();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (identities.IsEnrolled) await ProcessNextAsync(identityKey, stoppingToken);
                await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (HttpRequestException exception) when (exception.StatusCode == HttpStatusCode.Forbidden)
            {
                logger.LogWarning("Remote session polling is not authorized: {Error}", exception.Message);
                await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
            }
            catch (Exception exception)
            {
                logger.LogWarning("Remote session polling failed: {Error}", exception.Message);
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    private async Task ProcessNextAsync(ECDsa identityKey, CancellationToken cancellationToken)
    {
        using var response = await SendJsonAsync("/api/agent/remote-sessions/next", new { }, identityKey, cancellationToken);
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        if (!json.RootElement.TryGetProperty("session", out var session) || session.ValueKind != JsonValueKind.Object) return;
        var sessionId = session.GetProperty("id").GetString() ?? "";
        var action = session.GetProperty("action").GetString() ?? "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(sessionId, "^[a-f0-9]{32}$")) throw new InvalidDataException("The server returned an invalid remote session identifier.");
        if (action == "end") { await SendEventAsync(sessionId, "ended", null, identityKey, cancellationToken); return; }
        if (action != "start_session") return;
        var technician = session.TryGetProperty("technician", out var tech) ? tech.GetString() ?? "an administrator" : "an administrator";
        var deviceName = session.TryGetProperty("deviceName", out var name) ? name.GetString() ?? Environment.MachineName : Environment.MachineName;
        await RunSessionAsync(sessionId, technician, deviceName, identityKey, cancellationToken);
    }

    private async Task RunSessionAsync(string sessionId, string technician, string deviceName, ECDsa identityKey, CancellationToken cancellationToken)
    {
        NamedPipeServerStream? pipe = null;
        PipeChannel? channel = null;
        try
        {
            pipe = RemoteSessionPipe.CreateServer();
            await pipe.WaitForConnectionAsync(cancellationToken).WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
            if (!RemoteSessionPipe.IsActiveConsoleClient(pipe.SafePipeHandle)) throw new UnauthorizedAccessException("The remote session helper is not in the interactive console session.");
            channel = new PipeChannel(pipe);
            pipe = null;
            await channel.WriteAsync(new { type = "start_capture", sessionId }, cancellationToken);
            await SendEventAsync(sessionId, "connected", null, identityKey, cancellationToken);
            await RunActiveSessionAsync(sessionId, channel, identityKey, cancellationToken);
            return;
        }
        catch (TimeoutException exception)
        {
            await TryReportFailureAsync(sessionId, exception.Message, identityKey, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await TryReportFailureAsync(sessionId, exception.Message, identityKey, cancellationToken);
            throw;
        }
        finally
        {
            if (channel is not null) await channel.DisposeAsync();
            if (pipe is not null) await pipe.DisposeAsync();
        }
    }

    private async Task RunActiveSessionAsync(string sessionId, PipeChannel channel, ECDsa identityKey, CancellationToken stoppingToken)
    {
        using var active = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var controls = PollControlsAsync(sessionId, channel, identityKey, active.Token);
        try
        {
            while (!active.IsCancellationRequested)
            {
                var read = channel.ReadLineAsync(active.Token);
                var completed = await Task.WhenAny(read, controls);
                if (completed == controls)
                {
                    await controls;
                    await SendEventAsync(sessionId, "ended", null, identityKey, stoppingToken);
                    return;
                }
                var line = await read;
                if (line is null) { await SendEventAsync(sessionId, "disconnected", null, identityKey, stoppingToken); return; }
                using var message = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
                var root = message.RootElement;
                var type = root.TryGetProperty("type", out var value) ? value.GetString() : null;
                if (type == "user_ended") { await SendEventAsync(sessionId, "ended", null, identityKey, stoppingToken); return; }
                if (type == "helper_error") { await SendEventAsync(sessionId, "failed", root.TryGetProperty("reason", out var reason) ? reason.GetString() : "Screen capture failed.", identityKey, stoppingToken); return; }
                if (type != "frame" || !root.TryGetProperty("data", out var encoded) || encoded.ValueKind != JsonValueKind.String) continue;
                byte[] frame;
                try { frame = Convert.FromBase64String(encoded.GetString() ?? ""); }
                catch (FormatException) { throw new InvalidDataException("The session helper sent an invalid screen frame."); }
                if (frame.Length is < 4 or > 1_500_000) throw new InvalidDataException("The session helper frame is outside the allowed size.");
                using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post,
                    $"{options.ServerUrl}/api/agent/remote-sessions/{sessionId}/frame", frame, identities.Current.DeviceId, identityKey, stoppingToken);
                if (response.StatusCode == HttpStatusCode.Gone || response.StatusCode == HttpStatusCode.Conflict) { await channel.WriteAsync(new { type = "end" }, stoppingToken); await SendEventAsync(sessionId, "ended", null, identityKey, stoppingToken); return; }
                if ((int)response.StatusCode != 429) response.EnsureSuccessStatusCode();
            }
        }
        finally
        {
            active.Cancel();
            try { await controls; } catch (OperationCanceledException) { }
        }
    }

    private async Task PollControlsAsync(string sessionId, PipeChannel channel, ECDsa identityKey, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            using var response = await SendJsonAsync("/api/agent/remote-sessions/controls", new { }, identityKey, cancellationToken);
            using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (json.RootElement.TryGetProperty("session", out var session) && session.ValueKind == JsonValueKind.Object && session.GetProperty("id").GetString() == sessionId && session.GetProperty("action").GetString() == "end")
            {
                await channel.WriteAsync(new { type = "end" }, cancellationToken);
                return;
            }
            if (json.RootElement.TryGetProperty("controls", out var controls) && controls.ValueKind == JsonValueKind.Array)
                foreach (var control in controls.EnumerateArray()) await channel.WriteJsonAsync(control, cancellationToken);
            await Task.Delay(TimeSpan.FromMilliseconds(200), cancellationToken);
        }
    }

    private async Task SendEventAsync(string sessionId, string eventName, string? reason, ECDsa identityKey, CancellationToken cancellationToken)
    {
        var body = new Dictionary<string, object?> { ["event"] = eventName };
        if (reason is not null) body["reason"] = reason;
        using var response = await SendJsonAsync($"/api/agent/remote-sessions/{sessionId}/event", body, identityKey, cancellationToken);
    }

    private async Task TryReportFailureAsync(string sessionId, string reason, ECDsa identityKey, CancellationToken cancellationToken)
    {
        try { await SendEventAsync(sessionId, "failed", reason, identityKey, cancellationToken); }
        catch (Exception exception) { logger.LogWarning("Could not report remote session failure: {Error}", exception.Message); }
    }

    private async Task<HttpResponseMessage> SendJsonAsync(string relativePath, object body, ECDsa identityKey, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(body);
        var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, options.ServerUrl + relativePath, bytes, identities.Current.DeviceId, identityKey, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Forbidden) { var text = await response.Content.ReadAsStringAsync(cancellationToken); response.Dispose(); throw new HttpRequestException(text, null, HttpStatusCode.Forbidden); }
        response.EnsureSuccessStatusCode();
        return response;
    }
}

internal sealed class PipeChannel(NamedPipeServerStream pipe) : IAsyncDisposable
{
    private readonly StreamReader _reader = new(pipe, new UTF8Encoding(false), false, 8192, leaveOpen: true);
    private readonly StreamWriter _writer = new(pipe, new UTF8Encoding(false), 8192, leaveOpen: true) { AutoFlush = true };
    private readonly SemaphoreSlim _writeLock = new(1,1);
    public Task<string?> ReadLineAsync(CancellationToken cancellationToken) => _reader.ReadLineAsync(cancellationToken).AsTask();
    public async Task WriteAsync<T>(T value, CancellationToken cancellationToken)
    {
        await _writeLock.WaitAsync(cancellationToken);
        try { await _writer.WriteLineAsync(JsonSerializer.Serialize(value).AsMemory(), cancellationToken); }
        finally { _writeLock.Release(); }
    }
    public async Task WriteJsonAsync(JsonElement value, CancellationToken cancellationToken)
    {
        await _writeLock.WaitAsync(cancellationToken);
        try { await _writer.WriteLineAsync(value.GetRawText().AsMemory(), cancellationToken); }
        finally { _writeLock.Release(); }
    }
    public async ValueTask DisposeAsync()
    {
        _reader.Dispose(); await _writer.DisposeAsync(); await pipe.DisposeAsync(); _writeLock.Dispose();
    }
}

internal static class RemoteSessionPipe
{
    private const string PipeName = "FamilyRmmLiveSession";
    private const string SecurityDescriptor = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)";
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint PipeWait = 0;
    private const uint PipeRejectRemoteClients = 0x00000008;

    public static NamedPipeServerStream CreateServer()
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(SecurityDescriptor, 1, out var descriptor, out _))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not secure the remote-session pipe.");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), SecurityDescriptor = descriptor, InheritHandle = false };
            var handle = CreateNamedPipe($"\\\\.\\pipe\\{PipeName}", PipeAccessDuplex | FileFlagOverlapped,
                PipeWait | PipeRejectRemoteClients, 1, 1_600_000, 1_600_000, 0, ref attributes);
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not create the remote-session pipe.");
            return new NamedPipeServerStream(PipeDirection.InOut, isAsync: true, isConnected: false, safePipeHandle: handle);
        }
        finally { LocalFree(descriptor); }
    }

    public static bool IsActiveConsoleClient(SafePipeHandle handle)
    {
        if (!GetNamedPipeClientSessionId(handle, out var clientSession)) return false;
        var consoleSession = WTSGetActiveConsoleSessionId();
        return consoleSession != uint.MaxValue && clientSession == consoleSession;
    }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint clientSessionId);
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll", EntryPoint = "LocalFree")] private static extern IntPtr LocalFree(IntPtr memory);
}
#endif
