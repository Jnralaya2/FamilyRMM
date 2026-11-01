using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace FamilyRmm.Agent;

public sealed record SoftwareItem(string name, string? version, string? publisher, string? installedAt);

public static class WindowsInventory
{
    public static object Hardware(string agentVersion) => new
    {
        name = Environment.MachineName,
        operatingSystem = "Windows",
        osVersion = Environment.OSVersion.Version.ToString(),
        architecture = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
        manufacturer = ReadBios("SystemManufacturer"),
        model = ReadBios("SystemProductName"),
        cpu = ReadCpu(),
        cpuCores = Environment.ProcessorCount,
        totalMemoryMB = TotalMemoryMb(),
        ipAddresses = IpAddresses(),
        agentVersion,
    };

    public static IReadOnlyList<SoftwareItem> Software()
    {
        var items = new Dictionary<string, SoftwareItem>(StringComparer.OrdinalIgnoreCase);
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var uninstall = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
                if (uninstall is null) continue;
                foreach (var name in uninstall.GetSubKeyNames())
                {
                    try
                    {
                        using var app = uninstall.OpenSubKey(name);
                        var displayName = app?.GetValue("DisplayName") as string;
                        if (string.IsNullOrWhiteSpace(displayName) || displayName.Length > 300) continue;
                        var version = Limit(app?.GetValue("DisplayVersion") as string, 120);
                        var publisher = Limit(app?.GetValue("Publisher") as string, 200);
                        var dateText = app?.GetValue("InstallDate") as string;
                        var installedAt = DateTime.TryParseExact(dateText, "yyyyMMdd", null, System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
                            ? parsed.ToUniversalTime().ToString("O") : null;
                        items[$"{displayName}|{version}"] = new SoftwareItem(displayName.Trim(), version, publisher, installedAt);
                    }
                    catch (System.Security.SecurityException) { }
                    catch (IOException) { }
                }
            }
            catch (System.Security.SecurityException) { }
            catch (IOException) { }
        }
        // Teams is delivered as an MSIX app and is not consistently registered
        // in the classic Uninstall registry. AppxAllUserStore exposes the
        // provisioned/all-user package identity to the LocalSystem service.
        try
        {
            using var appx = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Applications");
            foreach (var packageName in appx?.GetSubKeyNames() ?? [])
            {
                if (!packageName.StartsWith("MSTeams_", StringComparison.OrdinalIgnoreCase)) continue;
                var version = packageName.Split('_').ElementAtOrDefault(1);
                if (string.IsNullOrWhiteSpace(version)) continue;
                items[$"Microsoft Teams|{version}"] = new SoftwareItem("Microsoft Teams", Limit(version, 120), "Microsoft Corporation", null);
            }
        }
        catch (System.Security.SecurityException) { }
        catch (IOException) { }
        return items.Values.OrderBy(app => app.name, StringComparer.OrdinalIgnoreCase).Take(10_000).ToArray();
    }

    private static string? ReadBios(string valueName)
    {
        try { using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\BIOS"); return Limit(key?.GetValue(valueName) as string, 200); }
        catch { return null; }
    }
    private static string? ReadCpu()
    {
        try { using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0"); return Limit(key?.GetValue("ProcessorNameString") as string, 300); }
        catch { return null; }
    }
    private static int? TotalMemoryMb()
    {
        try { return GetPhysicallyInstalledSystemMemory(out var kilobytes) && kilobytes > 0 ? checked((int)Math.Min(kilobytes / 1024, int.MaxValue)) : null; }
        catch { return null; }
    }
    private static string[] IpAddresses()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces().Where(adapter => adapter.OperationalStatus == OperationalStatus.Up)
                .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
                .Select(info => info.Address).Where(address => !IPAddress.IsLoopback(address) && address.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
                .Select(address => address.ToString()).Distinct(StringComparer.Ordinal).Take(32).ToArray();
        }
        catch { return []; }
    }
    private static string? Limit(string? value, int max) => string.IsNullOrWhiteSpace(value) ? null : value.Trim()[..Math.Min(value.Trim().Length, max)];

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetPhysicallyInstalledSystemMemory(out ulong totalMemoryInKilobytes);
}
