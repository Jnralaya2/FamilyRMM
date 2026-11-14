#if WINDOWS
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FamilyRmm.Agent;

internal static class AgentServiceRecovery
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceChangeConfig = 0x0002;
    private const uint ServiceConfigFailureActions = 2;
    private const uint ScActionRestart = 1;

    // Configure Windows Service Control Manager recovery. A process crash or
    // unexpected exit is restarted automatically without displaying UI.
    public static void Configure()
    {
        IntPtr manager = IntPtr.Zero;
        IntPtr service = IntPtr.Zero;
        IntPtr actions = IntPtr.Zero;
        IntPtr config = IntPtr.Zero;
        try
        {
            manager = OpenSCManager(null, null, ScManagerConnect);
            if (manager == IntPtr.Zero) return;
            service = OpenService(manager, "FamilyRmmAgent", ServiceChangeConfig);
            if (service == IntPtr.Zero) return;

            var recoveryActions = new[]
            {
                new ScAction { Type = ScActionRestart, Delay = 5_000 },
                new ScAction { Type = ScActionRestart, Delay = 15_000 },
                new ScAction { Type = ScActionRestart, Delay = 60_000 },
            };
            var actionSize = Marshal.SizeOf<ScAction>();
            actions = Marshal.AllocHGlobal(actionSize * recoveryActions.Length);
            for (var i = 0; i < recoveryActions.Length; i++)
                Marshal.StructureToPtr(recoveryActions[i], IntPtr.Add(actions, i * actionSize), false);

            config = Marshal.AllocHGlobal(Marshal.SizeOf<FailureActions>());
            Marshal.StructureToPtr(new FailureActions
            {
                ResetPeriodSeconds = 86_400,
                ActionCount = (uint)recoveryActions.Length,
                Actions = actions,
            }, config, false);
            _ = ChangeServiceConfig2(service, ServiceConfigFailureActions, config);
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException or Win32Exception or InvalidOperationException)
        {
            // Recovery configuration is best effort; never prevent the agent
            // from starting if the host policy disallows changing service config.
        }
        finally
        {
            if (config != IntPtr.Zero) Marshal.FreeHGlobal(config);
            if (actions != IntPtr.Zero) Marshal.FreeHGlobal(actions);
            if (service != IntPtr.Zero) _ = CloseServiceHandle(service);
            if (manager != IntPtr.Zero) _ = CloseServiceHandle(manager);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ScAction { public uint Type; public uint Delay; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FailureActions
    {
        public uint ResetPeriodSeconds;
        public IntPtr RebootMessage;
        public IntPtr Command;
        public uint ActionCount;
        public IntPtr Actions;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManager(string? machineName, string? databaseName, uint desiredAccess);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenService(IntPtr manager, string serviceName, uint desiredAccess);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig2(IntPtr service, uint infoLevel, IntPtr info);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);
}
#endif
