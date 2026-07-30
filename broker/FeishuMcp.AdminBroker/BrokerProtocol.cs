using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FeishuMcp.AdminBroker;

/// <summary>
/// Strict broker request. Exactly these fields are accepted; any extra JSON
/// property (an executable path, a URL, free-form arguments) is rejected at
/// deserialization time. No caller may supply a raw executable, URL, shell,
/// registry path, or argument list.
/// </summary>
public sealed class BrokerRequest
{
    [JsonPropertyName("protocolVersion")] public int ProtocolVersion { get; set; }
    [JsonPropertyName("requestId")] public string RequestId { get; set; } = "";
    [JsonPropertyName("planId")] public string PlanId { get; set; } = "";
    [JsonPropertyName("operationId")] public string OperationId { get; set; } = "";
    [JsonPropertyName("componentId")] public string ComponentId { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("catalogDigest")] public string CatalogDigest { get; set; } = "";
    [JsonPropertyName("ownerSid")] public string OwnerSid { get; set; } = "";
    [JsonPropertyName("timestamp")] public long Timestamp { get; set; }
    [JsonPropertyName("nonce")] public string Nonce { get; set; } = "";
    [JsonPropertyName("hmac")] public string Hmac { get; set; } = "";
}

public sealed class BrokerResponse
{
    [JsonPropertyName("protocolVersion")] public int ProtocolVersion { get; set; }
    [JsonPropertyName("requestId")] public string RequestId { get; set; } = "";
    [JsonPropertyName("accepted")] public bool Accepted { get; set; }
    [JsonPropertyName("stage")] public string? Stage { get; set; }
    [JsonPropertyName("exitCode")] public int? ExitCode { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

public enum BrokerError
{
    None,
    MalformedRequest,
    ProtocolMismatch,
    CatalogMismatch,
    UnsupportedOperation,
    UnknownComponent,
    InvalidHmac,
    StaleTimestamp,
    ReusedNonce,
    AlreadyApplied,
    ForbiddenOwner,
}

public enum OperationKind
{
    Winget,
    VsWorkload,
    AndroidSdk,
    VerifiedArchive,
}

public sealed class BrokerValidationResult
{
    public bool Accepted { get; init; }
    public BrokerError Error { get; init; }
    public OperationKind? Operation { get; init; }
    public string Message => Error.ToString();
}

public interface IReplayStore
{
    /// <summary>Consume a nonce; returns false if it was already seen.</summary>
    bool TryConsumeNonce(string nonce);
    bool IsPlanApplied(string planId);
    void MarkPlanApplied(string planId);
}

public sealed class InMemoryReplayStore : IReplayStore
{
    private readonly HashSet<string> _nonces = new();
    private readonly HashSet<string> _plans = new();
    private readonly object _gate = new();

    public bool TryConsumeNonce(string nonce)
    {
        lock (_gate) { return _nonces.Add(nonce); }
    }

    public bool IsPlanApplied(string planId)
    {
        lock (_gate) { return _plans.Contains(planId); }
    }

    public void MarkPlanApplied(string planId)
    {
        lock (_gate) { _plans.Add(planId); }
    }
}

public sealed class BrokerValidationContext
{
    public required int ProtocolVersion { get; init; } = 1;
    public required string CatalogDigest { get; init; }
    public required string OwnerSid { get; init; }
    public required byte[] Key { get; init; }
    public required IReplayStore Replay { get; init; }
    public Func<DateTimeOffset> Clock { get; init; } = static () => DateTimeOffset.UtcNow;
    public int MaxSkewSeconds { get; init; } = 120;
}

/// <summary>
/// Stateless HMAC + canonicalization helpers. The canonical form is the
/// signed fields in fixed order, newline-separated, excluding the hmac field.
/// </summary>
public static class BrokerHmac
{
    public static string Canonical(BrokerRequest r) =>
        $"{r.ProtocolVersion}\n{r.RequestId}\n{r.PlanId}\n{r.OperationId}\n" +
        $"{r.ComponentId}\n{r.Version}\n{r.CatalogDigest}\n{r.OwnerSid}\n" +
        $"{r.Timestamp}\n{r.Nonce}";

    public static byte[] ComputeHash(byte[] key, BrokerRequest r)
    {
        using var hmac = new HMACSHA256(key);
        return hmac.ComputeHash(Encoding.UTF8.GetBytes(Canonical(r)));
    }

    public static string ComputeHex(byte[] key, BrokerRequest r) =>
        Convert.ToHexString(ComputeHash(key, r)).ToLowerInvariant();
}

public sealed class BrokerRequestValidator
{
    private static readonly Dictionary<string, OperationKind> Operations = new()
    {
        ["winget"] = OperationKind.Winget,
        ["vs_workload"] = OperationKind.VsWorkload,
        ["android_sdk"] = OperationKind.AndroidSdk,
        ["verified_archive"] = OperationKind.VerifiedArchive,
    };

    public BrokerValidationResult Validate(BrokerRequest req, BrokerValidationContext ctx)
    {
        if (req.ProtocolVersion != ctx.ProtocolVersion)
            return Reject(BrokerError.ProtocolMismatch);
        if (!Operations.TryGetValue(req.OperationId, out var op))
            return Reject(BrokerError.UnsupportedOperation);
        if (!CryptographicOperations.FixedTimeEquals(
                DecodeHex(req.Hmac), BrokerHmac.ComputeHash(ctx.Key, req)))
            return Reject(BrokerError.InvalidHmac);
        var now = ctx.Clock().ToUnixTimeSeconds();
        if (Math.Abs(now - req.Timestamp) > ctx.MaxSkewSeconds)
            return Reject(BrokerError.StaleTimestamp);
        if (!ctx.Replay.TryConsumeNonce(req.Nonce))
            return Reject(BrokerError.ReusedNonce);
        if (ctx.Replay.IsPlanApplied(req.PlanId))
            return Reject(BrokerError.AlreadyApplied);
        if (!string.Equals(req.OwnerSid, ctx.OwnerSid, StringComparison.Ordinal))
            return Reject(BrokerError.ForbiddenOwner);
        if (!string.Equals(req.CatalogDigest, ctx.CatalogDigest, StringComparison.Ordinal))
            return Reject(BrokerError.CatalogMismatch);
        return new BrokerValidationResult { Accepted = true, Error = BrokerError.None, Operation = op };
    }

    private static BrokerValidationResult Reject(BrokerError e) =>
        new() { Accepted = false, Error = e };

    private static byte[] DecodeHex(string hex)
    {
        if (hex.Length % 2 != 0) return Array.Empty<byte>();
        var bytes = new byte[hex.Length / 2];
        for (int i = 0; i < bytes.Length; i++)
        {
            if (!byte.TryParse(hex.AsSpan(i * 2, 2), System.Globalization.NumberStyles.HexNumber, null, out bytes[i]))
                return Array.Empty<byte>();
        }
        return bytes;
    }
}

/// <summary>
/// Strict deserialization options: any unmapped member (an executable path,
/// a URL, free-form arguments) is rejected.
/// </summary>
public static class BrokerProtocol
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
    };

    public const int ProtocolVersion = 1;
    public const int MaxRequestBytes = 64 * 1024;
    public const int MaxResponseBytes = 64 * 1024;
}
