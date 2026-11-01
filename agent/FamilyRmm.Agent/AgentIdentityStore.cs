using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace FamilyRmm.Agent;

public sealed class AgentIdentityStore : IDisposable
{
    private readonly string _directory;
    private readonly DataProtectionScope _protectionScope;
    private ECDsa? _privateKey;
    public DeviceIdentity Current { get; private set; } = null!;
    public bool IsEnrolled { get; private set; }
    public string DataDirectory => _directory;

    public AgentIdentityStore() : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "FamilyRMM"), DataProtectionScope.LocalMachine) { }

    public AgentIdentityStore(string directory, DataProtectionScope protectionScope)
    {
        _directory = directory;
        _protectionScope = protectionScope;
    }

    public ECDsa OpenPrivateKey()
    {
        if (_privateKey is not null) return _privateKey;
        Directory.CreateDirectory(_directory);
        if (_protectionScope == DataProtectionScope.LocalMachine) ProtectDirectory(_directory);
        var path = Path.Combine(_directory, "device-identity.json");
        if (File.Exists(path))
        {
            var persisted = JsonSerializer.Deserialize<PersistedIdentity>(File.ReadAllBytes(path))
                ?? throw new CryptographicException("The protected device identity file is invalid.");
            var persistedProtectedBytes = Convert.FromBase64String(persisted.ProtectedPrivateKey);
            var privateBytes = UnprotectPrivateKey(persistedProtectedBytes);
            _privateKey = ECDsa.Create();
            _privateKey.ImportPkcs8PrivateKey(privateBytes, out _);
            CryptographicOperations.ZeroMemory(privateBytes);
            Current = new DeviceIdentity(persisted.DeviceId, _privateKey.ExportSubjectPublicKeyInfoPem(), persisted.ProtectedPrivateKey);
            IsEnrolled = persisted.IsEnrolled;
            return _privateKey;
        }

        _privateKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var encoded = _privateKey.ExportPkcs8PrivateKey();
        var protectedBytes = ProtectPrivateKey(encoded);
        CryptographicOperations.ZeroMemory(encoded);
        var protectedText = Convert.ToBase64String(protectedBytes);
        var state = new PersistedIdentity(Guid.NewGuid().ToString("N"), protectedText, false);
        var temporaryPath = path + ".tmp";
        File.WriteAllBytes(temporaryPath, JsonSerializer.SerializeToUtf8Bytes(state));
        File.Move(temporaryPath, path, true);
        Current = new DeviceIdentity(state.DeviceId, _privateKey.ExportSubjectPublicKeyInfoPem(), protectedText);
        return _privateKey;
    }

    public void MarkEnrolled()
    {
        if (IsEnrolled) return;
        WriteEnrollmentState(true);
    }

    public void MarkEnrollmentPending()
    {
        if (!IsEnrolled) return;
        WriteEnrollmentState(false);
    }

    private void WriteEnrollmentState(bool enrolled)
    {
        var path = Path.Combine(_directory, "device-identity.json");
        var state = new PersistedIdentity(Current.DeviceId, Current.EncryptedPrivateKey, enrolled);
        var temporaryPath = path + ".tmp";
        File.WriteAllBytes(temporaryPath, JsonSerializer.SerializeToUtf8Bytes(state));
        File.Move(temporaryPath, path, true);
        IsEnrolled = enrolled;
    }

    public void Dispose()
    {
        _privateKey?.Dispose();
        _privateKey = null;
    }

    private sealed record PersistedIdentity(string DeviceId, string ProtectedPrivateKey, bool IsEnrolled);

    private byte[] ProtectPrivateKey(byte[] privateBytes)
    {
#if AGENT_TEST_HARNESS
        if (!OperatingSystem.IsWindows()) return ProtectForPortableTestHarness(privateBytes);
#endif
        return ProtectedData.Protect(privateBytes, null, _protectionScope);
    }

    private byte[] UnprotectPrivateKey(byte[] protectedBytes)
    {
#if AGENT_TEST_HARNESS
        if (!OperatingSystem.IsWindows()) return UnprotectForPortableTestHarness(protectedBytes);
#endif
        return ProtectedData.Unprotect(protectedBytes, null, _protectionScope);
    }

#if AGENT_TEST_HARNESS
    private static byte[] ProtectForPortableTestHarness(byte[] privateBytes)
    {
        var key = ReadPortableTestProtectionKey();
        try
        {
            const int versionAndNonceLength = 1 + 12;
            const int tagLength = 16;
            var envelope = new byte[versionAndNonceLength + tagLength + privateBytes.Length];
            envelope[0] = 1;
            var nonce = envelope.AsSpan(1, 12);
            RandomNumberGenerator.Fill(nonce);
            using var aes = new AesGcm(key, tagLength);
            aes.Encrypt(nonce, privateBytes, envelope.AsSpan(versionAndNonceLength + tagLength), envelope.AsSpan(versionAndNonceLength, tagLength));
            return envelope;
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    private static byte[] UnprotectForPortableTestHarness(byte[] envelope)
    {
        const int versionAndNonceLength = 1 + 12;
        const int tagLength = 16;
        if (envelope.Length <= versionAndNonceLength + tagLength || envelope[0] != 1)
            throw new CryptographicException("The portable test identity envelope is invalid.");
        var key = ReadPortableTestProtectionKey();
        try
        {
            var privateBytes = new byte[envelope.Length - versionAndNonceLength - tagLength];
            using var aes = new AesGcm(key, tagLength);
            aes.Decrypt(envelope.AsSpan(1, 12), envelope.AsSpan(versionAndNonceLength + tagLength), envelope.AsSpan(versionAndNonceLength, tagLength), privateBytes);
            return privateBytes;
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    private static byte[] ReadPortableTestProtectionKey()
    {
        try
        {
            var key = Convert.FromBase64String(Environment.GetEnvironmentVariable("FAMILY_RMM_AGENT_TEST_PROTECTION_KEY") ?? "");
            if (key.Length == 32) return key;
            CryptographicOperations.ZeroMemory(key);
        }
        catch (FormatException) { }
        throw new CryptographicException("The portable test harness requires a 256-bit identity protection key.");
    }
#endif

    private static void ProtectDirectory(string path)
    {
        const string securityDescriptor = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(securityDescriptor, 1, out var descriptor, out _))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not create the protected device-data permissions.");
        try
        {
            const uint daclAndProtected = 0x00000004 | 0x80000000;
            if (!SetFileSecurity(path, daclAndProtected, descriptor))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not protect the device identity directory.");
        }
        finally { LocalFree(descriptor); }
    }

    [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string stringSecurityDescriptor, uint revision, out IntPtr securityDescriptor, out uint securityDescriptorSize);

    [DllImport("advapi32.dll", EntryPoint = "SetFileSecurityW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileSecurity(string fileName, uint securityInformation, IntPtr securityDescriptor);

    [DllImport("kernel32.dll", EntryPoint = "LocalFree")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
