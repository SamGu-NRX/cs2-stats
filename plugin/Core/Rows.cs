namespace BotMatchStats.Core;

/// <summary>
/// Rows store "unknown" as <see cref="V"/> instead of Nullable so that row structs stay small and
/// copyable; the encoder turns it into JSON null. 0 is never used for a missing value.
/// </summary>
public static class Nil
{
    public const int V = int.MinValue;
}

public static class Limits
{
    /// <summary>Upper bound on distinct players per match; per-round arrays are sized to it.</summary>
    public const int MaxPlayers = 64;
    public const int StateLen = 8;
}

public enum Outcome : byte { None = 0, Kill = 1, Died = 2 }

/// <summary>Detonation types. Molotov covers both the molotov and the incendiary (inferno_startburn).</summary>
public enum GrenadeType : byte { He = 0, Flash = 1, Smoke = 2, Molotov = 3, Decoy = 4 }

/// <summary>Grenade items as thrown, bought or held; distinguishes molotov from incendiary because their prices differ.</summary>
public enum UtilType : byte { He = 0, Flash = 1, Smoke = 2, Molotov = 3, Incendiary = 4, Decoy = 5 }

/// <summary>Grenades a player holds, by <see cref="UtilType"/>.</summary>
public struct UtilCounts
{
    public const int Types = 6;
    public bool Known;
    public int He, Flash, Smoke, Molotov, Incendiary, Decoy;

    public int this[int t]
    {
        readonly get => t switch { 0 => He, 1 => Flash, 2 => Smoke, 3 => Molotov, 4 => Incendiary, _ => Decoy };
        set { switch (t) { case 0: He = value; break; case 1: Flash = value; break; case 2: Smoke = value; break; case 3: Molotov = value; break; case 4: Incendiary = value; break; default: Decoy = value; break; } }
    }
}

public struct KillRow
{
    public int Ri, Tick, Killer, Victim, Assister, FlashAssister, Weapon, Flags;
    public int KX, KY, KZ, VX, VY, VZ; // KX == Nil.V means no killer position
    public int CtAlive, TAlive, CtHp, THp, CtEquip, TEquip, Planted, SincePlant;
    /// <summary>Index into the grenades table for HE and inferno kills, else Nil.</summary>
    public int Nade;
    /// <summary>Grenades the victim held when it died.</summary>
    public UtilCounts VUtil;
    /// <summary>When the killer or victim controlled a bot's pawn: the pi of that bot, else Nil.</summary>
    public int KBody, VBody;
}

/// <summary>
/// Validation data for IsVisibleToHuman: the victim's raw spotted state when the human damaged it.
/// A hit implies the human could see the victim in most cases, so these rows show which mask bit
/// (if any) tracks the human.
/// </summary>
public struct HitMaskRow
{
    public int Ri, Tick, Victim;
    public uint M0, M1;
    public bool Spotted;
}

/// <summary>A player leaving the server during a recorded round.</summary>
public struct LeaveRow
{
    public int Ri, Tick, Pi, Alive;
}

public struct DamageRow
{
    public int Ri, Tick, Attacker, Victim, Dmg, DmgArmor, Weapon, Hitgroup;
    /// <summary>Index into the grenades table for HE and inferno damage, else Nil.</summary>
    public int Nade;
}

public struct BlindRow
{
    public int Ri, Tick, Attacker, Victim, Ms;
    /// <summary>Index into the grenades table of the flash that caused it, else Nil.</summary>
    public int Flash;
}

/// <summary>A detonation (he, flash, smoke, molotov/incendiary fire, decoy).</summary>
public struct GrenadeRow
{
    public int Ri, Tick, Thrower, X, Y, Z;
    /// <summary>Index into the throws table of the throw that produced it, else Nil.</summary>
    public int Throw;
    public GrenadeType Type;
}

/// <summary>A grenade_thrown event; position is the thrower's origin.</summary>
public struct ThrowRow
{
    public int Ri, Tick, Thrower, X, Y, Z;
    public UtilType Type;
}

public struct PosRow
{
    public int Ri, Tick, Pi, X, Y, Z, Place, Alive;
}

public struct EngagementRow
{
    public int Ri, Enemy, TVis, AngVis, AngVisYaw, AngVisPitch, Dist, TAimStart, TFirstShot, TFirstDmg, TEnd;
    public Outcome Outcome;
}

public struct ShotRow
{
    public int Ri, Tick, Weapon, Burst, Idx, Speed, MaxSpeed, Target, AimErrYaw, AimErrPitch, ImpYaw, ImpPitch, Hit;
    public bool Scoped, Ducked;
    /// <summary>1 if the view ray (to the target, else 4096 units) crosses an active smoke, else 0.</summary>
    public int Smoke;
    /// <summary>bullet_impact events in this shot's tick.</summary>
    public int Impacts;
    /// <summary>1 = damaged an enemy after penetrating, 0 = did not, Nil = a non-fatal hit whose path is unknown.</summary>
    public int Pen;
    /// <summary>1/0 whether the target was visible to the human; Nil without a target.</summary>
    public int VisTarget;
    /// <summary>WeaponClass of the weapon, or Nil.</summary>
    public int Class;
    /// <summary>
    /// The human's view at the fire tick: m_angEyeAngles, degrees, pitch down positive, without aim
    /// punch (m_aimPunchAngle is a separate field). NaN when the human's frame was not readable.
    /// </summary>
    public float Pitch, Yaw;
}

public enum ReconField : byte { Kills = 0, Deaths = 1, Assists = 2, Damage = 3 }

public struct ReconMismatch
{
    public int Ri, Pi, Ours, Game, Hits;
    public ReconField Field;
}

public struct ReconRound
{
    public int Ri, Checked, KillsOk, DeathsOk, AssistsOk, DamageOk, Missing;
}

public struct PerfRow
{
    public int Ri, Ticks, Events, Gen0;
    public double TickAvgUs, TickMaxUs, EventAvgUs, EventMaxUs;
    public long TickAllocBytes, EventAllocBytes;
    public string? EventMaxName;
    /// <summary>Line-of-sight checks this round, traces made, checks cut short by the time budget, and µs per check.</summary>
    public int LosChecks, LosTraces, LosBudgetHits;
    public double LosAvgUs, LosMaxUs;
}

/// <summary>One entry of the rounds table. Reused across rounds; copy with <see cref="CopyFrom"/>.</summary>
public sealed class RoundRow
{
    public int Ri = Nil.V, WinSide = Nil.V, How = Nil.V, FreezeTick = Nil.V, DurTicks = Nil.V;
    public int BombSite = Nil.V, PlantTick = Nil.V, Planter = Nil.V, Defuser = Nil.V;
    public int ScoreT = Nil.V, ScoreCt = Nil.V;
    public bool HasCtSetup;
    public readonly int[] CtSetup = new int[CtSetupCounter.Areas];
    public readonly int[] Side = new int[Limits.MaxPlayers];
    public readonly int[] Equip = new int[Limits.MaxPlayers];
    public readonly int[] Money = new int[Limits.MaxPlayers];
    public readonly int[] EquipEnd = new int[Limits.MaxPlayers];
    public readonly int[] SurvPrimary = new int[Limits.MaxPlayers];
    /// <summary>Grenades bought this round, [pi * UtilCounts.Types + type].</summary>
    public readonly int[] UtilBought = new int[Limits.MaxPlayers * UtilCounts.Types];
    /// <summary>Money spent on grenades this round; Nil when a purchase price could not be read.</summary>
    public readonly int[] UtilSpent = new int[Limits.MaxPlayers];
    /// <summary>1 if alive at freeze end, 0 if dead; Nil if absent.</summary>
    public readonly int[] Alive0 = new int[Limits.MaxPlayers];
    /// <summary>Where equip values came from: 0 pawn field, 1 inventory prices, Nil unknown.</summary>
    public int EquipSrc = Nil.V;

    public RoundRow() => Reset(Nil.V);

    public void Reset(int ri)
    {
        Ri = ri;
        WinSide = How = FreezeTick = DurTicks = BombSite = PlantTick = Planter = Defuser = ScoreT = ScoreCt = Nil.V;
        HasCtSetup = false;
        Array.Clear(CtSetup);
        Array.Fill(Side, Nil.V);
        Array.Fill(Equip, Nil.V);
        Array.Fill(Money, Nil.V);
        Array.Fill(EquipEnd, Nil.V);
        Array.Fill(SurvPrimary, Nil.V);
        Array.Clear(UtilBought);
        Array.Clear(UtilSpent);
        Array.Fill(Alive0, Nil.V);
        EquipSrc = Nil.V;
    }

    public void CopyFrom(RoundRow o)
    {
        Ri = o.Ri; WinSide = o.WinSide; How = o.How; FreezeTick = o.FreezeTick; DurTicks = o.DurTicks;
        BombSite = o.BombSite; PlantTick = o.PlantTick; Planter = o.Planter; Defuser = o.Defuser;
        ScoreT = o.ScoreT; ScoreCt = o.ScoreCt; HasCtSetup = o.HasCtSetup;
        o.CtSetup.CopyTo(CtSetup, 0);
        o.Side.CopyTo(Side, 0);
        o.Equip.CopyTo(Equip, 0);
        o.Money.CopyTo(Money, 0);
        o.EquipEnd.CopyTo(EquipEnd, 0);
        o.SurvPrimary.CopyTo(SurvPrimary, 0);
        o.UtilBought.CopyTo(UtilBought, 0);
        o.UtilSpent.CopyTo(UtilSpent, 0);
        o.Alive0.CopyTo(Alive0, 0);
        EquipSrc = o.EquipSrc;
    }
}
