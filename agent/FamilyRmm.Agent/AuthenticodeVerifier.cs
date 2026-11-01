using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace FamilyRmm.Agent;

public enum AuthenticodeTrustStatus { Trusted, Invalid, Expired, Revoked, RevocationUnavailable }
public sealed record AuthenticodeSignerResult(AuthenticodeTrustStatus Status, string? Publisher, string? Detail = null);

public static class AuthenticodeVerifier
{
    private static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    private const uint WtdRevokeWholeChain = 1;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionVerify = 1;
    private const uint WtdStateActionClose = 2;
    private const uint WtdRevocationCheckChainExcludeRoot = 0x80;
    private const uint WtdDisableMd2Md4 = 0x2000;
    private const uint WssVerifySpecific = 1;
    private const uint WssGetSecondarySignatureCount = 2;
    private const int MaximumSignatures = 16;

    public static string VerifyPublisher(string filePath, string expectedPublisher)
    {
        if (!OperatingSystem.IsWindows())
        {
#if AGENT_TEST_HARNESS
            throw new CryptographicException($"No trusted package signer matched the approved publisher '{expectedPublisher}' (Authenticode verification is only available on Windows).");
#else
            throw new PlatformNotSupportedException("Authenticode verification requires Windows.");
#endif
        }
        if (string.IsNullOrWhiteSpace(expectedPublisher) || expectedPublisher.Length > 200)
            throw new CryptographicException("The signed deployment task has no valid expected publisher.");

        var verifiedSigners = VerifyAllFileSignatures(filePath);
        return SelectTrustedPublisher(verifiedSigners, expectedPublisher);
    }

    public static string SelectTrustedPublisher(IEnumerable<AuthenticodeSignerResult> signatures, string expectedPublisher)
    {
        var results = signatures.Take(MaximumSignatures + 1).ToArray();
        if (results.Length == 0 || results.Length > MaximumSignatures)
            throw new CryptographicException("The package has no signatures or has too many signatures to validate safely.");
        foreach (var signature in results)
        {
            if (signature.Status == AuthenticodeTrustStatus.Trusted &&
                string.Equals(signature.Publisher?.Trim(), expectedPublisher.Trim(), StringComparison.OrdinalIgnoreCase))
                return signature.Publisher!.Trim();
        }

        var failure = results.FirstOrDefault(signature => signature.Status is AuthenticodeTrustStatus.Revoked or AuthenticodeTrustStatus.RevocationUnavailable or AuthenticodeTrustStatus.Expired);
        if (failure is not null)
            throw new CryptographicException(failure.Detail ?? failure.Status switch
            {
                AuthenticodeTrustStatus.Revoked => "The package signing certificate or its chain has been revoked.",
                AuthenticodeTrustStatus.RevocationUnavailable => "Certificate revocation status could not be established.",
                AuthenticodeTrustStatus.Expired => "The package signature is expired and has no valid timestamp.",
                _ => "The package Authenticode signature is not trusted.",
            });
        var signer = results.FirstOrDefault(result => !string.IsNullOrWhiteSpace(result.Publisher))?.Publisher ?? "unknown";
        throw new CryptographicException($"No trusted package signer matched the approved publisher '{expectedPublisher}' (observed '{signer}').");
    }

    private static IReadOnlyList<AuthenticodeSignerResult> VerifyAllFileSignatures(string filePath)
    {
        var fullPath = Path.GetFullPath(filePath);
        var countSettings = new WinTrustSignatureSettings
        {
            StructSize = (uint)Marshal.SizeOf<WinTrustSignatureSettings>(),
            Flags = WssGetSecondarySignatureCount,
        };
        using var initial = new WinTrustCall(fullPath, countSettings);
        var firstResult = initial.Verify();
        var signatures = Math.Clamp((int)initial.SignatureSettings.SecondarySignatureCount + 1, 1, MaximumSignatures + 1);
        if (signatures > MaximumSignatures) throw new CryptographicException("The package contains too many Authenticode signatures.");

        var outcomes = new List<AuthenticodeSignerResult>(signatures);
        for (var index = 0; index < signatures; index++)
        {
            var settings = new WinTrustSignatureSettings
            {
                StructSize = (uint)Marshal.SizeOf<WinTrustSignatureSettings>(),
                Index = (uint)index,
                Flags = WssVerifySpecific,
            };
            using var call = new WinTrustCall(fullPath, settings);
            var result = call.Verify();
            if (result == 0 && call.SignatureSettings.VerifiedSignatureIndex != index)
                throw new CryptographicException("Windows validated a different package signature than the one requested.");
            var signer = result == 0 ? call.ReadValidatedSigner() : null;
            outcomes.Add(new AuthenticodeSignerResult(
                MapTrustStatus(result), signer,
                result == 0 ? null : TrustError(result)));
        }
        if (firstResult != 0 && outcomes.All(outcome => outcome.Status != AuthenticodeTrustStatus.Trusted))
            outcomes.Insert(0, new AuthenticodeSignerResult(MapTrustStatus(firstResult), null, TrustError(firstResult)));
        return outcomes;
    }

    private static AuthenticodeTrustStatus MapTrustStatus(uint status) => status switch
    {
        0 => AuthenticodeTrustStatus.Trusted,
        0x800B010C => AuthenticodeTrustStatus.Revoked, // CERT_E_REVOKED
        0x800B0101 => AuthenticodeTrustStatus.Expired, // CERT_E_EXPIRED
        0x80092012 or 0x80092013 or 0x800B010E => AuthenticodeTrustStatus.RevocationUnavailable,
        _ => AuthenticodeTrustStatus.Invalid,
    };

    private static string TrustError(uint status) => MapTrustStatus(status) switch
    {
        AuthenticodeTrustStatus.Revoked => "The package signing certificate or its chain has been revoked.",
        AuthenticodeTrustStatus.Expired => "The package signature is expired and has no valid timestamp.",
        AuthenticodeTrustStatus.RevocationUnavailable => "Certificate revocation status could not be established. Check network access and retry.",
        _ => $"The package Authenticode signature is missing or not trusted (0x{status:X8}).",
    };

    private sealed class WinTrustCall : IDisposable
    {
        private readonly WinTrustFileInfo _fileInfo;
        private readonly IntPtr _filePointer;
        private readonly IntPtr _settingsPointer;
        private readonly IntPtr _dataPointer;
        private Guid _action = GenericVerifyV2;
        private bool _verified;
        public WinTrustSignatureSettings SignatureSettings { get; private set; }

        public WinTrustCall(string path, WinTrustSignatureSettings settings)
        {
            SignatureSettings = settings;
            _fileInfo = new WinTrustFileInfo { StructSize = (uint)Marshal.SizeOf<WinTrustFileInfo>(), FilePath = Marshal.StringToCoTaskMemUni(path) };
            _filePointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
            _settingsPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustSignatureSettings>());
            _dataPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustData>());
            Marshal.StructureToPtr(_fileInfo, _filePointer, false);
            Marshal.StructureToPtr(settings, _settingsPointer, false);
            var data = new WinTrustData
            {
                StructSize = (uint)Marshal.SizeOf<WinTrustData>(),
                UiChoice = 2, // WTD_UI_NONE
                RevocationChecks = WtdRevokeWholeChain,
                UnionChoice = WtdChoiceFile,
                FileInfo = _filePointer,
                StateAction = WtdStateActionVerify,
                ProviderFlags = WtdRevocationCheckChainExcludeRoot | WtdDisableMd2Md4,
                SignatureSettings = _settingsPointer,
            };
            Marshal.StructureToPtr(data, _dataPointer, false);
        }

        public uint Verify()
        {
            var result = WinVerifyTrust(IntPtr.Zero, ref _action, _dataPointer);
            var data = Marshal.PtrToStructure<WinTrustData>(_dataPointer);
            SignatureSettings = Marshal.PtrToStructure<WinTrustSignatureSettings>(_settingsPointer);
            Marshal.StructureToPtr(data, _dataPointer, false);
            _verified = true;
            return result;
        }

        public string? ReadValidatedSigner()
        {
            var data = Marshal.PtrToStructure<WinTrustData>(_dataPointer);
            if (data.StateData == IntPtr.Zero) throw new CryptographicException("Windows did not return validated signature state.");
            var providerData = WTHelperProvDataFromStateData(data.StateData);
            if (providerData == IntPtr.Zero) throw new CryptographicException("Windows did not return the Authenticode provider state.");
            // A specific file signature was selected by WINTRUST_SIGNATURE_SETTINGS.Index.
            // Its provider state exposes that signature's primary signer at chain index 0;
            // VerifiedSignatureIndex is a file-signature index, not a signer-chain index.
            var signer = WTHelperGetProvSignerFromChain(providerData, 0, false, 0);
            if (signer == IntPtr.Zero) throw new CryptographicException("Windows did not return the validated package signer.");
            var signerData = Marshal.PtrToStructure<CryptProviderSigner>(signer);
            if (signerData.CertificateCount == 0 || signerData.CertificateChain == IntPtr.Zero)
                throw new CryptographicException("Windows returned an empty validated signer chain.");
            var providerCertificate = WTHelperGetProvCertFromChain(signer, 0);
            if (providerCertificate == IntPtr.Zero) throw new CryptographicException("Windows did not return the validated signer certificate.");
            var certificateData = Marshal.PtrToStructure<CryptProviderCertificate>(providerCertificate);
            if (certificateData.CertificateContext == IntPtr.Zero) throw new CryptographicException("Windows returned an empty signer certificate.");
            var certContext = Marshal.PtrToStructure<CertContext>(certificateData.CertificateContext);
            if (certContext.EncodedLength == 0 || certContext.EncodedLength > 1_000_000 || certContext.EncodedCertificate == IntPtr.Zero)
                throw new CryptographicException("Windows returned an invalid signer certificate.");
            var der = new byte[certContext.EncodedLength];
            Marshal.Copy(certContext.EncodedCertificate, der, 0, der.Length);
            using var certificate = X509CertificateLoader.LoadCertificate(der);
            return certificate.GetNameInfo(X509NameType.SimpleName, forIssuer: false);
        }

        public void Dispose()
        {
            if (_verified)
            {
                var data = Marshal.PtrToStructure<WinTrustData>(_dataPointer);
                data.StateAction = WtdStateActionClose;
                Marshal.StructureToPtr(data, _dataPointer, false);
                _ = WinVerifyTrust(IntPtr.Zero, ref _action, _dataPointer);
            }
            Marshal.DestroyStructure<WinTrustData>(_dataPointer);
            Marshal.FreeHGlobal(_dataPointer);
            Marshal.FreeHGlobal(_settingsPointer);
            Marshal.DestroyStructure<WinTrustFileInfo>(_filePointer);
            Marshal.FreeHGlobal(_filePointer);
            Marshal.FreeCoTaskMem(_fileInfo.FilePath);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo { public uint StructSize; public IntPtr FilePath; public IntPtr FileHandle; public IntPtr KnownSubject; }
    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustData
    {
        public uint StructSize; public IntPtr PolicyCallbackData; public IntPtr SipClientData; public uint UiChoice; public uint RevocationChecks;
        public uint UnionChoice; public IntPtr FileInfo; public uint StateAction; public IntPtr StateData; public IntPtr UrlReference;
        public uint ProviderFlags; public uint UiContext; public IntPtr SignatureSettings;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustSignatureSettings { public uint StructSize; public uint Index; public uint Flags; public uint SecondarySignatureCount; public uint VerifiedSignatureIndex; public IntPtr CryptoPolicy; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CryptProviderSigner { public uint StructSize; public long VerifyAsOf; public uint CertificateCount; public IntPtr CertificateChain; public uint SignerType; public IntPtr SignerInfo; public uint Error; public uint CounterSignerCount; public IntPtr CounterSigners; public IntPtr ChainContext; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CryptProviderCertificate { public uint StructSize; public IntPtr CertificateContext; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CertContext { public uint EncodingType; public IntPtr EncodedCertificate; public uint EncodedLength; public IntPtr CertInfo; public IntPtr Store; }

    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)] private static extern uint WinVerifyTrust(IntPtr windowHandle, [In] ref Guid actionId, IntPtr trustData);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperProvDataFromStateData(IntPtr stateData);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr providerData, uint signerIndex, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterSignerIndex);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint certificateIndex);
}
