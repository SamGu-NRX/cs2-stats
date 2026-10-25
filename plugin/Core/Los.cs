using System.Diagnostics;

namespace BotMatchStats.Core;

/// <summary>
/// A line-of-sight query against world geometry, implemented by the game layer with a physics trace.
/// Returns true when nothing solid lies between the two points, false when something does, and null
/// when the trace could not be made; the first null turns line of sight off for the rest of the map.
/// </summary>
public interface ILosProbe
{
    bool? Clear(double ax, double ay, double az, double bx, double by, double bz);
}

/// <summary>A change in whether an enemy is in the human's line of sight (aim.los).</summary>
public struct LosRow
{
    public int Ri, Tick, Enemy;
    /// <summary>1 = became visible, 0 = became hidden.</summary>
    public int Vis;
}

/// <summary>
/// Line of sight from the human's eye to each enemy, checked 16 times a second and recorded as
/// transitions. It replaces the engine's spotted mask, which the 2026-10-25 recordings showed is set
/// for only 53 of 93 bullet hits (app/src/stats/README.md, "Visibility").
///
/// Cost control: only the human; only every <see cref="CheckEveryTicks"/> ticks; enemies outside a
/// horizontal cone around the view or beyond <see cref="MaxDistance"/> count as hidden without a
/// trace; at most seven points per enemy (see <see cref="Points"/>), stopping at the first clear one; and a
/// per-check time budget, past which the remaining enemies keep their previous state.
/// </summary>
public sealed class LosTracker
{
    public const int Hz = 16;
    /// <summary>
    /// Half-width of the view cone. CS2's default 90° FOV is the 4:3 horizontal angle; 16:9 widens it
    /// to about 106° (53° each side). 60° leaves room for turning between checks.
    /// </summary>
    public const double HalfConeDeg = 60;
    /// <summary>Longer than any sightline on the competitive maps (Dust II's longest is about 3,500 units).</summary>
    public const double MaxDistance = 5000;
    /// <summary>
    /// Trace targets on an enemy, in order: eye, chest and waist on the body axis (height as a fraction
    /// of the view offset), then eye and chest <see cref="SideOffset"/> units to either side, across the
    /// line of sight. The side points exist because the first match recorded with line of sight
    /// (2026-10-25 17:40, de_dust2) had every unexplained miss at a corner or through the mid-doors
    /// gap, where the human hit an enemy whose body axis was covered.
    /// </summary>
    public static readonly (double Height, double Side)[] Points =
        { (1.0, 0), (0.65, 0), (0.35, 0), (1.0, -SideOffset), (1.0, SideOffset), (0.65, -SideOffset), (0.65, SideOffset) };
    /// <summary>Inside the 16-unit half-width of a player's hull: about the shoulders.</summary>
    public const double SideOffset = 12;
    /// <summary>A check makes no further trace once it has run this long.</summary>
    public const double BudgetUs = 250;
    /// <summary>A trace this close to its end point counts as clear.</summary>
    public const float ClearFraction = 0.999f;

    private readonly bool[] _vis = new bool[Limits.MaxPlayers];
    private static readonly long BudgetTicks = (long)(BudgetUs * Stopwatch.Frequency / 1_000_000);
    /// <summary>Timestamp source in <see cref="Stopwatch"/> ticks for the budget; tests replace it to make time deterministic.</summary>
    public Func<long> Clock { get; set; } = Stopwatch.GetTimestamp;

    public ILosProbe? Probe { get; private set; }
    /// <summary>Set by the first failed trace; line of sight stays off until <see cref="Attach"/>.</summary>
    public string? Failure { get; private set; }
    public bool Enabled => Probe != null && Failure == null;

    // Counters for the per-round perf row.
    public int Checks, Traces, BudgetHits;
    public long CheckTicksSum, CheckTicksMax;

    public static int CheckEveryTicks(int tickRate) => Math.Max(1, tickRate / Hz);

    public void Attach(ILosProbe? probe)
    {
        Probe = probe;
        Failure = null;
        Reset();
    }

    public void Fail(string why) => Failure ??= why;

    /// <summary>Visibility of an enemy as of the latest check (false when unknown).</summary>
    public bool IsVisible(int pi) => (uint)pi < Limits.MaxPlayers && _vis[pi];

    /// <summary>New round: everyone hidden, nothing recorded.</summary>
    public void Reset()
    {
        Array.Clear(_vis);
    }

    public void TakeCounters(out int checks, out int traces, out int budgetHits, out long sum, out long max)
    {
        checks = Checks; traces = Traces; budgetHits = BudgetHits; sum = CheckTicksSum; max = CheckTicksMax;
        Checks = Traces = BudgetHits = 0;
        CheckTicksSum = CheckTicksMax = 0;
    }

    /// <summary>
    /// A trace result as line of sight: clear when it reaches the end point. A trace that starts inside
    /// solid geometry reports fraction 1 without having travelled, so it counts as blocked.
    /// </summary>
    public static bool IsClear(float fraction, bool startInSolid) => !startInSolid && fraction >= ClearFraction;

    /// <summary>Whether an enemy direction lies inside the horizontal view cone.</summary>
    public static bool InCone(double viewYawDeg, double dx, double dy)
    {
        double yaw = Math.Atan2(dy, dx) * 180.0 / Math.PI;
        return Math.Abs(AimMath.Wrap(yaw - viewYawDeg)) <= HalfConeDeg;
    }

    /// <summary>
    /// One check. Frames for the human and enemies must be current. Transitions go to <paramref name="sink"/>.
    /// </summary>
    public void Check(int ri, int tick, int human, FrameSet frames, FixedBuffer<LosRow> sink)
    {
        if (!Enabled || (uint)human >= Limits.MaxPlayers) return;
        long t0 = Clock();
        ref var h = ref frames.ByPi[human];
        double ex = h.X, ey = h.Y, ez = h.Z + h.ViewZ;
        long deadline = t0 + BudgetTicks;
        for (int i = 0; i < frames.ActiveCount; i++)
        {
            int pi = frames.Active[i];
            if (pi == human) continue;
            ref var e = ref frames.ByPi[pi];
            bool enemy = e.Present && e.Alive && IsOpposing(h.Team, e.Team);
            if (!enemy) { Set(ri, tick, pi, false, sink); continue; }
            double dx = e.X - ex, dy = e.Y - ey;
            double dz = e.Z + e.ViewZ - ez;
            if (dx * dx + dy * dy + dz * dz > MaxDistance * MaxDistance || !InCone(h.Yaw, dx, dy))
            {
                Set(ri, tick, pi, false, sink);
                continue;
            }
            // Unit vector across the line of sight, for the side points.
            double len = Math.Sqrt(dx * dx + dy * dy);
            double sx = len > 0 ? -dy / len : 0, sy = len > 0 ? dx / len : 0;
            // The deadline is checked before every trace; an enemy not finished keeps its previous state.
            bool vis = false, done = false;
            for (int p = 0; p < Points.Length; p++)
            {
                if (Clock() >= deadline) break;
                Traces++;
                var (height, side) = Points[p];
                bool? clear = Probe!.Clear(ex, ey, ez, e.X + sx * side, e.Y + sy * side, e.Z + e.ViewZ * height);
                if (clear == null) { Fail("trace returned no result"); return; }
                if (clear.Value) { vis = true; done = true; break; }
                done = p == Points.Length - 1;
            }
            if (done) Set(ri, tick, pi, vis, sink);
            else BudgetHits++;
        }
        long dt = Clock() - t0;
        Checks++;
        CheckTicksSum += dt;
        if (dt > CheckTicksMax) CheckTicksMax = dt;
    }

    /// <summary>
    /// Marks one enemy hidden because it died at <paramref name="tick"/>. The row is stamped the next
    /// tick: the kill happened while the victim was in sight, so a read at the kill tick sees it visible
    /// whichever order the death event and the check run in within that tick.
    /// </summary>
    public void HideDead(int ri, int tick, int pi, FixedBuffer<LosRow> sink)
    {
        if ((uint)pi < Limits.MaxPlayers) Set(ri, tick + 1, pi, false, sink);
    }

    /// <summary>Marks every visible enemy hidden (round end, the human died, or line of sight turned off).</summary>
    public void HideAll(int ri, int tick, FixedBuffer<LosRow> sink)
    {
        for (int pi = 0; pi < Limits.MaxPlayers; pi++) if (_vis[pi]) Set(ri, tick, pi, false, sink);
    }

    private void Set(int ri, int tick, int pi, bool vis, FixedBuffer<LosRow> sink)
    {
        if (_vis[pi] == vis) return;
        _vis[pi] = vis;
        sink.Add(new LosRow { Ri = ri, Tick = tick, Enemy = pi, Vis = vis ? 1 : 0 });
    }

    private static bool IsOpposing(int a, int b) => (a == 2 && b == 3) || (a == 3 && b == 2);
}
