using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using FeishuMcp.AdminBroker;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace FeishuMcp.AdminBroker.Host;

/// <summary>
/// Windows service entry point. The broker runs as a Windows Service under
/// LocalSystem. The named pipe is created with a PipeSecurity ACL granting
/// only the configured owner SID and LocalSystem. The 32-byte shared key is
/// read from an ACL-protected file written during installation. The service
/// serializes all operations with a single semaphore and reports only stage,
/// exit code, and a redacted message. It stops on catalog or signature
/// validation failure and never self-updates through the broker protocol.
/// </summary>
public static class Program
{
    public const string ServiceName = "FeishuMcpAdminBroker";
    public const string PipePrefix = "feishu-mcp-admin-";

    public static async Task Main(string[] args)
    {
        var catalog = BrokerCatalog.Load();

        // Build-time helper: print the embedded catalog digest and exit. Used
        // by the build script to populate the release manifest without loading
        // the library through reflection.
        if (args.Length > 0 && args[0] == "--catalog-digest")
        {
            Console.Out.WriteLine(catalog.CatalogDigest);
            return;
        }

        var keyPath = Environment.GetEnvironmentVariable("FEISHU_BROKER_KEY_PATH")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "FeishuMcp", "Broker", "broker.key");
        var ownerSid = Environment.GetEnvironmentVariable("FEISHU_BROKER_OWNER_SID") ?? "";
        var key = await ReadKeyAsync(keyPath);

        var ctx = new BrokerValidationContext
        {
            ProtocolVersion = BrokerProtocol.ProtocolVersion,
            CatalogDigest = catalog.CatalogDigest,
            OwnerSid = ownerSid,
            Key = key,
            Replay = new InMemoryReplayStore(),
        };
        var executor = new OperationExecutor();
        var pipeName = PipePrefix + SidHash(ownerSid);
        var service = new BrokerService(catalog, ctx, executor, () => CreatePipe(pipeName, ownerSid));

        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddWindowsService(o => o.ServiceName = ServiceName);
        builder.Services.AddHostedService(_ => new BrokerHostedService(service));
        await builder.Build().RunAsync();
    }

    internal static NamedPipeServerStream CreatePipe(string pipeName, string ownerSid)
    {
        var security = new PipeSecurity();
        // LocalSystem
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        // Configured owner only
        if (SecurityIdentifier.TryParse(ownerSid, out var sid))
        {
            security.AddAccessRule(new PipeAccessRule(
                sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        }
        return NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security);
    }

    internal static string SidHash(string sid)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(sid));
        return Convert.ToHexString(bytes, 0, 8).ToLowerInvariant();
    }

    internal static async Task<byte[]> ReadKeyAsync(string path)
    {
        return await File.ReadAllBytesAsync(path);
    }
}

internal sealed class BrokerHostedService : IHostedService
{
    private readonly BrokerService _service;
    private readonly CancellationTokenSource _cts = new();

    public BrokerHostedService(BrokerService service) => _service = service;

    public Task StartAsync(CancellationToken _) => Task.Run(() => _service.RunAsync(_cts.Token));

    public Task StopAsync(CancellationToken _)
    {
        _cts.Cancel();
        return Task.CompletedTask;
    }
}
