#if WINDOWS
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace FamilyRmm.Agent;

public static class RemoteSessionCompanion
{
    public static void Run()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new SessionCompanionForm());
    }
}

internal sealed class SessionCompanionForm : Form
{
    private readonly NotifyIcon _tray;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private CancellationTokenSource? _shutdown;
    private NamedPipeClientStream? _pipe;
    private StreamReader? _reader;
    private StreamWriter? _writer;
    private SessionIndicator? _indicator;
    private System.Windows.Forms.Timer? _captureTimer;
    private string? _sessionId;
    private string? _technician;
    private bool _captureInProgress;

    public SessionCompanionForm()
    {
        ShowInTaskbar = false;
        WindowState = FormWindowState.Minimized;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-32000, -32000);
        Size = new Size(1, 1);
        _tray = new NotifyIcon { Icon = SystemIcons.Shield, Text = "Family RMM remote access is idle", Visible = false };
        _tray.DoubleClick += (_, _) => MessageBox.Show("Family RMM remote access is idle. A remote session will always ask the device user before sharing the screen.", "Family RMM Agent", MessageBoxButtons.OK, MessageBoxIcon.Information);
        Shown += (_, _) => { Hide(); _shutdown = new CancellationTokenSource(); _ = ConnectLoopAsync(_shutdown.Token); };
        FormClosing += (_, _) => { _shutdown?.Cancel(); _captureTimer?.Stop(); _tray.Visible = false; };
    }

    private async Task ConnectLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeClientStream(".", "FamilyRmmLiveSession", PipeDirection.InOut, PipeOptions.Asynchronous);
                _pipe = pipe;
                await pipe.ConnectAsync(2500, cancellationToken);
                using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 8192, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 8192, leaveOpen: true) { AutoFlush = true };
                _reader = reader; _writer = writer;
                while (!cancellationToken.IsCancellationRequested && pipe.IsConnected)
                {
                    var line = await reader.ReadLineAsync(cancellationToken);
                    if (line is null) break;
                    using var message = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
                    await HandleCommandAsync(message.RootElement, cancellationToken);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (Exception exception)
            {
                _tray.Text = "Family RMM remote access is reconnecting";
                if (_sessionId is not null) await StopSessionAsync(false, cancellationToken);
                try { await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken); } catch (OperationCanceledException) { break; }
            }
            finally { _reader = null; _writer = null; _pipe = null; }
        }
    }

    private async Task HandleCommandAsync(JsonElement command, CancellationToken cancellationToken)
    {
        var type = command.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
        if (type == "request_consent")
        {
            _sessionId = command.GetProperty("sessionId").GetString();
            _technician = command.TryGetProperty("technician", out var technician) ? technician.GetString() : "an RMM administrator";
            var machine = command.TryGetProperty("deviceName", out var device) ? device.GetString() : Environment.MachineName;
            var accepted = await AskConsentAsync(_technician ?? "an RMM administrator", machine ?? Environment.MachineName, cancellationToken);
            _tray.Text = accepted ? "Family RMM screen sharing is active" : "Family RMM remote access is idle";
            await WriteAsync(new { type = accepted ? "consent_granted" : "consent_denied" }, cancellationToken);
            if (!accepted) _sessionId = null;
            return;
        }
        if (type == "start_capture")
        {
            _sessionId = command.GetProperty("sessionId").GetString() ?? _sessionId;
            BeginVisibleSession();
            return;
        }
        if (type == "end")
        {
            await WriteAsync(new { type = "ended" }, cancellationToken);
            await StopSessionAsync(false, cancellationToken);
            return;
        }
        if (type == "pointer" || type == "mouse_down" || type == "mouse_up" || type == "key_down" || type == "key_up" || type == "scroll")
        {
            if (_sessionId is not null) ApplyInput(command);
        }
    }

    private Task<bool> AskConsentAsync(string technician, string deviceName, CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(new Action(() =>
        {
            var result = MessageBox.Show(this,
                $"{technician} is requesting a remote support session with {deviceName}.\n\nIf you approve, the technician can view your screen and control your mouse and keyboard. A visible sharing banner will remain on screen, and you can stop the session at any time.\n\nDo you want to allow this session?",
                "Family RMM · Remote session request", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            completion.TrySetResult(result == DialogResult.Yes);
        }));
        cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
        return completion.Task;
    }

    private void BeginVisibleSession()
    {
        if (InvokeRequired) { BeginInvoke(new Action(BeginVisibleSession)); return; }
        _indicator?.Close(); _indicator?.Dispose();
        _indicator = new SessionIndicator(_technician ?? "RMM technician", () => _ = UserStoppedAsync());
        _indicator.Show(); _indicator.TopMost = true; _indicator.Activate();
        _captureTimer?.Stop(); _captureTimer?.Dispose();
        _captureTimer = new System.Windows.Forms.Timer { Interval = 250 };
        _captureTimer.Tick += async (_, _) => await CaptureFrameAsync();
        _captureTimer.Start();
    }

    private async Task CaptureFrameAsync()
    {
        if (_captureInProgress || _sessionId is null || _pipe?.IsConnected != true) return;
        _captureInProgress = true;
        try
        {
            var screen = SystemInformation.VirtualScreen;
            if (screen.Width < 1 || screen.Height < 1) return;
            var scale = Math.Min(1.0, Math.Min(1280.0 / screen.Width, 720.0 / screen.Height));
            var width = Math.Max(1, (int)Math.Round(screen.Width * scale));
            var height = Math.Max(1, (int)Math.Round(screen.Height * scale));
            using var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(CaptureVirtualScreen(screen), new Rectangle(0,0,width,height));
            }
            using var output = new MemoryStream();
            var encoder = ImageCodecInfo.GetImageEncoders().First(info => info.MimeType == "image/jpeg");
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 48L);
            bitmap.Save(output, encoder, parameters);
            var bytes = output.ToArray();
            if (bytes.Length > 1_300_000) return;
            await WriteAsync(new { type = "frame", data = Convert.ToBase64String(bytes) }, _shutdown?.Token ?? CancellationToken.None);
        }
        catch (Exception exception)
        {
            await WriteAsync(new { type = "helper_error", reason = "Screen capture could not continue." }, _shutdown?.Token ?? CancellationToken.None);
            await StopSessionAsync(false, _shutdown?.Token ?? CancellationToken.None);
            _tray.Text = "Family RMM screen sharing stopped after an error";
        }
        finally { _captureInProgress = false; }
    }

    private static Bitmap CaptureVirtualScreen(Rectangle screen)
    {
        var bitmap = new Bitmap(screen.Width, screen.Height, PixelFormat.Format24bppRgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.CopyFromScreen(screen.Left, screen.Top, 0, 0, screen.Size, CopyPixelOperation.SourceCopy);
        return bitmap;
    }

    private async Task UserStoppedAsync()
    {
        if (_sessionId is not null) await WriteAsync(new { type = "user_ended" }, _shutdown?.Token ?? CancellationToken.None);
        await StopSessionAsync(false, _shutdown?.Token ?? CancellationToken.None);
        _tray.Text = "Family RMM remote access is idle";
        try { _pipe?.Dispose(); } catch { }
    }

    private async Task StopSessionAsync(bool notifyAgent, CancellationToken cancellationToken)
    {
        if (InvokeRequired) { BeginInvoke(new Action(async () => await StopSessionAsync(notifyAgent, cancellationToken))); return; }
        _captureTimer?.Stop(); _captureTimer?.Dispose(); _captureTimer = null;
        if (notifyAgent && _sessionId is not null) await WriteAsync(new { type = "user_ended" }, cancellationToken);
        _indicator?.Close(); _indicator?.Dispose(); _indicator = null;
        _sessionId = null; _technician = null; _captureInProgress = false;
    }

    private async Task WriteAsync<T>(T value, CancellationToken cancellationToken)
    {
        var writer = _writer;
        if (writer is null || _pipe?.IsConnected != true) return;
        await _writeLock.WaitAsync(cancellationToken);
        try { await writer.WriteLineAsync(JsonSerializer.Serialize(value).AsMemory(), cancellationToken); }
        finally { _writeLock.Release(); }
    }

    private static void ApplyInput(JsonElement input)
    {
        var type = input.GetProperty("type").GetString();
        if (type is "pointer" or "mouse_down" or "mouse_up")
        {
            var x = Math.Clamp(input.GetProperty("x").GetDouble(), 0, 1);
            var y = Math.Clamp(input.GetProperty("y").GetDouble(), 0, 1);
            var screen = SystemInformation.VirtualScreen;
            var absoluteX = (int)Math.Round(x * 65535);
            var absoluteY = (int)Math.Round(y * 65535);
            var flags = 0x0001u | 0x8000u | 0x4000u;
            SendMouse(absoluteX, absoluteY, 0, flags);
            if (type is "mouse_down" or "mouse_up")
            {
                var button = input.GetProperty("button").GetString();
                var down = type == "mouse_down";
                var clickFlag = button switch { "left" => down ? 0x0002u : 0x0004u, "right" => down ? 0x0008u : 0x0010u, "middle" => down ? 0x0020u : 0x0040u, _ => 0u };
                if (clickFlag != 0) SendMouse(0, 0, 0, clickFlag);
            }
            _ = screen;
            return;
        }
        if (type is "key_down" or "key_up")
        {
            var code = input.GetProperty("code").GetString() ?? "";
            if (TryVirtualKey(code, out var key)) SendKey(key, type == "key_up");
            return;
        }
        if (type == "scroll")
        {
            var delta = Math.Clamp(input.GetProperty("delta").GetInt32(), -1200, 1200);
            SendMouse(0, 0, unchecked((uint)delta), 0x0800);
        }
    }

    private static bool TryVirtualKey(string code, out ushort key)
    {
        var known = new Dictionary<string, ushort>(StringComparer.Ordinal)
        {
            ["Enter"] = 0x0D, ["Escape"] = 0x1B, ["Space"] = 0x20, ["Tab"] = 0x09, ["Backspace"] = 0x08,
            ["Delete"] = 0x2E, ["Insert"] = 0x2D, ["Home"] = 0x24, ["End"] = 0x23, ["PageUp"] = 0x21, ["PageDown"] = 0x22,
            ["ArrowUp"] = 0x26, ["ArrowDown"] = 0x28, ["ArrowLeft"] = 0x25, ["ArrowRight"] = 0x27,
            ["ShiftLeft"] = 0xA0, ["ShiftRight"] = 0xA1, ["ControlLeft"] = 0xA2, ["ControlRight"] = 0xA3,
            ["AltLeft"] = 0xA4, ["AltRight"] = 0xA5, ["MetaLeft"] = 0x5B, ["MetaRight"] = 0x5C,
            ["CapsLock"] = 0x14, ["Backquote"] = 0xC0, ["Minus"] = 0xBD, ["Equal"] = 0xBB,
            ["BracketLeft"] = 0xDB, ["BracketRight"] = 0xDD, ["Backslash"] = 0xDC,
            ["Semicolon"] = 0xBA, ["Quote"] = 0xDE, ["Comma"] = 0xBC, ["Period"] = 0xBE, ["Slash"] = 0xBF,
            ["NumpadAdd"] = 0x6B, ["NumpadSubtract"] = 0x6D, ["NumpadMultiply"] = 0x6A, ["NumpadDivide"] = 0x6F,
            ["NumpadDecimal"] = 0x6E, ["NumpadEnter"] = 0x0D,
        };
        if (known.TryGetValue(code, out key)) return true;
        if (code.Length == 4 && code.StartsWith("Key",StringComparison.Ordinal) && char.IsAsciiLetter(code[3])) { key = char.ToUpperInvariant(code[3]); return true; }
        if (code.Length == 6 && code.StartsWith("Digit",StringComparison.Ordinal) && char.IsAsciiDigit(code[5])) { key = code[5]; return true; }
        if (code.Length == 7 && code.StartsWith("Numpad",StringComparison.Ordinal) && char.IsAsciiDigit(code[6])) { key = (ushort)(0x60 + code[6] - '0'); return true; }
        if (code.Length is 2 or 3 && code[0] == 'F' && ushort.TryParse(code.AsSpan(1),out var function) && function is >= 1 and <= 12) { key = (ushort)(0x70 + function - 1); return true; }
        key = 0; return false;
    }

    private static void SendMouse(int x, int y, uint data, uint flags) => SendInput(1, [new Input { Type = 0, Union = new InputUnion { Mouse = new MouseInput { X = x, Y = y, Data = data, Flags = flags } } }], Marshal.SizeOf<Input>());
    private static void SendKey(ushort key, bool keyUp) => SendInput(1, [new Input { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = keyUp ? 0x0002u : 0u } } }], Marshal.SizeOf<Input>());

    protected override void Dispose(bool disposing)
    {
        if (disposing) { _tray.Dispose(); _writeLock.Dispose(); _shutdown?.Dispose(); }
        base.Dispose(disposing);
    }

    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public InputUnion Union; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X; public int Y; public uint Data; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort VirtualKey; public ushort ScanCode; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
}

internal sealed class SessionIndicator : Form
{
    public SessionIndicator(string technician, Action stop)
    {
        Text = "Family RMM session active"; FormBorderStyle = FormBorderStyle.FixedToolWindow; ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual; TopMost = true; BackColor = Color.FromArgb(104,31,38); ForeColor = Color.White;
        ClientSize = new Size(410,64); Location = new Point(Math.Max(8,(Screen.PrimaryScreen?.Bounds.Width ?? 800)-420), 10);
        var title = new Label { Text = "SCREEN SHARING ACTIVE", ForeColor = Color.White, Font = new Font("Segoe UI",9,FontStyle.Bold), Location = new Point(12,7), AutoSize = true };
        var detail = new Label { Text = $"Family RMM · {technician}", ForeColor = Color.FromArgb(255,224,226), Font = new Font("Segoe UI",8), Location = new Point(12,31), AutoSize = true };
        var button = new Button { Text = "Stop sharing", BackColor = Color.White, ForeColor = Color.FromArgb(100,31,38), FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI",8,FontStyle.Bold), Size = new Size(100,30), Location = new Point(298,17) };
        button.FlatAppearance.BorderSize = 0; button.Click += (_,_) => stop();
        Controls.AddRange([title,detail,button]);
    }
}
#endif
