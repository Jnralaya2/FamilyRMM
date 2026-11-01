using FamilyRmm.Agent;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging.Abstractions;

var optionsPath = Path.Combine(AppContext.BaseDirectory, "rmm-agent.json");
#if AGENT_TEST_HARNESS
if (args.Contains("--deployment-logic-self-test", StringComparer.Ordinal))
{
    static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    Check(DeploymentProtocol.IsSuccessfulInstallerExitCode(0), "exit code 0 should succeed");
    Check(DeploymentProtocol.IsSuccessfulInstallerExitCode(3010), "exit code 3010 should succeed with reboot required");
    Check(DeploymentProtocol.IsSuccessfulInstallerExitCode(1641), "exit code 1641 should succeed with reboot initiated");
    Check(!DeploymentProtocol.IsSuccessfulInstallerExitCode(1603), "ordinary installer failures must fail");
    foreach (var (id, name) in new[] { ("chrome", "Google Chrome"), ("firefox", "Mozilla Firefox"), ("7zip", "7-Zip"), ("vlc", "VLC media player"), ("acrobat-reader", "Adobe Acrobat Reader"), ("zoom", "Zoom Workplace"), ("teams", "Microsoft Teams"), ("notepad-plus-plus", "Notepad++") })
        Check(DeploymentProtocol.VerifyInstalledApplication(id, name, [new SoftwareItem(name, "123.4", "Test publisher", null)]).Version == "123.4", $"catalog identity/version for {id} should be recognized");
    Check(DeploymentProtocol.VerifyInstalledApplication("teams", "Microsoft Teams", []).State == "not_found", "Teams MSIX absence must be reported separately");
    _ = AuthenticodeVerifier.SelectTrustedPublisher([new(AuthenticodeTrustStatus.Trusted, "Google LLC")], "Google LLC");
    foreach (var state in new[] { AuthenticodeTrustStatus.Revoked, AuthenticodeTrustStatus.Expired, AuthenticodeTrustStatus.RevocationUnavailable })
    {
        try { AuthenticodeVerifier.SelectTrustedPublisher([new(state, "Google LLC")], "Google LLC"); throw new InvalidOperationException($"{state} must fail closed"); }
        catch (System.Security.Cryptography.CryptographicException) { }
    }
    try { AuthenticodeVerifier.SelectTrustedPublisher([new(AuthenticodeTrustStatus.Trusted, "Other Publisher")], "Google LLC"); throw new InvalidOperationException("publisher mismatch must fail"); }
    catch (System.Security.Cryptography.CryptographicException) { }
    Check(AuthenticodeVerifier.SelectTrustedPublisher([new(AuthenticodeTrustStatus.Invalid, "Other"), new(AuthenticodeTrustStatus.Trusted, "Google LLC")], "Google LLC") == "Google LLC", "one of several signatures may be accepted only when the expected signer is trusted");
    using var input = new MemoryStream(new byte[] { 1, 2, 3 });
    using var output = new MemoryStream();
    try { await DeploymentProtocol.CopyBoundedAsync(input, output, 2, 10, CancellationToken.None); throw new InvalidOperationException("oversized transfer must fail"); }
    catch (InvalidDataException) { }
    using var shortInput = new MemoryStream(new byte[] { 1 });
    try { await DeploymentProtocol.CopyBoundedAsync(shortInput, new MemoryStream(), 2, 10, CancellationToken.None); throw new InvalidOperationException("interrupted transfer must fail"); }
    catch (EndOfStreamException) { }
    Console.WriteLine("Deployment logic checks passed.");
    return;
}
#endif
if (args.Contains("--self-check", StringComparer.Ordinal))
{
    var options = AgentOptions.Load(optionsPath);
    using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
    await EnrollmentProtocol.ValidateGrantAsync(client, options, CancellationToken.None);
    Console.WriteLine(options.HasEnrollmentGrant
        ? $"Configuration valid for {options.ServerUrl} (grant expires {options.GrantExpiresAt:O})."
        : $"Configuration valid for {options.ServerUrl} (administrator approval is required for enrollment).");
    return;
}
#if AGENT_TEST_HARNESS
if (args.Contains("--enrollment-request-once", StringComparer.Ordinal))
{
    var testDirectory = Environment.GetEnvironmentVariable("FAMILY_RMM_AGENT_TEST_STATE_DIRECTORY");
    if (string.IsNullOrWhiteSpace(testDirectory) || !Path.IsPathFullyQualified(testDirectory))
        throw new InvalidOperationException("The development enrollment harness requires an isolated absolute state directory.");
    var testOptions = AgentOptions.Load(optionsPath);
    using var testClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
    using var testIdentity = new AgentIdentityStore(testDirectory, System.Security.Cryptography.DataProtectionScope.CurrentUser);
    var identityKey = testIdentity.OpenPrivateKey();
    var serverKey = await EnrollmentProtocol.ValidateGrantAsync(testClient, testOptions, CancellationToken.None);
    var result = await EnrollmentProtocol.EnrollAsync(testClient, testOptions, testIdentity, serverKey, CancellationToken.None);
    Console.WriteLine($"Device {testIdentity.Current.DeviceId} requested enrollment ({result.Status}).");
    return;
}
if (args.Contains("--checkin-once", StringComparer.Ordinal))
{
    var testDirectory = Environment.GetEnvironmentVariable("FAMILY_RMM_AGENT_TEST_STATE_DIRECTORY");
    if (string.IsNullOrWhiteSpace(testDirectory) || !Path.IsPathFullyQualified(testDirectory))
        throw new InvalidOperationException("The development agent check-in harness requires an isolated absolute state directory.");
    var testOptions = AgentOptions.Load(optionsPath);
    using var testClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
    using var testIdentity = new AgentIdentityStore(testDirectory, System.Security.Cryptography.DataProtectionScope.CurrentUser);
    var testWorker = new AgentWorker(NullLogger<AgentWorker>.Instance, testOptions, testIdentity, testClient);
    await testWorker.RunOnceAsync(CancellationToken.None);
    Console.WriteLine($"Device {testIdentity.Current.DeviceId} enrolled and reported hardware/software inventory.");
    return;
}
if (args.Contains("--reconcile-enrollment-once", StringComparer.Ordinal))
{
    var testDirectory = Environment.GetEnvironmentVariable("FAMILY_RMM_AGENT_TEST_STATE_DIRECTORY");
    if (string.IsNullOrWhiteSpace(testDirectory) || !Path.IsPathFullyQualified(testDirectory))
        throw new InvalidOperationException("The development enrollment harness requires an isolated absolute state directory.");
    var testOptions = AgentOptions.Load(optionsPath);
    using var testClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
    using var testIdentity = new AgentIdentityStore(testDirectory, System.Security.Cryptography.DataProtectionScope.CurrentUser);
    var testWorker = new AgentWorker(NullLogger<AgentWorker>.Instance, testOptions, testIdentity, testClient);
    var approved = await testWorker.ReconcileEnrollmentOnceAsync(CancellationToken.None);
    Console.WriteLine($"Device {testIdentity.Current.DeviceId} enrollment is {(approved ? "approved" : "pending approval")}.");
    return;
}
if (args.Contains("--deployment-once", StringComparer.Ordinal))
{
    var testDirectory = Environment.GetEnvironmentVariable("FAMILY_RMM_AGENT_TEST_STATE_DIRECTORY");
    if (string.IsNullOrWhiteSpace(testDirectory) || !Path.IsPathFullyQualified(testDirectory))
        throw new InvalidOperationException("The development deployment harness requires an isolated absolute state directory.");
    var testOptions = AgentOptions.Load(optionsPath);
    using var testClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
    using var testIdentity = new AgentIdentityStore(testDirectory, System.Security.Cryptography.DataProtectionScope.CurrentUser);
    var identityKey = testIdentity.OpenPrivateKey();
    if (!testIdentity.IsEnrolled) throw new InvalidOperationException("The deployment harness requires a device that has already enrolled.");
    await DeploymentProtocol.ProcessNextAsync(testClient, testOptions, testIdentity, identityKey, CancellationToken.None);
    Console.WriteLine($"Device {testIdentity.Current.DeviceId} checked and processed one authorized deployment task.");
    return;
}
#endif

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(config => config.ServiceName = "Family RMM Agent");
builder.Services.AddSingleton(AgentOptions.Load(optionsPath));
builder.Services.AddSingleton<AgentIdentityStore>();
builder.Services.AddSingleton(_ => new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) });
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();
