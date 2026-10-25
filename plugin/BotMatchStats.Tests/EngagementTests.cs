using BotMatchStats.Core;

namespace BotMatchStats.Tests;

public class EngagementTests
{
    private readonly EngagementTracker _t = new(64);
    private readonly FixedBuffer<EngagementRow> _out = new(16);

    private void See(int tick, int enemy, double angle) => _t.Observe(3, tick, enemy, true, angle, -angle, 1.5, 812.4, _out);
    private void Miss(int tick, int enemy) => _t.Observe(3, tick, enemy, false, double.NaN, 0, 0, 0, _out);

    [Fact]
    public void OpensWithVisibilityValues()
    {
        See(100, 4, 20.004);
        Assert.True(_t.IsVisibleOpen(4));
        _t.CloseAll(150, _out);
        var r = Assert.Single(_out.Span.ToArray());
        Assert.Equal((3, 4, 100, 2000, -2000, 150, 812), (r.Ri, r.Enemy, r.TVis, r.AngVis, r.AngVisYaw, r.AngVisPitch, r.Dist));
        Assert.Equal((Nil.V, Nil.V, Nil.V, 150, Outcome.None), (r.TAimStart, r.TFirstShot, r.TFirstDmg, r.TEnd, r.Outcome));
    }

    [Fact]
    public void AimStartAtExactlyThirtyDegreesPerSecond()
    {
        See(100, 1, 20);
        See(101, 1, 19.75); // 16 deg/s: not yet
        See(102, 1, 19.28125); // 0.46875 deg in one tick = 30 deg/s exactly (all values exact in binary)
        _t.CloseAll(110, _out);
        Assert.Equal(102, _out[0].TAimStart);
    }

    [Fact]
    public void AimStartUsesElapsedTicks()
    {
        See(100, 1, 20);
        See(104, 1, 18.2); // 1.8 deg over 4 ticks = 28.8 deg/s
        See(106, 1, 17.2); // 1.0 deg over 2 ticks = 32 deg/s
        _t.CloseAll(110, _out);
        Assert.Equal(106, _out[0].TAimStart);
    }

    [Fact]
    public void GapsUnderOneSecondContinueTheEngagement()
    {
        See(100, 2, 10);
        Miss(110, 2);
        Miss(173, 2); // 63 ticks of gap
        See(173, 2, 9);
        Assert.Equal(0, _out.Count);
        Miss(180, 2);
        Miss(243, 2);
        Assert.Equal(0, _out.Count);
        Miss(244, 2); // 64 ticks = 1 s since it stopped being visible
        var r = Assert.Single(_out.Span.ToArray());
        Assert.Equal((100, 180, Outcome.None), (r.TVis, r.TEnd, r.Outcome));
        See(250, 2, 30);
        Assert.True(_t.IsVisibleOpen(2));
    }

    [Fact]
    public void AngleRateResetsAfterGap()
    {
        See(100, 2, 40);
        Miss(101, 2);
        See(120, 2, 10); // big drop across the gap must not count as aiming
        See(121, 2, 9.9);
        _t.CloseAll(130, _out);
        Assert.Equal(Nil.V, _out[0].TAimStart);
    }

    [Fact]
    public void KillByHumanAndOtherDeaths()
    {
        See(100, 1, 5); See(100, 2, 5); See(100, 3, 5);
        Miss(120, 3);
        _t.EnemyDied(130, 1, byHuman: true, _out);
        _t.EnemyDied(131, 2, byHuman: false, _out);
        _t.EnemyDied(132, 3, byHuman: true, _out); // died during a gap: tEnd is when it stopped being visible
        var rows = _out.Span.ToArray();
        Assert.Equal((1, 130, Outcome.Kill), (rows[0].Enemy, rows[0].TEnd, rows[0].Outcome));
        Assert.Equal((2, 131, Outcome.None), (rows[1].Enemy, rows[1].TEnd, rows[1].Outcome));
        Assert.Equal((3, 120, Outcome.Kill), (rows[2].Enemy, rows[2].TEnd, rows[2].Outcome));
    }

    [Fact]
    public void HumanDeathClosesAllAsDied()
    {
        See(100, 1, 5); See(100, 6, 5);
        _t.HumanDied(140, _out);
        Assert.All(_out.Span.ToArray(), r => Assert.Equal(Outcome.Died, r.Outcome));
        Assert.Equal(2, _out.Count);
        Assert.False(_t.IsActive(1));
    }

    [Fact]
    public void FirstShotNeedsVisibilityAndTenDegrees()
    {
        See(100, 1, 30);
        _t.Shot(101, 1, 10.01);
        _t.Shot(102, 1, 10.0);
        _t.Shot(103, 1, 1.0);
        Miss(104, 1);
        _t.Shot(105, 1, 0.5); // not visible: ignored, but the gap keeps the engagement
        _t.Damage(106, 1);
        _t.Damage(107, 1);
        _t.CloseAll(200, _out);
        Assert.Equal((102, 106, 104), (_out[0].TFirstShot, _out[0].TFirstDmg, _out[0].TEnd));
    }
}
