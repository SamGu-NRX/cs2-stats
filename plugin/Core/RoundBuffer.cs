namespace BotMatchStats.Core;

/// <summary>
/// Everything the game thread recorded since the last hand-off to the worker. Buffers are pooled:
/// the worker copies the rows into its match store and returns the buffer, so steady-state
/// recording allocates nothing.
/// </summary>
public sealed class RoundBuffer
{
    // Capacities are per segment (about one round). A 155 s live round samples the human 620 times
    // and nine bots 1395 times, so 4096 position rows leave room; the other tables are sized well
    // above the largest rounds in fixtures/events_two_matches.jsonl (max 13 deaths, 90 hurts per round).
    public readonly FixedBuffer<KillRow> Kills = new(128);
    public readonly FixedBuffer<DamageRow> Damage = new(2048);
    public readonly FixedBuffer<BlindRow> Blinds = new(512);
    public readonly FixedBuffer<GrenadeRow> Grenades = new(256);
    public readonly FixedBuffer<ThrowRow> Throws = new(256);
    public readonly FixedBuffer<LeaveRow> Leaves = new(64);
    public readonly FixedBuffer<HitMaskRow> HitMask = new(512);
    public readonly FixedBuffer<PosRow> Pos = new(4096);
    public readonly FixedBuffer<EngagementRow> Engagements = new(512);
    public readonly FixedBuffer<ShotRow> Shots = new(2048);
    public readonly FixedBuffer<ReconMismatch> Mismatches = new(256);
    public readonly FixedBuffer<ReconRound> ReconRounds = new(64);
    public readonly FixedBuffer<PerfRow> Perf = new(8);

    private readonly List<RoundRow> _roundPool = new();
    public int RoundCount { get; private set; }

    /// <summary>Damage rows whose victim HP before the hit was unknown, so the cap could not be applied exactly.</summary>
    public int CapUnknown;

    public RoundRow AddRound(RoundRow source)
    {
        if (RoundCount == _roundPool.Count) _roundPool.Add(new RoundRow());
        var r = _roundPool[RoundCount++];
        r.CopyFrom(source);
        return r;
    }

    public RoundRow RoundAt(int i) => _roundPool[i];

    public void Clear()
    {
        Kills.Clear(); Damage.Clear(); Blinds.Clear(); Grenades.Clear(); Throws.Clear(); Leaves.Clear(); HitMask.Clear(); Pos.Clear();
        Engagements.Clear(); Shots.Clear(); Mismatches.Clear(); ReconRounds.Clear(); Perf.Clear();
        RoundCount = 0;
        CapUnknown = 0;
    }
}
