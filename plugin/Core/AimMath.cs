namespace BotMatchStats.Core;

/// <summary>
/// Source-engine angle conventions: yaw 0 faces +X, yaw 90 faces +Y, pitch is positive looking down.
/// Signed deltas are "target minus view" in that same angle space, so adding the delta to the view
/// angles points at the target: positive yaw delta = target to the left, positive pitch delta = below.
/// </summary>
public static class AimMath
{
    private const double Deg = Math.PI / 180.0;

    public static void Forward(double pitchDeg, double yawDeg, out double fx, out double fy, out double fz)
    {
        double p = pitchDeg * Deg, y = yawDeg * Deg;
        double cp = Math.Cos(p);
        fx = cp * Math.Cos(y);
        fy = cp * Math.Sin(y);
        fz = -Math.Sin(p);
    }

    /// <summary>Unsigned angle in degrees between the view and the direction (dx, dy, dz). NaN for a zero vector.</summary>
    public static double AngleToDeg(double pitchDeg, double yawDeg, double dx, double dy, double dz)
    {
        Forward(pitchDeg, yawDeg, out double fx, out double fy, out double fz);
        double len = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) return double.NaN;
        double cx = fy * dz - fz * dy, cy = fz * dx - fx * dz, cz = fx * dy - fy * dx;
        double cross = Math.Sqrt(cx * cx + cy * cy + cz * cz);
        double dot = fx * dx + fy * dy + fz * dz;
        // atan2 keeps precision for small angles, where acos(dot) loses it.
        return Math.Atan2(cross, dot) / Deg;
    }

    public static void DirToAngles(double dx, double dy, double dz, out double pitchDeg, out double yawDeg)
    {
        yawDeg = Math.Atan2(dy, dx) / Deg;
        pitchDeg = -Math.Atan2(dz, Math.Sqrt(dx * dx + dy * dy)) / Deg;
    }

    /// <summary>Wraps to the half-open range (-180, 180].</summary>
    public static double Wrap(double deg)
    {
        deg %= 360.0;
        if (deg > 180.0) deg -= 360.0;
        else if (deg <= -180.0) deg += 360.0;
        return deg;
    }

    public static void Delta(double viewPitch, double viewYaw, double dx, double dy, double dz, out double yawDelta, out double pitchDelta)
    {
        DirToAngles(dx, dy, dz, out double tp, out double ty);
        yawDelta = Wrap(ty - viewYaw);
        pitchDelta = tp - viewPitch;
    }

    public static int Centi(double deg) => double.IsNaN(deg) ? Nil.V : (int)Math.Round(deg * 100.0, MidpointRounding.AwayFromZero);

    public static int Round(double v) => double.IsNaN(v) ? Nil.V : (int)Math.Round(v, MidpointRounding.AwayFromZero);
}

public static class Spotted
{
    /// <summary>True when the engine's spotted mask (two 32-bit words) has the bit for <paramref name="slot"/>.</summary>
    public static bool IsSpottedBy(uint word0, uint word1, int slot)
    {
        if ((uint)slot >= 64) return false;
        uint w = slot < 32 ? word0 : word1;
        return ((w >> (slot & 31)) & 1u) != 0;
    }
}

/// <summary>Groups shots into bursts: a new burst starts when more than 0.3 s passed since the previous shot.</summary>
public struct BurstTracker
{
    public const double GapSeconds = 0.3;
    private int _lastTick;
    private bool _any;
    public int Burst { get; private set; }
    public int Index { get; private set; }

    public BurstTracker(int nextBurstId) { _lastTick = 0; _any = false; Burst = nextBurstId - 1; Index = 0; }

    /// <summary>Burst ids are unique within a match; the first burst gets the id passed to the constructor.</summary>
    public void Shot(int tick, int tickRate)
    {
        if (!_any || (tick - _lastTick) / (double)tickRate > GapSeconds)
        {
            Burst++;
            Index = 1;
        }
        else
        {
            Index++;
        }
        _any = true;
        _lastTick = tick;
    }

    public int NextBurstId => Burst + 1;
}

public static class DamageCap
{
    /// <summary>
    /// Damage dealt, capped at the victim's HP before the hit. When the victim survives, the HP before
    /// the hit is exactly <c>healthAfter + dmgHealth</c>, so no cap applies. When the hit is lethal,
    /// the HP before it comes from tracking (<paramref name="trackedHp"/>); if that is unknown the
    /// raw damage is capped at 100 and <paramref name="unknown"/> is set so the file can report it.
    /// </summary>
    public static int Cap(int dmgHealth, int healthAfter, int trackedHp, out int preHp, out bool unknown)
    {
        unknown = false;
        if (dmgHealth < 0) dmgHealth = 0;
        if (healthAfter > 0)
        {
            preHp = healthAfter + dmgHealth;
            return dmgHealth;
        }
        if (trackedHp == Nil.V)
        {
            unknown = true;
            preHp = Nil.V;
            return Math.Min(dmgHealth, 100);
        }
        preHp = trackedHp;
        return Math.Min(dmgHealth, Math.Max(trackedHp, 0));
    }
}

public static class RoundResult
{
    public const int HowElim = 0, HowDefuse = 1, HowTime = 2, HowBomb = 3;
    public static readonly string[] HowNames = { "elim", "defuse", "time", "bomb" };

    /// <summary>
    /// Maps <c>CCSGameRules.m_iMatchStats_RoundResults</c> codes. Verified codes: 1 CT win by
    /// elimination, 3 bomb defused, 4 time ran out (CT win), 5 T win by elimination, 6 bomb exploded.
    /// Any other code returns false; callers log it and leave winSide/how null.
    /// </summary>
    public static bool FromMatchStatsCode(int code, out int winSide, out int how)
    {
        switch (code)
        {
            case 1: winSide = 3; how = HowElim; return true;
            case 3: winSide = 3; how = HowDefuse; return true;
            case 4: winSide = 3; how = HowTime; return true;
            case 5: winSide = 2; how = HowElim; return true;
            case 6: winSide = 2; how = HowBomb; return true;
            default: winSide = Nil.V; how = Nil.V; return false;
        }
    }

    /// <summary>
    /// Maps the round_end event's reason, used only as a cross-check. Values seen in
    /// fixtures/events_two_matches.jsonl: 1 bomb exploded, 7 defused, 8 CT elimination,
    /// 9 T elimination, 12 time ran out.
    /// </summary>
    public static bool FromEventReason(int reason, out int how)
    {
        switch (reason)
        {
            case 1: how = HowBomb; return true;
            case 7: how = HowDefuse; return true;
            case 8: how = HowElim; return true;
            case 9: how = HowElim; return true;
            case 12: how = HowTime; return true;
            default: how = Nil.V; return false;
        }
    }
}

public static class Sides
{
    /// <summary>
    /// The side a player had in round 0, derived from the side in round <paramref name="ri"/>.
    /// Regulation halves swap once at maxRounds/2 when halftime is enabled; overtime is not derived.
    /// </summary>
    public static int StartSide(int side, int ri, int maxRounds, bool halftime)
    {
        if (side != 2 && side != 3) return Nil.V;
        if (maxRounds <= 0 || ri < 0) return Nil.V;
        if (ri >= maxRounds) return Nil.V;
        if (!halftime || ri < maxRounds / 2) return side;
        return side == 2 ? 3 : 2;
    }
}
