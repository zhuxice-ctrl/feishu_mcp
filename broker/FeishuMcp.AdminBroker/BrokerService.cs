using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace FeishuMcp.AdminBroker;

/// <summary>
/// Named-pipe server loop for the administrator broker. Reads one
/// length-prefixed JSON request (capped at 64 KiB), validates it strictly,
/// executes the resolved operation, marks the plan applied, and writes one
/// length-prefixed JSON response. The pipe factory is injected so the Windows
/// host can apply a PipeSecurity ACL; the loop itself is platform-agnostic.
/// </summary>
public sealed class BrokerService
{
    private readonly BrokerCatalog _catalog;
    private readonly BrokerRequestValidator _validator;
    private readonly BrokerValidationContext _ctx;
    private readonly OperationExecutor _executor;
    private readonly Func<NamedPipeServerStream> _pipeFactory;
    private readonly SemaphoreSlim _single = new(1, 1);

    public BrokerService(
        BrokerCatalog catalog,
        BrokerValidationContext ctx,
        OperationExecutor executor,
        Func<NamedPipeServerStream> pipeFactory)
    {
        _catalog = catalog;
        _ctx = ctx;
        _executor = executor;
        _pipeFactory = pipeFactory;
        _validator = new BrokerRequestValidator();
    }

    public async Task<BrokerResponse> HandleAsync(byte[] requestBytes, CancellationToken ct = default)
    {
        BrokerRequest? req;
        try
        {
            req = JsonSerializer.Deserialize<BrokerRequest>(requestBytes, BrokerProtocol.JsonOptions);
            if (req is null) return Malformed("");
        }
        catch (JsonException ex)
        {
            return Malformed(ex.Message);
        }

        var result = _validator.Validate(req, _ctx);
        if (!result.Accepted)
            return new BrokerResponse
            {
                ProtocolVersion = BrokerProtocol.ProtocolVersion,
                RequestId = req.RequestId,
                Accepted = false,
                Error = result.Message,
            };

        var component = _catalog.Find(req.ComponentId);
        if (component is null)
            return new BrokerResponse
            {
                ProtocolVersion = BrokerProtocol.ProtocolVersion,
                RequestId = req.RequestId,
                Accepted = false,
                Error = BrokerError.UnknownComponent.ToString(),
            };

        await _single.WaitAsync(ct);
        try
        {
            _ctx.Replay.MarkPlanApplied(req.PlanId);
            var outcome = await _executor.ExecuteAsync(component, ct);
            return new BrokerResponse
            {
                ProtocolVersion = BrokerProtocol.ProtocolVersion,
                RequestId = req.RequestId,
                Accepted = outcome.ExitCode == 0,
                Stage = outcome.Stage,
                ExitCode = outcome.ExitCode,
                Message = outcome.Message,
            };
        }
        finally
        {
            _single.Release();
        }
    }

    /// <summary>Run the pipe loop until cancelled. One request per connection.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var pipe = _pipeFactory();
            await pipe.WaitForConnectionAsync(ct);
            var requestBytes = await ReadFrameAsync(pipe, ct);
            if (requestBytes is null) continue;
            var responseBytes = JsonSerializer.SerializeToUtf8Bytes(
                await HandleAsync(requestBytes, ct), BrokerProtocol.JsonOptions);
            await WriteFrameAsync(pipe, responseBytes, ct);
        }
    }

    internal static async Task<byte[]?> ReadFrameAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[4];
        if (!await ReadExactAsync(stream, header, ct)) return null;
        var len = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (len == 0 || len > BrokerProtocol.MaxRequestBytes) return null;
        var body = new byte[len];
        if (!await ReadExactAsync(stream, body, ct)) return null;
        return body;
    }

    internal static async Task WriteFrameAsync(Stream stream, byte[] body, CancellationToken ct)
    {
        var len = Math.Min(body.Length, BrokerProtocol.MaxResponseBytes);
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)len);
        await stream.WriteAsync(header.AsMemory(0, 4), ct);
        await stream.WriteAsync(body.AsMemory(0, len), ct);
        await stream.FlushAsync(ct);
    }

    private static async Task<bool> ReadExactAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(offset), ct);
            if (n == 0) return false;
            offset += n;
        }
        return true;
    }

    private static BrokerResponse Malformed(string message) => new()
    {
        ProtocolVersion = BrokerProtocol.ProtocolVersion,
        RequestId = "",
        Accepted = false,
        Error = BrokerError.MalformedRequest.ToString(),
        Message = string.IsNullOrEmpty(message) ? null : "malformed",
    };
}
