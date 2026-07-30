using System.Diagnostics;
using System.Security.Cryptography;

namespace FeishuMcp.AdminBroker;

/// <summary>
/// Executes a single reviewed catalog operation. No public method accepts a
/// raw executable, URL, shell, registry path, or argument list: every process
/// start is reconstructed from the typed catalog record with
/// <see cref="ProcessStartInfo.UseShellExecute"/> set to false.
/// </summary>
public sealed class OperationExecutor
{
    /// <summary>
    /// Build a fixed, reviewed process start for a catalog component. The
    /// executable and arguments are derived solely from the catalog install
    /// descriptor; a caller cannot influence them.
    /// </summary>
    public ProcessStartInfo BuildStartInfo(CatalogComponent component)
    {
        var op = component.Install;
        return op.Kind switch
        {
            "winget" => Fixed("winget.exe", "install", "--id", op.PackageId ?? "",
                "--source", op.Source ?? "winget",
                "--silent", "--accept-package-agreements", "--accept-source-agreements",
                "--disable-interactivity"),
            "vs_workload" => Fixed(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Microsoft Visual Studio", "Installer", "setup.exe"),
                "modify", "--installPath", ResolveVsInstallPath(),
                "--add", op.WorkloadId ?? "", "--quiet", "--norestart"),
            "android_sdk" => Fixed("sdkmanager.bat", op.PackageId ?? ""),
            "verified_archive" => throw new InvalidOperationException(
                "verified_archive is downloaded and verified by the Node worker; the broker does not fetch URLs"),
            _ => throw new InvalidOperationException($"unsupported operation kind: {op.Kind}"),
        };

        static ProcessStartInfo Fixed(string fileName, params string[] args)
        {
            var psi = new ProcessStartInfo(fileName)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            return psi;
        }
    }

    public async Task<OperationOutcome> ExecuteAsync(CatalogComponent component, CancellationToken ct = default)
    {
        var psi = BuildStartInfo(component);
        using var proc = new Process { StartInfo = psi };
        if (!proc.Start())
            return new OperationOutcome(ExitCode: -1, Stage: "start", Message: "failed to start");
        await proc.WaitForExitAsync(ct);
        return new OperationOutcome(ExitCode: proc.ExitCode, Stage: "completed", Message: Redact(proc));
    }

    private static string ResolveVsInstallPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Microsoft Visual Studio", "2022", "BuildTools");

    private static string Redact(Process proc)
    {
        // Report only a coarse stage; never echo args, paths, or output that
        // could contain identifiers.
        return proc.ExitCode == 0 ? "ok" : "failed";
    }
}

public sealed record OperationOutcome(int ExitCode, string Stage, string Message);
