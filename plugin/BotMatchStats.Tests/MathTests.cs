using BotMatchStats.Core;

namespace BotMatchStats.Tests;

public class AimMathTests
{
    [Fact]
    public void TargetStraightAheadIsZeroDegrees()
    {
        // View pitch 0, yaw 90 faces +Y.
        Assert.Equal(0.0, AimMath.AngleToDeg(0, 90, 0, 100, 0), 9);
    }

    [Fact]
    public void TargetTenRightAtHundredIsAtanPointOne()
    {
        // Facing +Y, the right-hand side is +X.
        double expected = Math.Atan(0.1) * 180 / Math.PI; // 5.710593137499643
        Assert.Equal(expected, AimMath.AngleToDeg(0, 90, 10, 100, 0), 9);
        AimMath.Delta(0, 90, 10, 100, 0, out double yaw, out double pitch);
        Assert.Equal(-expected, yaw, 9); // negative yaw delta = target to the right
        Assert.Equal(0.0, pitch, 9);
    }

    [Fact]
    public void TargetBelowHasPositivePitchDelta()
    {
        Assert.Equal(45.0, AimMath.AngleToDeg(0, 0, 100, 0, -100), 9);
        AimMath.Delta(0, 0, 100, 0, -100, out double yaw, out double pitch);
        Assert.Equal(0.0, yaw, 9);
        Assert.Equal(45.0, pitch, 9);
    }

    [Fact]
    public void LookingDownAtTargetBelowIsZero()
    {
        Assert.Equal(0.0, AimMath.AngleToDeg(45, 0, 100, 0, -100), 9);
    }

    [Fact]
    public void TargetBehindIs180()
    {
        Assert.Equal(180.0, AimMath.AngleToDeg(0, 0, -50, 0, 0), 9);
    }

    [Fact]
    public void TinyAnglesKeepPrecision()
    {
        // acos(dot) would return 0 here; atan2(|cross|, dot) keeps the 5.7e-5 degree answer.
        double expected = Math.Atan(1e-3 / 1000) * 180 / Math.PI;
        Assert.Equal(expected, AimMath.AngleToDeg(0, 90, 1e-3, 1000, 0), 12);
    }

    [Fact]
    public void YawDeltaWrapsAcross180()
    {
        // View yaw 170, target at yaw -170: shortest turn is +20 (left).
        double rad = -170 * Math.PI / 180;
        AimMath.Delta(0, 170, Math.Cos(rad), Math.Sin(rad), 0, out double yaw, out _);
        Assert.Equal(20.0, yaw, 9);
    }

    [Theory]
    [InlineData(190, -170)]
    [InlineData(-190, 170)]
    [InlineData(180, 180)]
    [InlineData(-180, 180)]
    [InlineData(540, 180)]
    [InlineData(0, 0)]
    public void Wrap(double input, double expected) => Assert.Equal(expected, AimMath.Wrap(input), 9);

    [Fact]
    public void ZeroVectorIsNaN() => Assert.True(double.IsNaN(AimMath.AngleToDeg(0, 0, 0, 0, 0)));

    [Theory]
    [InlineData(5.710593137499643, 571)]
    [InlineData(-5.710593137499643, -571)]
    [InlineData(0.005, 1)]
    [InlineData(-0.005, -1)]
    public void CentiRoundsAwayFromZero(double deg, int expected) => Assert.Equal(expected, AimMath.Centi(deg));

    [Fact]
    public void CentiOfNaNIsNil() => Assert.Equal(Nil.V, AimMath.Centi(double.NaN));

    [Fact]
    public void ForwardMatchesEngineConvention()
    {
        AimMath.Forward(0, 90, out double x, out double y, out double z);
        Assert.Equal(0, x, 12); Assert.Equal(1, y, 12); Assert.Equal(0, z, 12);
        AimMath.Forward(90, 0, out x, out y, out z);
        Assert.Equal(0, x, 12); Assert.Equal(0, y, 12); Assert.Equal(-1, z, 12); // pitch +90 looks straight down
    }
}

public class SpottedTests
{
    [Theory]
    [InlineData(0b1u, 0u, 0, true)]
    [InlineData(0b10u, 0u, 0, false)]
    [InlineData(0b10u, 0u, 1, true)]
    [InlineData(0x8000_0000u, 0u, 31, true)]
    [InlineData(0u, 0b10u, 33, true)]
    [InlineData(0xFFFF_FFFFu, 0u, 33, false)]
    [InlineData(0u, 0x8000_0000u, 63, true)]
    [InlineData(0xFFFF_FFFFu, 0xFFFF_FFFFu, 64, false)]
    [InlineData(0xFFFF_FFFFu, 0xFFFF_FFFFu, -1, false)]
    public void BitForSlot(uint w0, uint w1, int slot, bool expected) => Assert.Equal(expected, Spotted.IsSpottedBy(w0, w1, slot));
}

public class BurstTests
{
    [Fact]
    public void NewBurstOnlyAfterMoreThanPointThreeSeconds()
    {
        var b = new BurstTracker(7);
        b.Shot(1000, 64); Assert.Equal((7, 1), (b.Burst, b.Index));
        b.Shot(1006, 64); Assert.Equal((7, 2), (b.Burst, b.Index));
        b.Shot(1025, 64); Assert.Equal((7, 3), (b.Burst, b.Index)); // 19 ticks = 0.297 s
        b.Shot(1045, 64); Assert.Equal((8, 1), (b.Burst, b.Index)); // 20 ticks = 0.3125 s
        b.Shot(1045, 64); Assert.Equal((8, 2), (b.Burst, b.Index));
        Assert.Equal(9, b.NextBurstId);
    }
}

public class DamageCapTests
{
    [Fact]
    public void NonLethalHitIsNotCapped()
    {
        Assert.Equal(30, DamageCap.Cap(30, 70, 100, out int pre, out bool unknown));
        Assert.Equal(100, pre);
        Assert.False(unknown);
    }

    [Fact]
    public void NonLethalHitTrustsEventOverStaleTracking()
    {
        Assert.Equal(30, DamageCap.Cap(30, 40, 100, out int pre, out _));
        Assert.Equal(70, pre);
    }

    [Fact]
    public void LethalHitIsCappedAtTrackedHp()
    {
        Assert.Equal(45, DamageCap.Cap(120, 0, 45, out int pre, out bool unknown));
        Assert.Equal(45, pre);
        Assert.False(unknown);
    }

    [Fact]
    public void LethalHitWithUnknownHpIsFlagged()
    {
        Assert.Equal(100, DamageCap.Cap(448, 0, Nil.V, out int pre, out bool unknown));
        Assert.Equal(Nil.V, pre);
        Assert.True(unknown);
    }

    [Fact]
    public void NegativeDamageIsZero() => Assert.Equal(0, DamageCap.Cap(-5, 50, 50, out _, out _));
}

public class RoundResultTests
{
    [Theory]
    [InlineData(1, 3, RoundResult.HowElim)]
    [InlineData(3, 3, RoundResult.HowDefuse)]
    [InlineData(4, 3, RoundResult.HowTime)]
    [InlineData(5, 2, RoundResult.HowElim)]
    [InlineData(6, 2, RoundResult.HowBomb)]
    public void KnownCodes(int code, int side, int how)
    {
        Assert.True(RoundResult.FromMatchStatsCode(code, out int s, out int h));
        Assert.Equal(side, s);
        Assert.Equal(how, h);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(7)]
    [InlineData(-1)]
    public void UnknownCodesAreNotGuessed(int code)
    {
        Assert.False(RoundResult.FromMatchStatsCode(code, out int s, out int h));
        Assert.Equal(Nil.V, s);
        Assert.Equal(Nil.V, h);
    }

    [Theory]
    [InlineData(1, RoundResult.HowBomb)]
    [InlineData(7, RoundResult.HowDefuse)]
    [InlineData(8, RoundResult.HowElim)]
    [InlineData(9, RoundResult.HowElim)]
    [InlineData(12, RoundResult.HowTime)]
    public void EventReasons(int reason, int how)
    {
        Assert.True(RoundResult.FromEventReason(reason, out int h));
        Assert.Equal(how, h);
    }

    [Fact]
    public void GameCommencingReasonIsUnknown() => Assert.False(RoundResult.FromEventReason(16, out _));
}

public class ReconTests
{
    [Theory]
    [InlineData(99, 100, 3, true)]
    [InlineData(100, 100, 0, true)]
    [InlineData(97, 100, 3, true)]
    [InlineData(96, 100, 3, false)]
    [InlineData(101, 100, 5, false)]
    public void DamageBound(int ours, int game, int hits, bool ok) => Assert.Equal(ok, Recon.DamageOk(ours, game, hits));

    [Fact]
    public void CompareFlagsEachField()
    {
        var ours = new Tally { Kills = 2, Deaths = 1, Assists = 0, Damage = 150, Hits = 4 };
        Assert.Equal(0, Recon.Compare(ours, new GameRoundStats { Kills = 2, Deaths = 1, Assists = 0, Damage = 152 }));
        Assert.Equal(1 | 4 | 8, Recon.Compare(ours, new GameRoundStats { Kills = 3, Deaths = 1, Assists = 1, Damage = 160 }));
        Assert.Equal(2, Recon.Compare(ours, new GameRoundStats { Kills = 2, Deaths = 0, Assists = 0, Damage = 150 }));
    }
}

public class SidesTests
{
    [Theory]
    [InlineData(2, 0, 24, true, 2)]
    [InlineData(3, 11, 24, true, 3)]
    [InlineData(3, 12, 24, true, 2)]
    [InlineData(2, 23, 24, true, 3)]
    [InlineData(2, 24, 24, true, Nil.V)]
    [InlineData(2, 20, 24, false, 2)]
    [InlineData(1, 0, 24, true, Nil.V)]
    [InlineData(2, 3, Nil.V, true, Nil.V)]
    public void StartSide(int side, int ri, int maxRounds, bool halftime, int expected) =>
        Assert.Equal(expected, Sides.StartSide(side, ri, maxRounds, halftime));
}
