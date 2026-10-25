namespace BotMatchStats.Core;

/// <summary>Latest per-player view of the world, filled by the plugin from raw entity memory.</summary>
public struct PlayerFrame
{
    public bool Present, Alive;
    public int Team;
    public float X, Y, Z, ViewZ, Pitch, Yaw;
    public uint Spot0, Spot1;
    public int Place;
}

/// <summary>Frames indexed by player index, plus the list of player indices currently in the server.</summary>
public sealed class FrameSet
{
    public readonly PlayerFrame[] ByPi = new PlayerFrame[Limits.MaxPlayers];
    public readonly int[] Active = new int[Limits.MaxPlayers];
    public int ActiveCount;
    /// <summary>The human's entity slot, which is the bit tested in an enemy's spotted mask.</summary>
    public int HumanSlot = -1;

    public void Clear()
    {
        Array.Clear(ByPi);
        ActiveCount = 0;
        HumanSlot = -1;
    }
}

/// <summary>
/// Tracks aim engagements for the human, one state per enemy. An engagement opens when the enemy
/// becomes visible, survives gaps shorter than 1 s, and closes when the enemy has been invisible for
/// 1 s (tEnd = the tick it stopped being visible), when either player dies, or at round end.
/// </summary>
public sealed class EngagementTracker
{
    public const double AimStartDegPerSec = 30.0;
    public const double ShotConeDeg = 10.0;

    private const byte None = 0, Open = 1, Gap = 2;

    private struct State
    {
        public byte Mode;
        public int GapStart, PrevTick;
        public double PrevAngle;
        public EngagementRow Row;
    }

    private readonly State[] _s = new State[Limits.MaxPlayers];
    private readonly int _tickRate;

    public EngagementTracker(int tickRate) => _tickRate = tickRate;

    public bool IsActive(int enemy) => _s[enemy].Mode != None;
    public bool IsVisibleOpen(int enemy) => _s[enemy].Mode == Open;

    /// <summary>
    /// Feeds one tick for one alive enemy. <paramref name="angle"/>, deltas and distance are only
    /// read when <paramref name="visible"/> is true.
    /// </summary>
    public void Observe(int ri, int tick, int enemy, bool visible, double angle, double yawDelta, double pitchDelta, double dist, FixedBuffer<EngagementRow> sink)
    {
        ref var s = ref _s[enemy];
        switch (s.Mode)
        {
            case None:
                if (!visible) return;
                s.Mode = Open;
                s.Row = new EngagementRow
                {
                    Ri = ri, Enemy = enemy, TVis = tick,
                    AngVis = AimMath.Centi(angle), AngVisYaw = AimMath.Centi(yawDelta), AngVisPitch = AimMath.Centi(pitchDelta),
                    Dist = AimMath.Round(dist),
                    TAimStart = Nil.V, TFirstShot = Nil.V, TFirstDmg = Nil.V, TEnd = Nil.V,
                    Outcome = Outcome.None,
                };
                s.PrevAngle = angle;
                s.PrevTick = tick;
                return;
            case Open:
                if (visible)
                {
                    TrackAimStart(ref s, tick, angle);
                    return;
                }
                s.Mode = Gap;
                s.GapStart = tick;
                return;
            default: // Gap
                if (visible)
                {
                    s.Mode = Open;
                    // The angle before the gap is stale; the rate is measured again from this tick.
                    s.PrevAngle = angle;
                    s.PrevTick = tick;
                    return;
                }
                if (tick - s.GapStart >= _tickRate) Close(ref s, s.GapStart, Outcome.None, sink);
                return;
        }
    }

    private void TrackAimStart(ref State s, int tick, double angle)
    {
        if (s.Row.TAimStart == Nil.V && !double.IsNaN(angle) && !double.IsNaN(s.PrevAngle) && tick > s.PrevTick)
        {
            double rate = (s.PrevAngle - angle) * _tickRate / (tick - s.PrevTick);
            if (rate >= AimStartDegPerSec) s.Row.TAimStart = tick;
        }
        s.PrevAngle = angle;
        s.PrevTick = tick;
    }

    /// <summary>A shot by the human; the first shot within 10° of a visible enemy sets tFirstShot.</summary>
    public void Shot(int tick, int enemy, double angle)
    {
        ref var s = ref _s[enemy];
        if (s.Mode == Open && s.Row.TFirstShot == Nil.V && angle <= ShotConeDeg) s.Row.TFirstShot = tick;
    }

    public void Damage(int tick, int enemy)
    {
        ref var s = ref _s[enemy];
        if (s.Mode != None && s.Row.TFirstDmg == Nil.V) s.Row.TFirstDmg = tick;
    }

    public void EnemyDied(int tick, int enemy, bool byHuman, FixedBuffer<EngagementRow> sink)
    {
        ref var s = ref _s[enemy];
        if (s.Mode == None) return;
        Close(ref s, s.Mode == Open ? tick : s.GapStart, byHuman ? Outcome.Kill : Outcome.None, sink);
    }

    /// <summary>The enemy left, changed team, or died without a death event.</summary>
    public void EnemyGone(int tick, int enemy, FixedBuffer<EngagementRow> sink)
    {
        ref var s = ref _s[enemy];
        if (s.Mode == None) return;
        Close(ref s, s.Mode == Open ? tick : s.GapStart, Outcome.None, sink);
    }

    public void HumanDied(int tick, FixedBuffer<EngagementRow> sink) => CloseAll(tick, Outcome.Died, sink);

    public void CloseAll(int tick, FixedBuffer<EngagementRow> sink) => CloseAll(tick, Outcome.None, sink);

    private void CloseAll(int tick, Outcome outcome, FixedBuffer<EngagementRow> sink)
    {
        for (int i = 0; i < _s.Length; i++)
        {
            ref var s = ref _s[i];
            if (s.Mode != None) Close(ref s, s.Mode == Open ? tick : s.GapStart, outcome, sink);
        }
    }

    private static void Close(ref State s, int tEnd, Outcome outcome, FixedBuffer<EngagementRow> sink)
    {
        s.Row.TEnd = tEnd;
        s.Row.Outcome = outcome;
        sink.Add(s.Row);
        s.Mode = None;
    }

    public void Reset() => Array.Clear(_s);
}
