using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

// The "Unkillable" layer. Registered as a generic Windows service (UpdateService).
// Every 15 s it restarts the main Family RMM Agent if it has died. Every 5 min it
// re-creates the HKCU Run key and the shell:startup shortcut, so even if a user
// deletes them, they reappear. On boot it also re-runs the MSI if the agent
// binary itself has been deleted (self-reinstall).
var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(config => config.ServiceName = "UpdateService");
builder.Services.AddHostedService<GuardWorker>();
await builder.Build().RunAsync();
return 0;

sealed class GuardWorker : BackgroundService
{
    private const string AgentService = "FamilyRMM-Agent";
    private const string MsiPath = @"%ProgramFiles%\FamilyRMM\FamilyRmmAgent.msi";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            EnsureRunKeys();
            EnsureStartupShortcut();
            if (!IsAgentRunning())
            {
                StartAgent();
                EnsureSelfReinstall();
            }
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
        }
    }

    private static bool IsAgentRunning()
    {
        return System.ServiceProcess.ServiceController.GetServices()
            .Any(s => s.ServiceName == AgentService && s.Status == System.ServiceProcess.ServiceControllerStatus.Running);
    }

    private static void StartAgent()
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("net", $"start {AgentService}") { UseShellExecute = false, CreateNoWindow = true };
            System.Diagnostics.Process.Start(psi)?.WaitForExit(5000);
        }
        catch { /* already starting */ }
    }

    private static void EnsureRunKeys()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true) ??
            Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        var exe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "FamilyRMM-Agent", "FamilyRmm.Agent.exe"));
        key.SetValue("FamilyRmmAgent", $"\"{exe}\"", Microsoft.Win32.RegistryValueKind.String);
    }

    private static void EnsureStartupShortcut()
    {
        try
        {
            var exe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "FamilyRMM-Agent", "FamilyRmm.Agent.exe"));
            File.WriteAllText(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "FamilyRMM.bat"), $"start \"\" \"{exe}\"\n");
        }
        catch { /* Run key is enough */ }
    }

    private static void EnsureSelfReinstall()
    {
        var msi = Path.GetFullPath(MsiPath.Replace("%ProgramFiles%", Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)));
        if (File.Exists(msi))
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("msiexec", $"/i \"{msi}\" /passive") { UseShellExecute = false, CreateNoWindow = true };
                System.Diagnostics.Process.Start(psi)?.WaitForExit(30000);
            }
            catch { /* already running */ }
        }
    }
}