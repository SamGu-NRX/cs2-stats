using System.Diagnostics;

namespace BotMatchStats.Core;

public sealed class EnvInfo
{
    public string Plugin = "";
    public string? Cssharp, Game;
    public int TickRate = 64;
    public int MaxRounds = Nil.V, BotDifficulty = Nil.V;
    /// <summary>mp_halftime; used to derive startSide for players first seen after round 0. Not written to the file.</summary>
    public bool Halftime = true;
    /// <summary>"pawn", "inventory" or "mixed": the source(s) of equipment values in this match; null before any round.</summary>
    public string? EquipSource;

    public EnvInfo Clone() => (EnvInfo)MemberwiseClone();
}

public struct PlayerInfo
{
    public string Key, Name;
    public bool IsBot;
    public int StartSide;
}

/// <summary>Top-level fields and lookup tables, snapshotted by the game thread at each hand-off.</summary>
public sealed class MatchMeta
{
    public string Id = "", Map = "", StartUtc = "";
    public string? EndUtc;
    /// <summary>"complete", "abandoned", "restarted", or "inprogress" (only in files under inprogress\).</summary>
    public string Status = "inprogress";
    public EnvInfo Env = new();
    public int FirstFullRound;
    public int Human = Nil.V;
    public string[] Weapons = Array.Empty<string>();
    public string[] Places = Array.Empty<string>();
    public PlayerInfo[] Players = Array.Empty<PlayerInfo>();
    public int[] PartialRounds = Array.Empty<int>();
    public int[] UnknownResults = Array.Empty<int>();
    /// <summary>CCSGameRules.m_flGameStartTime; with the map, identifies the game when resuming after a hot reload.</summary>
    public float GameStart;
    public int NextBurst = 1;
    /// <summary>Rows already in the grenades and throws tables, i.e. the next row's match-wide index. Not written to the file.</summary>
    public int GrenadeCount, ThrowCount;
    /// <summary>Rounds already in the file (set when decoding). Not written to the file.</summary>
    public int RoundCount;

    /// <summary>Copy that shares no mutable state, for handing between the game thread and the worker.</summary>
    public MatchMeta Clone()
    {
        var c = (MatchMeta)MemberwiseClone();
        c.Env = Env.Clone();
        c.Weapons = (string[])Weapons.Clone();
        c.Places = (string[])Places.Clone();
        c.Players = (PlayerInfo[])Players.Clone();
        c.PartialRounds = (int[])PartialRounds.Clone();
        c.UnknownResults = (int[])UnknownResults.Clone();
        return c;
    }

    /// <summary>File name without extension: &lt;startUtc&gt;_&lt;map&gt;_&lt;id8&gt;, with the time in a path-safe compact form.</summary>
    public string BaseName
    {
        get
        {
            string stamp = DateTime.TryParse(StartUtc, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var t)
                ? t.ToString("yyyyMMdd'T'HHmmss'Z'", System.Globalization.CultureInfo.InvariantCulture)
                : "unknown";
            return $"{stamp}_{Map}_{(Id.Length >= 8 ? Id[..8] : Id)}";
        }
    }

    public string Year => DateTime.TryParse(StartUtc, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var t)
        ? t.Year.ToString(System.Globalization.CultureInfo.InvariantCulture) : "unknown";
}

public enum JobKind { InProgress, Final }

public sealed class WriteJob
{
    public JobKind Kind;
    public RoundBuffer? Buffer;
    public MatchMeta Meta = new();
}

/// <summary>Per-round timing and allocation counters for the plugin's own code on the game thread.</summary>
public sealed class PerfCounter
{
    private long _tickSum, _tickMax, _tickN, _evSum, _evMax, _evN, _tickAlloc, _evAlloc;
    private string? _evMaxName;
    private int _gen0Start = GC.CollectionCount(0);

    public void Tick(long elapsed, long alloc)
    {
        _tickSum += elapsed;
        if (elapsed > _tickMax) _tickMax = elapsed;
        _tickN++;
        _tickAlloc += alloc;
    }

    public void Event(long elapsed, long alloc, string name)
    {
        _evSum += elapsed;
        if (elapsed > _evMax) { _evMax = elapsed; _evMaxName = name; }
        _evN++;
        _evAlloc += alloc;
    }

    public double MaxEventUsSoFar => Us(_evMax);

    private static double Us(long ts) => ts * 1_000_000.0 / Stopwatch.Frequency;

    public PerfRow Take(int ri)
    {
        int gen0 = GC.CollectionCount(0);
        var row = new PerfRow
        {
            Ri = ri,
            Ticks = (int)_tickN,
            TickAvgUs = _tickN == 0 ? 0 : Us(_tickSum) / _tickN,
            TickMaxUs = Us(_tickMax),
            Events = (int)_evN,
            EventAvgUs = _evN == 0 ? 0 : Us(_evSum) / _evN,
            EventMaxUs = Us(_evMax),
            EventMaxName = _evMaxName,
            TickAllocBytes = _tickAlloc,
            EventAllocBytes = _evAlloc,
            Gen0 = gen0 - _gen0Start,
        };
        Reset();
        _gen0Start = gen0;
        return row;
    }

    public void Reset()
    {
        _tickSum = _tickMax = _tickN = _evSum = _evMax = _evN = _tickAlloc = _evAlloc = 0;
        _evMaxName = null;
        _gen0Start = GC.CollectionCount(0);
    }
}
