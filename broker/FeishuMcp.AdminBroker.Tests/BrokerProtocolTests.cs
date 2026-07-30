using System.Text.Json;
using FeishuMcp.AdminBroker;
using Xunit;

namespace FeishuMcp.AdminBroker.Tests;

public class BrokerProtocolTests
{
    private static readonly byte[] Key = Convert.FromHexString(
        "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    private const string OwnerSid = "S-1-5-21-1-2-3-1000";
    private static readonly DateTimeOffset Now =
        new DateTimeOffset(2026, 7, 30, 8, 0, 0, TimeSpan.Zero);

    private static BrokerCatalog Catalog => BrokerCatalog.Load();

    private static BrokerValidationContext Context(IReplayStore? replay = null) => new()
    {
        ProtocolVersion = BrokerProtocol.ProtocolVersion,
        CatalogDigest = Catalog.CatalogDigest,
        OwnerSid = OwnerSid,
        Key = Key,
        Replay = replay ?? new InMemoryReplayStore(),
        Clock = () => Now,
    };

    private static BrokerRequest MakeRequest(string nonce = "nonce-1") => new()
    {
        ProtocolVersion = BrokerProtocol.ProtocolVersion,
        RequestId = "req-1",
        PlanId = "11111111-1111-1111-1111-111111111111",
        OperationId = "winget",
        ComponentId = "microsoft.dotnet.sdk.8",
        Version = "8.0.404",
        CatalogDigest = Catalog.CatalogDigest,
        OwnerSid = OwnerSid,
        Timestamp = Now.ToUnixTimeSeconds(),
        Nonce = nonce,
        Hmac = "",
    };

    private static BrokerRequest Signed(BrokerRequest r)
    {
        r.Hmac = BrokerHmac.ComputeHex(Key, r);
        return r;
    }

    private static BrokerError Validate(BrokerRequest r, IReplayStore? replay = null)
        => new BrokerRequestValidator().Validate(r, Context(replay)).Error;

    [Fact]
    public void AcceptsAValidlySignedRequest()
    {
        var result = new BrokerRequestValidator().Validate(Signed(MakeRequest()), Context());
        Assert.True(result.Accepted);
        Assert.Equal(BrokerError.None, result.Error);
        Assert.Equal(OperationKind.Winget, result.Operation);
    }

    [Fact]
    public void RejectsWrongOwnerSid()
    {
        var r = MakeRequest();
        r.OwnerSid = "S-1-0-0";
        Assert.Equal(BrokerError.ForbiddenOwner, Validate(Signed(r)));
    }

    [Fact]
    public void RejectsStaleTimestamp()
    {
        var r = MakeRequest();
        r.Timestamp = Now.ToUnixTimeSeconds() - 200;
        Assert.Equal(BrokerError.StaleTimestamp, Validate(Signed(r)));
    }

    [Fact]
    public void RejectsReusedNonce()
    {
        var replay = new InMemoryReplayStore();
        var r = Signed(MakeRequest("nonce-x"));
        Assert.Equal(BrokerError.None, Validate(r, replay));
        Assert.Equal(BrokerError.ReusedNonce, Validate(r, replay));
    }

    [Fact]
    public void RejectsAlreadyAppliedPlan()
    {
        var replay = new InMemoryReplayStore();
        replay.MarkPlanApplied("11111111-1111-1111-1111-111111111111");
        var r = Signed(MakeRequest("nonce-applied"));
        Assert.Equal(BrokerError.AlreadyApplied, Validate(r, replay));
    }

    [Fact]
    public void RejectsProtocolMismatch()
    {
        var r = MakeRequest();
        r.ProtocolVersion = 2;
        Assert.Equal(BrokerError.ProtocolMismatch, Validate(Signed(r)));
    }

    [Fact]
    public void RejectsCatalogMismatch()
    {
        var r = MakeRequest();
        r.CatalogDigest = "deadbeef";
        Assert.Equal(BrokerError.CatalogMismatch, Validate(Signed(r)));
    }

    [Fact]
    public void RejectsUnknownOperationId()
    {
        var r = MakeRequest();
        r.OperationId = "run_command";
        Assert.Equal(BrokerError.UnsupportedOperation, Validate(Signed(r)));
    }

    [Fact]
    public void RejectsInvalidHmac()
    {
        var r = MakeRequest();
        r.Hmac = "00".PadRight(64, '0');
        Assert.Equal(BrokerError.InvalidHmac, Validate(r));
    }

    [Fact]
    public void RejectsExtraJsonProperty()
        => Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BrokerRequest>(
                "{\"protocolVersion\":1,\"requestId\":\"r\",\"planId\":\"p\",\"operationId\":\"winget\"," +
                "\"componentId\":\"c\",\"version\":\"v\",\"catalogDigest\":\"d\",\"ownerSid\":\"s\"," +
                "\"timestamp\":1,\"nonce\":\"n\",\"hmac\":\"h\",\"executable\":\"cmd.exe\"}",
                BrokerProtocol.JsonOptions));

    [Fact]
    public void RejectsExtraUrlProperty()
        => Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BrokerRequest>(
                "{\"protocolVersion\":1,\"requestId\":\"r\",\"planId\":\"p\",\"operationId\":\"winget\"," +
                "\"componentId\":\"c\",\"version\":\"v\",\"catalogDigest\":\"d\",\"ownerSid\":\"s\"," +
                "\"timestamp\":1,\"nonce\":\"n\",\"hmac\":\"h\",\"url\":\"http://evil\"}",
                BrokerProtocol.JsonOptions));

    [Fact]
    public void RejectsExtraFreeFormArgumentsProperty()
        => Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BrokerRequest>(
                "{\"protocolVersion\":1,\"requestId\":\"r\",\"planId\":\"p\",\"operationId\":\"winget\"," +
                "\"componentId\":\"c\",\"version\":\"v\",\"catalogDigest\":\"d\",\"ownerSid\":\"s\"," +
                "\"timestamp\":1,\"nonce\":\"n\",\"hmac\":\"h\",\"arguments\":[\"-c\",\"rm\"]}",
                BrokerProtocol.JsonOptions));
}
