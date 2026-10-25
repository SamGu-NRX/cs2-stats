using System.Text;

namespace BotMatchStats.Core;

public static class WeaponNames
{
    public static string Strip(string name) =>
        name.StartsWith("weapon_", StringComparison.Ordinal) ? name.Substring(7) : name;

    /// <summary>
    /// player_hurt reports the base item for some variants ("m4a1" for the M4A1-S, "hkp2000" for the
    /// USP-S, as seen in fixtures/events_two_matches.jsonl), while player_death names the variant.
    /// Only those base names are resolved, using the attacker's active item definition index.
    /// Returns null when the hurt name needs no change.
    /// </summary>
    public static string? HurtVariant(string hurtName, int itemDefIndex) => (hurtName, itemDefIndex) switch
    {
        ("m4a1", 60) => "m4a1_silencer",
        ("hkp2000", 61) => "usp_silencer",
        ("deagle", 64) => "revolver",
        ("mp7", 23) => "mp5sd",
        _ => null,
    };

    public static bool NeedsVariantCheck(string hurtName) =>
        hurtName is "m4a1" or "hkp2000" or "deagle" or "mp7";

    /// <summary>True for guns (anything that fires bullets); false for knives, grenades, C4 and other items.</summary>
    public static bool IsBulletWeapon(string strippedName)
    {
        if (strippedName.Length == 0) return false;
        if (strippedName.StartsWith("knife", StringComparison.Ordinal) || strippedName.StartsWith("bayonet", StringComparison.Ordinal)) return false;
        return strippedName switch
        {
            "hegrenade" or "flashbang" or "smokegrenade" or "molotov" or "incgrenade" or "decoy" or "c4"
                or "healthshot" or "tagrenade" or "inferno" or "planted_c4" or "world" => false,
            _ => true,
        };
    }

    public static readonly string[] GrenadeTypeNames = { "he", "flash", "smoke", "molotov", "decoy" };
    public static readonly string[] UtilTypeNames = { "he", "flash", "smoke", "molotov", "incgrenade", "decoy" };

    /// <summary>Maps a grenade item name (with or without the weapon_ prefix) to its type; false for non-grenades.</summary>
    public static bool TryUtilType(string name, out UtilType type)
    {
        switch (Strip(name))
        {
            case "hegrenade": type = UtilType.He; return true;
            case "flashbang": type = UtilType.Flash; return true;
            case "smokegrenade": type = UtilType.Smoke; return true;
            case "molotov": type = UtilType.Molotov; return true;
            case "incgrenade": type = UtilType.Incendiary; return true;
            case "decoy": type = UtilType.Decoy; return true;
            default: type = default; return false;
        }
    }

    /// <summary>The detonation type behind a damage or kill weapon name: HE or fire. Nil for everything else.</summary>
    public static int NadeSourceOf(string strippedName) => strippedName switch
    {
        "hegrenade" => (int)GrenadeType.He,
        "inferno" or "molotov" or "incgrenade" => (int)GrenadeType.Molotov,
        _ => Nil.V,
    };

    /// <summary>The detonation type a thrown item produces.</summary>
    public static GrenadeType DetonationOf(UtilType t) => t switch
    {
        UtilType.He => GrenadeType.He,
        UtilType.Flash => GrenadeType.Flash,
        UtilType.Smoke => GrenadeType.Smoke,
        UtilType.Decoy => GrenadeType.Decoy,
        _ => GrenadeType.Molotov,
    };
}

/// <summary>String → index table for names stored once per file (weapons).</summary>
public sealed class NameTable
{
    private readonly Dictionary<string, int> _index = new(StringComparer.Ordinal);
    private readonly List<string> _names = new();
    public int Cap { get; }

    public NameTable(int cap) => Cap = cap;

    public int Count => _names.Count;
    public string this[int i] => _names[i];

    public int Get(string name)
    {
        if (_index.TryGetValue(name, out int i)) return i;
        if (_names.Count >= Cap) return Nil.V;
        i = _names.Count;
        _names.Add(name);
        _index.Add(name, i);
        return i;
    }

    public string[] ToArray() => _names.ToArray();

    public void Load(IEnumerable<string> names)
    {
        Clear();
        foreach (var n in names) Get(n);
    }

    public void Clear() { _index.Clear(); _names.Clear(); }
}

/// <summary>
/// Place-name table keyed by the raw UTF-8 bytes of <c>m_szLastPlaceName</c>, so the per-tick
/// sampler can resolve a place without creating a string. A string is allocated only the first time
/// a new place appears in a match.
/// </summary>
public sealed class PlaceTable
{
    private readonly List<byte[]> _bytes = new();
    private readonly List<string> _names = new();
    private readonly List<int> _area = new();
    private Dictionary<string, int>? _areaTable;
    public int Cap { get; }

    public PlaceTable(int cap) => Cap = cap;

    public int Count => _names.Count;
    public string this[int i] => _names[i];

    public void SetMap(string map)
    {
        _areaTable = MapAreas.For(map);
        for (int i = 0; i < _area.Count; i++) _area[i] = AreaOf(_names[i]);
    }

    public bool HasAreas => _areaTable != null;

    /// <summary>Area index (see <see cref="CtSetupCounter"/>) for a place index; Other for unknown names.</summary>
    public int Area(int place) => (uint)place < (uint)_area.Count ? _area[place] : CtSetupCounter.Other;

    /// <summary>Returns the place index for a null-terminated UTF-8 name, or Nil for an empty name.</summary>
    public int Lookup(ReadOnlySpan<byte> raw)
    {
        int len = raw.IndexOf((byte)0);
        if (len < 0) len = raw.Length;
        if (len == 0) return Nil.V;
        var name = raw[..len];
        for (int i = 0; i < _bytes.Count; i++)
            if (name.SequenceEqual(_bytes[i])) return i;
        if (_names.Count >= Cap) return Nil.V;
        return Add(Encoding.UTF8.GetString(name));
    }

    public int Get(string name)
    {
        int i = _names.IndexOf(name);
        return i >= 0 ? i : (_names.Count >= Cap ? Nil.V : Add(name));
    }

    private int Add(string name)
    {
        _bytes.Add(Encoding.UTF8.GetBytes(name));
        _names.Add(name);
        _area.Add(AreaOf(name));
        return _names.Count - 1;
    }

    private int AreaOf(string name) =>
        _areaTable != null && _areaTable.TryGetValue(name, out int a) ? a : CtSetupCounter.Other;

    public string[] ToArray() => _names.ToArray();

    public void Load(IEnumerable<string> names)
    {
        Clear();
        foreach (var n in names) Add(n);
    }

    public void Clear() { _bytes.Clear(); _names.Clear(); _area.Clear(); }
}

public static class MapAreas
{
    // de_dust2 place → macro area, from the 20 places TAGNet groups into A/B/Mid/CT.
    private static readonly Dictionary<string, int> Dust2 = Build(
        (CtSetupCounter.A, new[] { "ARamp", "BombsiteA", "Catwalk", "ExtendedA", "LongA", "LongDoors", "Pit", "ShortStairs", "UnderA" }),
        (CtSetupCounter.B, new[] { "BDoors", "BombsiteB", "LowerTunnel", "TunnelStairs", "UpperTunnel" }),
        (CtSetupCounter.Mid, new[] { "Hole", "MidDoors", "Middle", "TopMid" }),
        (CtSetupCounter.Ct, new[] { "CTSpawn", "Side" }));

    private static Dictionary<string, int> Build(params (int area, string[] places)[] groups)
    {
        var d = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (area, places) in groups)
            foreach (var p in places) d.Add(p, area);
        return d;
    }

    /// <summary>The place → area table for a map, or null when the map has none (ctSetup is then null).</summary>
    public static Dictionary<string, int>? For(string map) => map == "de_dust2" ? Dust2 : null;
}

public static class CtSetupCounter
{
    public const int A = 0, B = 1, Mid = 2, Ct = 3, Other = 4, Areas = 5;

    public static void Add(Span<int> counts, int area)
    {
        if ((uint)area >= Areas) area = Other;
        counts[area]++;
    }
}
