using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace FeishuMcp.AdminBroker;

/// <summary>
/// Embedded trusted-component catalog. The same JSON file is loaded by the
/// Node planner and embedded into the broker at build time, so the catalog
/// digest binds a plan to the exact reviewed component set the broker knows.
/// </summary>
public sealed class BrokerCatalog
{
    private const string ResourceName = "development-package-catalog.json";

    public CatalogDocument Document { get; }
    public string CatalogDigest { get; }
    public IReadOnlyDictionary<string, CatalogComponent> ComponentsById { get; }

    private BrokerCatalog(CatalogDocument doc, string digest, Dictionary<string, CatalogComponent> byId)
    {
        Document = doc;
        CatalogDigest = digest;
        ComponentsById = byId;
    }

    public static BrokerCatalog Load()
    {
        var asm = Assembly.GetExecutingAssembly();
        using var stream = asm.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"embedded catalog resource '{ResourceName}' not found");
        string raw;
        using (var reader = new StreamReader(stream, Encoding.UTF8))
        {
            raw = reader.ReadToEnd();
        }
        var doc = JsonSerializer.Deserialize<CatalogDocument>(raw, CatalogJsonOptions.Instance)
            ?? throw new InvalidOperationException("catalog deserialized to null");
        if (doc.Components.Count == 0)
            throw new InvalidOperationException("catalog has no components");
        var byId = doc.Components.ToDictionary(c => c.Id, c => c, StringComparer.Ordinal);
        if (byId.Count != doc.Components.Count)
            throw new InvalidOperationException("catalog has duplicate component ids");
        var digest = ComputeDigest(raw);
        return new BrokerCatalog(doc, digest, byId);
    }

    public CatalogComponent? Find(string componentId) =>
        ComponentsById.TryGetValue(componentId, out var c) ? c : null;

    /// <summary>
    /// Stable SHA-256 of the catalog's canonical JSON form. Matches the Node
    /// <c>catalogDigest</c>: the parsed object re-serialized with no
    /// whitespace, preserving source key order.
    /// </summary>
    public static string ComputeDigest(string rawJson)
    {
        var node = JsonNode.Parse(rawJson)
            ?? throw new InvalidOperationException("catalog is not valid JSON");
        var canonical = JsonSerializer.Serialize(node, CatalogJsonOptions.Minified);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }
}

public static class CatalogJsonOptions
{
    public static readonly JsonSerializerOptions Instance = new()
    {
        PropertyNamingPolicy = null,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    public static readonly JsonSerializerOptions Minified = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = null,
    };
}

public sealed class CatalogDocument
{
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("components")] public List<CatalogComponent> Components { get; set; } = new();
}

public sealed class CatalogComponent
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("target")] public string Target { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("versions")] public List<string> Versions { get; set; } = new();
    [JsonPropertyName("discovery")] public CatalogDiscovery Discovery { get; set; } = new();
    [JsonPropertyName("publishers")] public List<string> Publishers { get; set; } = new();
    [JsonPropertyName("install")] public CatalogInstall Install { get; set; } = new();
}

public sealed class CatalogDiscovery
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("values")] public List<string> Values { get; set; } = new();
}

public sealed class CatalogInstall
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("packageId")] public string? PackageId { get; set; }
    [JsonPropertyName("source")] public string? Source { get; set; }
    [JsonPropertyName("workloadId")] public string? WorkloadId { get; set; }
    [JsonPropertyName("artifactId")] public string? ArtifactId { get; set; }
    [JsonPropertyName("url")] public string? Url { get; set; }
    [JsonPropertyName("sha256")] public string? Sha256 { get; set; }
}
