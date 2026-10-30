using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FamilyRmm.Bootstrapper;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new InstallForm());
    }
}

internal sealed class InstallForm : Form
{
    private readonly Label _status;
    private readonly Button _install;

    public InstallForm()
    {
        Text = "Family RMM Agent Setup";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 230);
        BackColor = Color.White;

        var mark = new Label { Text = "F", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 18, FontStyle.Bold), ForeColor = Color.White, BackColor = Color.FromArgb(23, 111, 106), Location = new Point(28, 26), Size = new Size(42, 42) };
        var title = new Label { Text = "Family RMM Agent", Font = new Font("Segoe UI", 16, FontStyle.Bold), ForeColor = Color.FromArgb(31, 47, 62), Location = new Point(84, 27), AutoSize = true };
        var publisher = new Label { Text = "Family Systems · Windows endpoint service", Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(111, 126, 139), Location = new Point(85, 58), AutoSize = true };
        _status = new Label { Text = "Install the background service and connect this computer to your RMM server.", Font = new Font("Segoe UI", 10), ForeColor = Color.FromArgb(75, 89, 102), Location = new Point(30, 97), Size = new Size(380, 45) };
        _install = new Button { Text = "Install agent", Location = new Point(278, 168), Size = new Size(132, 36), BackColor = Color.FromArgb(23, 111, 106), ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI", 9, FontStyle.Bold) };
        _install.FlatAppearance.BorderSize = 0;
        _install.Click += InstallClick;
        Controls.AddRange([mark, title, publisher, _status, _install]);
        AcceptButton = _install;
    }

    private async void InstallClick(object? sender, EventArgs eventArgs) => await LaunchMsiAsync();

    private async Task LaunchMsiAsync()
    {
        _install.Enabled = false;
        var directory = Path.Combine(Path.GetTempPath(), "FamilyRMM-Setup", Guid.NewGuid().ToString("N"));
        var msiPath = Path.Combine(directory, "FamilyRmmAgent.msi");
        try
        {
            Directory.CreateDirectory(directory);
            await using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("FamilyRmmAgent.msi")
                ?? throw new InvalidOperationException("The Windows installer is missing from this setup package."))
            await using (var output = new FileStream(msiPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true))
                await resource.CopyToAsync(output);

            _status.Text = "Starting Windows Installer. Approve the standard administrator prompt when requested.";
            var start = new ProcessStartInfo("msiexec.exe") { Arguments = $"/i \"{msiPath}\"", UseShellExecute = true, Verb = "runas" };
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Windows Installer could not be started.");
            await process.WaitForExitAsync();
            if (process.ExitCode == 0)
            {
                _status.Text = "Installation completed. The agent service will register and check in automatically.";
                _install.Text = "Close";
                _install.Enabled = true;
                _install.Click -= InstallClick;
                _install.Click += (_, _) => Close();
            }
            else
            {
                _status.Text = $"Windows Installer returned code {process.ExitCode}. You can retry or contact your administrator.";
                _install.Enabled = true;
            }
        }
        catch (System.ComponentModel.Win32Exception exception) when (exception.NativeErrorCode == 1223)
        {
            _status.Text = "Installation was canceled at the Windows permission prompt.";
            _install.Enabled = true;
        }
        catch (Exception exception)
        {
            _status.Text = $"Setup could not start: {exception.Message}";
            _install.Enabled = true;
        }
        finally
        {
            try { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); } catch { }
        }
    }
}
