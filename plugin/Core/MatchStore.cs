namespace BotMatchStats.Core;

/// <summary>
/// The whole match as the worker holds it. Owned by the worker thread only. Arrays keep their
/// capacity across matches (bounded by each table's hard cap) so long sessions reuse memory.
/// </summary>
public sealed class MatchStore
{
    // Hard caps bound memory if a match runs far beyond regulation (e.g. endless overtime):
    // position rows at 512K × 32 B = 16 MB is the largest table.
    public readonly GrowBuffer<KillRow> Kills = new(256, 16_384);
    public readonly GrowBuffer<DamageRow> Damage = new(2048, 131_072);
    public readonly GrowBuffer<BlindRow> Blinds = new(512, 32_768);
    public readonly GrowBuffer<GrenadeRow> Grenades = new(512, 32_768);
    public readonly GrowBuffer<ThrowRow> Throws = new(512, 32_768);
    public readonly GrowBuffer<PosRow> Pos = new(16_384, 524_288);
    public readonly GrowBuffer<EngagementRow> Engagements = new(512, 32_768);
    public readonly GrowBuffer<ShotRow> Shots = new(2048, 131_072);
    public readonly GrowBuffer<ReconMismatch> Mismatches = new(256, 16_384);
    public readonly GrowBuffer<ReconRound> ReconRounds = new(64, 4096);
    public readonly GrowBuffer<PerfRow> Perf = new(64, 4096);

    private readonly List<RoundRow> _rounds = new();
    public int RoundCount { get; private set; }
    public const int MaxRounds = 256;

    public MatchMeta Meta = new();
    public int CapUnknown;
    /// <summary>Rows dropped on the game thread because a per-round buffer was full, by table name.</summary>
    public readonly Dictionary<string, int> DroppedGame = new(StringComparer.Ordinal);

    public double LastWriteMs, MaxWriteMs;
    public long LastBytes;

    public RoundRow Round(int ri) => _rounds[ri];

    public void SetRound(RoundRow src)
    {
        int ri = src.Ri;
        if (ri < 0 || ri >= MaxRounds) return;
        while (_rounds.Count <= ri) _rounds.Add(new RoundRow());
        for (int i = RoundCount; i < ri; i++) _rounds[i].Reset(i); // gap: unknown rounds stay null
        _rounds[ri].CopyFrom(src);
        if (ri >= RoundCount) RoundCount = ri + 1;
    }

    public void Append(RoundBuffer b)
    {
        Kills.Append(b.Kills.Span); Drop("kills", b.Kills.Dropped);
        Damage.Append(b.Damage.Span); Drop("damage", b.Damage.Dropped);
        Blinds.Append(b.Blinds.Span); Drop("blinds", b.Blinds.Dropped);
        Grenades.Append(b.Grenades.Span); Drop("grenades", b.Grenades.Dropped);
        Throws.Append(b.Throws.Span); Drop("throws", b.Throws.Dropped);
        Pos.Append(b.Pos.Span); Drop("pos", b.Pos.Dropped);
        Engagements.Append(b.Engagements.Span); Drop("engagements", b.Engagements.Dropped);
        Shots.Append(b.Shots.Span); Drop("shots", b.Shots.Dropped);
        Mismatches.Append(b.Mismatches.Span); Drop("mismatch", b.Mismatches.Dropped);
        ReconRounds.Append(b.ReconRounds.Span);
        Perf.Append(b.Perf.Span);
        CapUnknown += b.CapUnknown;
        for (int i = 0; i < b.RoundCount; i++) SetRound(b.RoundAt(i));
    }

    private void Drop(string table, int n)
    {
        if (n <= 0) return;
        DroppedGame[table] = DroppedGame.GetValueOrDefault(table) + n;
    }

    public int TotalDropped(string table, int storeDropped) => DroppedGame.GetValueOrDefault(table) + storeDropped;

    public void Clear()
    {
        Kills.Clear(); Damage.Clear(); Blinds.Clear(); Grenades.Clear(); Throws.Clear(); Pos.Clear();
        Engagements.Clear(); Shots.Clear(); Mismatches.Clear(); ReconRounds.Clear(); Perf.Clear();
        RoundCount = 0;
        CapUnknown = 0;
        DroppedGame.Clear();
        Meta = new MatchMeta();
        LastWriteMs = MaxWriteMs = 0;
        LastBytes = 0;
    }
}
