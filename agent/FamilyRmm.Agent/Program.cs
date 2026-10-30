using FamilyRmm.Agent;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging.Abstractions;

var optionsPath = Path.Combine(AppContext.BaseDirectory, "rmm-agent.json");
if (args.Contains("--self-check", StringComparer.Ordinal))
{
    var options = AgentOptions.Load(optionsPath);
    using var client = new HttpClient();
    await EnrollmentProtocol.ValidateGrantAsync(client, options, CancellationToken.None);
    Console.WriteLine($"Configuration valid for {options.ServerUrl} (grant expires {options.GrantExpiresAt:O}).");
    return;
}
#if AGENT_TEST_HARNESS
if (args.Contains("--checkin-once", StringComparer.Ordinal))
{
    var testDirectory = Environment.GetEnvironmentVariable("FAMILY_RMM_AGENT_TEST_STATE_DIRECTORY");
    if (string.IsNullOrWhiteSpace(testDirectory) || !Path.IsPathFullyQualified(testDirectory))
        throw new InvalidOperationException("The development agent check-in harness requires an isolated absolute state directory.");
    var testOptions = AgentOptions.Load(optionsPath);
    using var testClient = new HttpClient();
    using var testIdentity = new AgentIdentityStore(testDirectory, System.Security.Cryptography.DataProtectionScope.CurrentUser);
    var testWorker = new AgentWorker(NullLogger<AgentWorker>.Instance, testOptions, testIdentity, testClient);
    await testWorker.RunOnceAsync(CancellationToken.None);
    Console.WriteLine($"Device {testIdentity.Current.DeviceId} enrolled and reported hardware/software inventory.");
    return;
}
#endif

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(config => config.ServiceName = "Family RMM Agent");
builder.Services.AddSingleton(AgentOptions.Load(optionsPath));
builder.Services.AddSingleton<AgentIdentityStore>();
builder.Services.AddSingleton(_ => new HttpClient { Timeout = TimeSpan.FromSeconds(30) });
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();
