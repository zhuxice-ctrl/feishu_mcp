using System.Text.Json;
using FeishuMcp.AdminBroker;
using Xunit;

namespace FeishuMcp.AdminBroker.Tests;

public class BrokerCatalogTests
{
    [Fact]
    public void LoadsEmbeddedCatalog()
    {
        var catalog = BrokerCatalog.Load();
        Assert.Equal(1, catalog.Document.Version);
        Assert.True(catalog.Document.Components.Count >= 17);
    }

    [Fact]
    public void ComponentIdsAreUnique()
    {
        var catalog = BrokerCatalog.Load();
        var ids = catalog.Document.Components.Select(c => c.Id).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    [Fact]
    public void FindsKnownComponent()
    {
        var catalog = BrokerCatalog.Load();
        Assert.NotNull(catalog.Find("microsoft.dotnet.sdk.8"));
        Assert.NotNull(catalog.Find("google.android.platform-tools"));
        Assert.Null(catalog.Find("does.not.exist"));
    }

    [Fact]
    public void CatalogDigestIsStableHex()
    {
        var catalog = BrokerCatalog.Load();
        Assert.Matches("^[0-9a-f]{64}$", catalog.CatalogDigest);
        Assert.Equal(catalog.CatalogDigest, BrokerCatalog.Load().CatalogDigest);
    }

    [Fact]
    public void CatalogDigestMatchesNodePlanner()
    {
        // Cross-side binding: the C# broker and the Node planner must derive
        // the same digest from the same catalog file. The constant below is the
        // output of the Node `catalogDigest(catalog)` for the current catalog.
        // If the catalog changes, update this constant (both sides recompute).
        const string expected = "45f6d3516f44418d396ff68cf2ae14dacf9b3458cdfb1ee6d9404d78f65dc533";
        Assert.Equal(expected, BrokerCatalog.Load().CatalogDigest);
    }

    [Fact]
    public void RejectsCatalogWithExtraTopLevelKey()
    {
        var raw = "{\"version\":1,\"components\":[],\"ownerSid\":\"S-1-5-32-544\"}";
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<CatalogDocument>(raw, CatalogJsonOptions.Instance));
    }

    [Fact]
    public void VerifiedArchiveSourcesAreHttps()
    {
        var catalog = BrokerCatalog.Load();
        foreach (var c in catalog.Document.Components.Where(x => x.Install.Kind == "verified_archive"))
        {
            Assert.StartsWith("https://", c.Install.Url);
            Assert.Matches("^[0-9a-f]{64}$", c.Install.Sha256 ?? "");
        }
    }
}
