using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FamilyRmm.Agent;

public static class DeploymentProtocol
{
    private const long MaxInstallerBytes = 250L * 1024 * 1024;
    private const int MaxCapturedOutputBytes = 32 * 1024;
    private static readonly TimeSpan LeaseLength = TimeSpan.FromSeconds(180);

    public static async Task ProcessNextAsync(HttpClient client, AgentOptions options, AgentIdentityStore identities, ECDsa identityKey, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.TaskSigningPublicKey) || !identities.IsEnrolled) return;
        using var claimResponse = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post,
            $"{options.ServerUrl}/api/agent/deployments/claim", "{}"u8.ToArray(), identities.Current.DeviceId, identityKey, cancellationToken);
        if (claimResponse.StatusCode == HttpStatusCode.Forbidden) throw new HttpRequestException("The server denied deployment polling.", null, claimResponse.StatusCode);
        claimResponse.EnsureSuccessStatusCode();
        using var claim = await JsonDocument.ParseAsync(await claimResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        if (!claim.RootElement.TryGetProperty("task", out var task) || task.ValueKind == JsonValueKind.Null) return;

        JsonElement payload = default;
        string jobId = "", leaseId = "";
        string? output = null;
        int exitCode = -1;
        string? artifactPath = null;
        CancellationTokenSource? leaseLost = null;
        Task? renewTask = null;
        try
        {
            payload = task.GetProperty("payload");
            leaseId = payload.GetProperty("leaseId").GetString() ?? "";
            jobId = payload.GetProperty("jobId").GetString() ?? "";
            if (!System.Text.RegularExpressions.Regex.IsMatch(jobId, "^[a-f0-9]{32}$") || !System.Text.RegularExpressions.Regex.IsMatch(leaseId, "^[a-f0-9]{32}$"))
                throw new InvalidOperationException("The deployment task or lease identifier is invalid.");

            using var serverKey = ECDsa.Create();
            serverKey.ImportFromPem(options.TaskSigningPublicKey);
            var signatureText = task.GetProperty("signature").GetString() ?? "";
            if (!serverKey.VerifyData(EnrollmentProtocol.CanonicalJson(payload), EnrollmentProtocol.FromBase64Url(signatureText), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence))
                throw new CryptographicException("The deployment task signature is invalid.");
            var issuedAt = payload.GetProperty("issuedAt").GetDateTimeOffset();
            var expiresAt = payload.GetProperty("expiresAt").GetDateTimeOffset();
            if (issuedAt > DateTimeOffset.UtcNow.AddMinutes(2) || expiresAt <= DateTimeOffset.UtcNow || expiresAt - issuedAt > TimeSpan.FromMinutes(35))
                throw new InvalidOperationException("The deployment task is expired or outside its validity window.");
            var timeoutSeconds = Math.Clamp(payload.GetProperty("timeoutSeconds").GetInt32(), 30, 3600);
            var taskType = payload.GetProperty("packageType").GetString() ?? "";
            var packageName = payload.GetProperty("name").GetString() ?? "software package";
            var packageVersion = payload.GetProperty("version").GetString() ?? "";
            var packageId = payload.GetProperty("packageId").GetString() ?? "";
            var declaredHash = payload.GetProperty("sha256").GetString() ?? "";
            if (!System.Text.RegularExpressions.Regex.IsMatch(packageId, "^[a-f0-9]{32}$") || !System.Text.RegularExpressions.Regex.IsMatch(declaredHash, "^[a-f0-9]{64}$"))
                throw new InvalidOperationException("The deployment package identifier or hash is invalid.");

            await SendResult(client, options, identities, identityKey, new { jobId, leaseId, state = "running" }, cancellationToken);
            leaseLost = new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, leaseLost.Token);
            renewTask = RenewLease(client, options, identities, identityKey, jobId, leaseId, leaseLost, cancellationToken);
            var taskDirectory = Path.Combine(identities.DataDirectory, "Deployments");
            Directory.CreateDirectory(taskDirectory);
            var extension = taskType == "msi" ? ".msi" : taskType == "exe" ? ".exe" : taskType == "powershell" ? ".ps1" : "";
            if (extension.Length == 0) throw new InvalidOperationException("The signed deployment task type is unsupported.");
            artifactPath = Path.Combine(taskDirectory, $"{jobId}-{leaseId}{extension}");
            var processInfo = new ProcessStartInfo { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = taskDirectory };
            if (taskType is "msi" or "exe")
            {
                var expectedSize = payload.GetProperty("fileSize").GetInt64();
                if (expectedSize is <= 0 or > MaxInstallerBytes) throw new InvalidOperationException("The deployment package size is invalid.");
                using var downloadTimeout = CancellationTokenSource.CreateLinkedTokenSource(linked.Token);
                downloadTimeout.CancelAfter(TimeSpan.FromMinutes(10));
                using var download = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Get,
                    $"{options.ServerUrl}/api/agent/deployments/{jobId}/download?leaseId={leaseId}", Array.Empty<byte>(), identities.Current.DeviceId, identityKey, downloadTimeout.Token);
                if (download.StatusCode == HttpStatusCode.Forbidden) throw new HttpRequestException("The server denied the package download.", null, download.StatusCode);
                download.EnsureSuccessStatusCode();
                if (download.Content.Headers.ContentLength is long contentLength && contentLength != expectedSize) throw new CryptographicException("The package Content-Length differs from the signed task.");
                await using (var target = new FileStream(artifactPath + ".part", FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
                await using (var source = await download.Content.ReadAsStreamAsync(downloadTimeout.Token))
                    await CopyBoundedAsync(source, target, expectedSize, MaxInstallerBytes, downloadTimeout.Token);
                File.Move(artifactPath + ".part", artifactPath);
                await using var packageStream = new FileStream(artifactPath, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                var actualHash = Convert.ToHexString(await SHA256.HashDataAsync(packageStream, linked.Token)).ToLowerInvariant();
                if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actualHash), Encoding.ASCII.GetBytes(declaredHash))) throw new CryptographicException("The downloaded package hash does not match the signed task.");
                _ = AuthenticodeVerifier.VerifyPublisher(artifactPath, payload.GetProperty("publisher").GetString() ?? "");
                if (taskType == "msi")
                {
                    processInfo.FileName = Path.Combine(Environment.SystemDirectory, "msiexec.exe");
                    processInfo.ArgumentList.Add("/i"); processInfo.ArgumentList.Add(artifactPath); processInfo.ArgumentList.Add("/qn"); processInfo.ArgumentList.Add("/norestart");
                }
                else processInfo.FileName = artifactPath;
                foreach (var arg in payload.GetProperty("installArguments").EnumerateArray())
                {
                    var value = arg.GetString() ?? "";
                    if (value.Length > 500 || value.Contains('\0') || value.Contains('\r') || value.Contains('\n')) throw new InvalidOperationException("The installer arguments are invalid.");
                    processInfo.ArgumentList.Add(value);
                }
            }
            else
            {
                var script = payload.GetProperty("scriptBody").GetString() ?? "";
                if (Encoding.UTF8.GetByteCount(script) is <= 0 or > 32 * 1024) throw new InvalidOperationException("The signed PowerShell script size is invalid.");
                var actualHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(script))).ToLowerInvariant();
                if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actualHash), Encoding.ASCII.GetBytes(declaredHash))) throw new CryptographicException("The signed script hash is invalid.");
                await File.WriteAllTextAsync(artifactPath, script, new UTF8Encoding(false), linked.Token);
                processInfo.FileName = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                foreach (var arg in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", artifactPath }) processInfo.ArgumentList.Add(arg);
            }

            using var process = new Process { StartInfo = processInfo, EnableRaisingEvents = true };
            if (!process.Start()) throw new InvalidOperationException("Windows could not start the selected installer.");
            var stdoutTask = ReadLimitedAsync(process.StandardOutput, MaxCapturedOutputBytes, linked.Token);
            var stderrTask = ReadLimitedAsync(process.StandardError, MaxCapturedOutputBytes, linked.Token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(linked.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                throw;
            }
            var captured = await Task.WhenAll(stdoutTask, stderrTask);
            output = string.Join("\n", captured.Where(value => !string.IsNullOrWhiteSpace(value))).Trim();
            exitCode = process.ExitCode;
            if (!IsSuccessfulInstallerExitCode(exitCode)) throw new InvalidOperationException($"{packageName} {packageVersion} exited with code {exitCode}.");
            var rebootRequired = exitCode is 3010 or 1641;
            var rebootMessage = rebootRequired ? "Installation succeeded; Windows reports that a restart is required." : null;
            await SendResult(client, options, identities, identityKey, new { jobId, leaseId, state = "succeeded", exitCode, output, error = rebootMessage, rebootRequired, retryable = false }, cancellationToken);

            var catalogAppId = payload.TryGetProperty("catalogAppId", out var appId) ? appId.GetString() : null;
            var verificationState = "unavailable";
            string? installedVersion = null;
            var inventoryState = "succeeded";
            string? inventoryError = null;
            try
            {
                var installedSoftware = WindowsInventory.Software();
                (verificationState, installedVersion) = VerifyInstalledApplication(catalogAppId, packageName, installedSoftware);
                var inventoryBody = JsonSerializer.SerializeToUtf8Bytes(new { software = installedSoftware });
                using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/inventory", inventoryBody, identities.Current.DeviceId, identityKey, cancellationToken);
                response.EnsureSuccessStatusCode();
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            { inventoryState = "failed"; inventoryError = exception.Message; }
            try
            {
                await SendResultToInventory(client, options, identities, identityKey, new { jobId, leaseId, inventoryState, verificationState, installedVersion, error = inventoryError }, cancellationToken);
            }
            catch (Exception exception) { System.Diagnostics.Trace.TraceWarning("Deployment {0} succeeded, but inventory status could not be synchronized: {1}", jobId, exception.Message); }
            leaseLost.Cancel();
            await renewTask;
            renewTask = null;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            var message = exception.Message.Length > 2000 ? exception.Message[..2000] : exception.Message;
            if (jobId.Length == 32 && leaseId.Length == 32 && leaseLost?.IsCancellationRequested != true)
            {
                try { await SendResult(client, options, identities, identityKey, new { jobId, leaseId, state = "failed", exitCode, output, error = message, retryable = true }, cancellationToken); }
                catch (Exception reportError) { System.Diagnostics.Trace.TraceWarning("Deployment failure result was not synchronized: {0}", reportError.Message); }
            }
            else if (leaseLost?.IsCancellationRequested == true)
                System.Diagnostics.Trace.TraceWarning("Deployment {0} stopped after its lease could not be renewed; server recovery will mark its outcome unknown instead of retryable.", jobId);
        }
        finally
        {
            if (leaseLost is not null) leaseLost.Cancel();
            if (renewTask is not null) try { await renewTask; } catch { }
            leaseLost?.Dispose();
            if (artifactPath is not null)
            {
                try { File.Delete(artifactPath); } catch { }
                try { File.Delete(artifactPath + ".part"); } catch { }
            }
        }
    }

    public static bool IsSuccessfulInstallerExitCode(int code) => code is 0 or 3010 or 1641;

    public static (string State, string? Version) VerifyInstalledApplication(string? catalogAppId, string packageName, IReadOnlyList<SoftwareItem> inventory)
    {
        string[] terms = catalogAppId switch
        {
            "chrome" => ["Google Chrome"], "firefox" => ["Mozilla Firefox"], "7zip" => ["7-Zip"], "vlc" => ["VLC media player"],
            "acrobat-reader" => ["Adobe Acrobat", "Adobe Reader"], "zoom" => ["Zoom"], "teams" => ["Microsoft Teams", "MSTeams"],
            "notepad-plus-plus" => ["Notepad++"], _ => [packageName],
        };
        var item = inventory.FirstOrDefault(candidate => terms.Any(term => candidate.name.StartsWith(term, StringComparison.OrdinalIgnoreCase)));
        return item is null ? ("not_found", null) : ("verified", item.version);
    }

    public static async Task CopyBoundedAsync(Stream source, Stream destination, long expectedBytes, long maxBytes, CancellationToken cancellationToken)
    {
        if (expectedBytes <= 0 || expectedBytes > maxBytes) throw new InvalidDataException("The expected download size exceeds the permitted limit.");
        var buffer = new byte[64 * 1024];
        long total = 0;
        while (true)
        {
            var count = await source.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (count == 0) break;
            if (total + count > expectedBytes || total + count > maxBytes) throw new InvalidDataException("The downloaded package exceeded its signed size limit.");
            await destination.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
            total += count;
        }
        if (total != expectedBytes) throw new EndOfStreamException("The downloaded package ended before the signed size was received.");
    }

    private static async Task RenewLease(HttpClient client, AgentOptions options, AgentIdentityStore identities, ECDsa key, string jobId, string leaseId, CancellationTokenSource lost, CancellationToken stoppingToken)
    {
        try
        {
            while (!lost.IsCancellationRequested && !stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(45), lost.Token);
                var body = JsonSerializer.SerializeToUtf8Bytes(new { jobId, leaseId });
                using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/deployments/lease", body, identities.Current.DeviceId, key, lost.Token);
                if (response.StatusCode == HttpStatusCode.Conflict) { lost.Cancel(); return; }
                response.EnsureSuccessStatusCode();
            }
        }
        catch (OperationCanceledException) when (lost.IsCancellationRequested || stoppingToken.IsCancellationRequested) { }
        catch { lost.Cancel(); }
    }

    private static async Task SendResult(HttpClient client, AgentOptions options, AgentIdentityStore identities, ECDsa key, object result, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(result);
        using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/deployments/result", body, identities.Current.DeviceId, key, cancellationToken);
        response.EnsureSuccessStatusCode();
    }
    private static async Task SendResultToInventory(HttpClient client, AgentOptions options, AgentIdentityStore identities, ECDsa key, object result, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(result);
        using var response = await EnrollmentProtocol.SendSignedAsync(client, HttpMethod.Post, $"{options.ServerUrl}/api/agent/deployments/inventory-result", body, identities.Current.DeviceId, key, cancellationToken);
        response.EnsureSuccessStatusCode();
    }
    private static async Task<string> ReadLimitedAsync(StreamReader reader, int maxBytes, CancellationToken cancellationToken)
    {
        var buffer = new char[4096]; var result = new StringBuilder(); var written = 0;
        while (true)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken); if (count == 0) break;
            var allowed = Math.Min(count, Math.Max(0, maxBytes - written));
            if (allowed > 0) { result.Append(buffer, 0, allowed); written += Encoding.UTF8.GetByteCount(buffer.AsSpan(0, allowed)); }
        }
        return result.ToString();
    }
}
