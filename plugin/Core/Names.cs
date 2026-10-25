using System.Text;

namespace BotMatchStats.Core;

public enum WeaponClass { Rifle = 0, Sniper = 1, Smg = 2, Pistol = 3, Shotgun = 4, Heavy = 5 }

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

    /// <summary>Names for <see cref="WeaponClass"/>, as written in aim.shots.cls.</summary>
    public static readonly string[] ClassNames = { "rifle", "sniper", "smg", "pistol", "shotgun", "heavy" };

    /// <summary>The class of a gun by its stripped item name; Nil for the taser, non-guns and unknown names.</summary>
    public static int ClassOf(string strippedName) => strippedName switch
    {
        "ak47" or "m4a1" or "m4a1_silencer" or "famas" or "galilar" or "sg556" or "aug" => (int)WeaponClass.Rifle,
        "awp" or "ssg08" or "g3sg1" or "scar20" => (int)WeaponClass.Sniper,
        "mac10" or "mp9" or "mp7" or "mp5sd" or "ump45" or "p90" or "bizon" => (int)WeaponClass.Smg,
        "glock" or "hkp2000" or "usp_silencer" or "p250" or "elite" or "fiveseven" or "tec9" or "cz75a" or "deagle" or "revolver" => (int)WeaponClass.Pistol,
        "nova" or "xm1014" or "sawedoff" or "mag7" => (int)WeaponClass.Shotgun,
        "m249" or "negev" => (int)WeaponClass.Heavy,
        _ => Nil.V,
    };
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
/// Place-name table keyed by the raw UTF-8 bytes of <c>m_szLastPlaceName</c>. Lookup and the first
/// sight of a new place are allocation-free: bytes are copied into storage sized at construction, and
/// the map's area names are pre-encoded. Strings are created only by <see cref="ToArray"/> and the
/// indexer, which run at hand-off time, never in the tick path.
/// </summary>
public sealed class PlaceTable
{
    /// <summary>Longest stored name; m_szLastPlaceName is 18 bytes including the terminator.</summary>
    public const int MaxNameBytes = 32;

    private readonly byte[] _store;
    private readonly int[] _len;
    private readonly int[] _area;
    private readonly string?[] _names;
    private (byte[] name, int area)[] _areaTable = Array.Empty<(byte[], int)>();
    public int Cap { get; }
    public int Count { get; private set; }
    public bool HasAreas { get; private set; }

    public PlaceTable(int cap)
    {
        Cap = cap;
        _store = new byte[cap * MaxNameBytes];
        _len = new int[cap];
        _area = new int[cap];
        _names = new string?[cap];
    }

    public string this[int i] => _names[i] ??= Encoding.UTF8.GetString(Bytes(i));

    private ReadOnlySpan<byte> Bytes(int i) => new(_store, i * MaxNameBytes, _len[i]);

    public void SetMap(string map)
    {
        var t = MapAreas.For(map);
        HasAreas = t != null;
        _areaTable = t == null ? Array.Empty<(byte[], int)>() : t.Select(kv => (Encoding.UTF8.GetBytes(kv.Key), kv.Value)).ToArray();
        for (int i = 0; i < Count; i++) _area[i] = AreaOf(Bytes(i));
    }

    /// <summary>Area index (see <see cref="CtSetupCounter"/>) for a place index; Other for unknown names.</summary>
    public int Area(int place) => (uint)place < (uint)Count ? _area[place] : CtSetupCounter.Other;

    /// <summary>Returns the place index for a null-terminated UTF-8 name, or Nil for an empty name or a full table.</summary>
    public int Lookup(ReadOnlySpan<byte> raw)
    {
        int len = raw.IndexOf((byte)0);
        if (len < 0) len = raw.Length;
        if (len == 0) return Nil.V;
        if (len > MaxNameBytes) len = MaxNameBytes;
        var name = raw[..len];
        for (int i = 0; i < Count; i++)
            if (name.SequenceEqual(Bytes(i))) return i;
        return Add(name, null);
    }

    public int Get(string name)
    {
        Span<byte> buf = stackalloc byte[MaxNameBytes * 3];
        int n = Encoding.UTF8.GetBytes(name.AsSpan(), buf);
        var bytes = buf[..Math.Min(n, MaxNameBytes)];
        for (int i = 0; i < Count; i++)
            if (bytes.SequenceEqual(Bytes(i))) return i;
        return Add(bytes, name);
    }

    private int Add(ReadOnlySpan<byte> name, string? str)
    {
        if (Count >= Cap) return Nil.V;
        int i = Count++;
        name.CopyTo(_store.AsSpan(i * MaxNameBytes));
        _len[i] = name.Length;
        _area[i] = AreaOf(name);
        _names[i] = str;
        return i;
    }

    private int AreaOf(ReadOnlySpan<byte> name)
    {
        foreach (var (n, a) in _areaTable)
            if (name.SequenceEqual(n)) return a;
        return CtSetupCounter.Other;
    }

    public string[] ToArray()
    {
        var a = new string[Count];
        for (int i = 0; i < Count; i++) a[i] = this[i];
        return a;
    }

    public void Load(IEnumerable<string> names)
    {
        Clear();
        foreach (var n in names) Get(n);
    }

    public void Clear()
    {
        Count = 0;
        Array.Clear(_names);
    }
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
