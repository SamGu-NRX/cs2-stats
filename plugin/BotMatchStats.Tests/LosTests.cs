using System.Text.Json;
using BotMatchStats.Core;

namespace BotMatchStats.Tests;

/// <summary>A probe with a scripted answer per enemy height; counts calls.</summary>
internal sealed class FakeProbe : ILosProbe
{
    public Func<double, double, double, bool?> Answer = (_, _, _) => true;
    public int Calls;
    public bool? Clear(double ax, double ay, double az, double bx, double by, double bz)
    {
        Calls++;
        return Answer(bx, by, bz);
    }
}

public class LosTests
{
    private const int H = 0, E1 = 1, E2 = 2, Mate = 3; // human CT at the origin looking along +x
    private readonly FrameSet _f = new();
    private readonly FixedBuffer<LosRow> _rows = new(64);
    private readonly LosTracker _los = new();
    private readonly FakeProbe _probe = new();
    private long _now; // the tracker's clock, in Stopwatch ticks; it only moves when a test moves it

    public LosTests()
    {
        _los.Attach(_probe);
        _los.Clock = () => _now;
        _f.ActiveCount = 4;
        for (int i = 0; i < 4; i++) _f.Active[i] = i;
        _f.ByPi[H] = new PlayerFrame { Present = true, Alive = true, Team = 3, ViewZ = 64, Yaw = 0 };
        _f.ByPi[E1] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 1000, ViewZ = 64 };
        _f.ByPi[E2] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 800, Y = 300, ViewZ = 64 };
        _f.ByPi[Mate] = new PlayerFrame { Present = true, Alive = true, Team = 3, X = 500, ViewZ = 64 };
    }

    [Fact]
    public void RecordsOnlyTransitions()
    {
        _los.Check(0, 100, H, _f, _rows);
        _los.Check(0, 104, H, _f, _rows);
        _probe.Answer = (x, _, _) => x != 1000; // E1 hidden behind a wall
        _los.Check(0, 108, H, _f, _rows);
        var r = _rows.Span.ToArray();
        Assert.Equal(new[] { (100, E1, 1), (100, E2, 1), (108, E1, 0) }, r.Select(x => (x.Tick, x.Enemy, x.Vis)));
        Assert.False(_los.IsVisible(E1));
        Assert.True(_los.IsVisible(E2));
        Assert.False(_los.IsVisible(Mate));
    }

    [Fact]
    public void TriesEyeThenChestThenWaistAndStopsAtTheFirstClearPoint()
    {
        var heights = new List<double>();
        _probe.Answer = (x, _, z) => { if (x == 1000) heights.Add(z); return x == 1000 && z < 50; };
        _f.ByPi[E2].Alive = false;
        _los.Check(0, 100, H, _f, _rows);
        Assert.Equal(new[] { 64.0, 64 * 0.65 }, heights.Take(2));
        Assert.Equal(2, heights.Count); // chest (41.6) is clear, waist not traced
        Assert.True(_los.IsVisible(E1));
    }

    [Fact]
    public void OutsideTheViewConeOrBeyondRangeIsHiddenWithoutATrace()
    {
        _f.ByPi[E1].X = -1000; // behind
        _f.ByPi[E2].X = 6000; _f.ByPi[E2].Y = 0; // too far
        _los.Check(0, 100, H, _f, _rows);
        Assert.Equal(0, _probe.Calls);
        Assert.Equal(0, _rows.Count);
        Assert.True(LosTracker.InCone(0, 100, 100 * Math.Tan(59 * Math.PI / 180)));
        Assert.False(LosTracker.InCone(0, 100, 100 * Math.Tan(61 * Math.PI / 180)));
        Assert.True(LosTracker.InCone(179, -100, -1)); // wraps across ±180
    }

    [Fact]
    public void AFailedTraceTurnsLineOfSightOff()
    {
        _probe.Answer = (_, _, _) => null;
        _los.Check(0, 100, H, _f, _rows);
        Assert.False(_los.Enabled);
        Assert.Equal("trace returned no result", _los.Failure);
        _los.Check(0, 104, H, _f, _rows);
        Assert.Equal(1, _probe.Calls);
    }

    /// <summary>Fails if a check keeps tracing after a slow trace has passed its deadline (the budget checked only between enemies).</summary>
    [Fact]
    public void ASlowTraceStopsTheCheckAndUndecidedEnemiesKeepTheirState()
    {
        _los.Check(0, 100, H, _f, _rows); // both enemies visible
        int calls = _probe.Calls;
        _probe.Answer = (_, _, _) => { _now += System.Diagnostics.Stopwatch.Frequency; return false; }; // each trace takes 1 s and is blocked
        _los.Check(0, 104, H, _f, _rows);
        Assert.Equal(calls + 1, _probe.Calls);        // E1's eye point only: no chest or waist, nothing for E2
        Assert.Equal(2, _los.BudgetHits);
        Assert.True(_los.IsVisible(E1) && _los.IsVisible(E2));
        Assert.Equal(2, _rows.Count);                  // no hidden transition from an unfinished check
    }

    [Fact]
    public void ATraceThatStartsInSolidIsBlocked()
    {
        Assert.True(LosTracker.IsClear(1f, startInSolid: false));
        Assert.False(LosTracker.IsClear(1f, startInSolid: true));
        Assert.False(LosTracker.IsClear(0.5f, startInSolid: false));
    }

    /// <summary>
    /// Fails if an enemy whose body axis is covered but whose shoulder shows reads hidden. Positions are
    /// the human and victim at round 0, tick 3529 of the 2026-10-25 17:40 match: a head-shot kill without
    /// penetration through mid doors that line of sight called hidden for the preceding 115 ticks.
    /// </summary>
    [Fact]
    public void AnEnemyShowingOnlyAShoulderIsVisible()
    {
        var f = new FrameSet { ActiveCount = 2 };
        f.Active[0] = H; f.Active[1] = E1;
        f.ByPi[H] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = -279, Y = 1122, Z = -76, ViewZ = 64, Yaw = 108 };
        f.ByPi[E1] = new PlayerFrame { Present = true, Alive = true, Team = 3, X = -467, Y = 1684, Z = -125, ViewZ = 64 };
        // Cover hides every point on the victim's axis; a point to one side is clear.
        var ends = new List<(double X, double Y)>();
        _probe.Answer = (x, y, _) => { ends.Add((x, y)); return Math.Abs(x - -467) > 1 || Math.Abs(y - 1684) > 1; };
        _los.Check(0, 3528, H, f, _rows);
        Assert.True(_los.IsVisible(E1));
        Assert.Equal(LosTracker.Points.Count(p => p.Side == 0) + 1, _probe.Calls); // three axis points, then the first side point
        // The side point sits 12 units from the body axis, at right angles to the human-to-victim ray
        // (world-axis offsets, or offsets along the enemy's facing, would not).
        var (sx, sy) = (ends[^1].X - -467, ends[^1].Y - 1684);
        var (rx, ry) = (-467.0 - -279, 1684.0 - 1122);
        Assert.Equal(LosTracker.SideOffset, Math.Sqrt(sx * sx + sy * sy), 6);
        Assert.Equal(0, (sx * rx + sy * ry) / Math.Sqrt(rx * rx + ry * ry), 6);
    }

    [Fact]
    public void ChecksRunSixteenTimesASecond() => Assert.Equal(4, LosTracker.CheckEveryTicks(64));
}

public class RecorderLosTests
{
    private readonly ListSink _sink = new();
    private readonly FrameSet _frames = new();
    private readonly FakeProbe _probe = new();
    private readonly List<string> _warnings = new();
    private readonly Recorder _r;
    private const int H = 0, B = 1;

    public RecorderLosTests()
    {
        _r = new Recorder(_sink, _frames, new PerfCounter(), _warnings.Add);
        _r.AttachLos(_probe);
        _r.Los.Clock = () => 0;
        _r.StartCapture(new MatchMeta { Id = "0123456789abcdef0123456789abcdef", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { Plugin = "t", MaxRounds = 24 } });
        _r.PlayerIndex("76561190000000001", "me", false);
        _r.PlayerIndex("B:Rock", "Rock", true);
        _r.SetHuman(H);
        _r.BeginRound(0, 1000, 0, 0, partial: false, Nil.V);
        _r.SetFreezePlayer(H, 3, 800, 1000, 100, true);
        _r.SetFreezePlayer(B, 2, 1000, 900, 100, true);
        _r.FreezeEnd(2000);
        _frames.ActiveCount = 2;
        _frames.Active[0] = H; _frames.Active[1] = B;
        _frames.ByPi[H] = new PlayerFrame { Present = true, Alive = true, Team = 3, ViewZ = 64 };
        _frames.ByPi[B] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 900, ViewZ = 64, Spot0 = 0 };
    }

    private void Ticks(int from, int to) { for (int t = from; t < to; t++) _r.Tick(t); }

    [Fact]
    public void EngagementsAndVisTargetFollowLineOfSightNotTheMask()
    {
        Ticks(2000, 2010);
        _r.Shot(new ShotInput { Tick = 2010, Weapon = 0, Class = 0, Speed = 0, MaxSpeed = 215 });
        _probe.Answer = (_, _, _) => false;
        Ticks(2010, 2200);
        _r.RoundEnd(2200, 3, 8);
        _r.Finalize(1, 2264);
        var s = _sink.Store;
        Assert.Equal(new[] { (2000, 1), (2012, 0) }, s.Los.Span.ToArray().Select(x => (x.Tick, x.Vis)));
        var e = Assert.Single(s.Engagements.Span.ToArray());
        Assert.Equal(2000, e.TVis);
        Assert.Equal(1, s.Shots[0].VisTarget); // the spotted mask (Spot0 = 0) would have said 0
        Assert.Equal("los", s.Meta.Env.VisSource);
        var perf = s.Perf[0];
        Assert.Equal((50, 3 + LosTracker.Points.Length * 47), (perf.LosChecks, perf.LosTraces)); // 2000..2196 every 4 ticks; blocked checks trace every point
    }

    /// <summary>
    /// Fails if a read at the kill tick sees the victim hidden, in either order of the death event and
    /// a check in the same tick (2004 is a scheduled check: freeze 2000, every 4 ticks). The 2026-10-25
    /// 17:40 match had 0 of 20 kills visible at the kill tick and 17 of 20 one tick earlier.
    /// </summary>
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AKilledEnemyIsVisibleAtTheKillTickAndHiddenAfter(bool deathEventFirst)
    {
        Ticks(2000, 2004);
        var kill = new KillInput { Tick = 2004, Killer = H, Victim = B, Assister = Nil.V, Weapon = 0, NadeType = Nil.V };
        _frames.ByPi[B].Alive = false; // the pawn is dead for the whole of tick 2004
        if (deathEventFirst) { _r.Kill(kill); _r.Tick(2004); }
        else { _r.Tick(2004); _r.Kill(kill); }
        Ticks(2005, 2012);
        _r.Flush();
        Assert.Equal(new[] { (2000, 1), (2005, 0) }, _sink.Store.Los.Span.ToArray().Select(x => (x.Tick, x.Vis)));
    }

    [Fact]
    public void AFailedTraceMidRoundClosesVisibleEnemiesAndFallsBackToTheMask()
    {
        _frames.ByPi[B].Spot0 = 1u; // the human's slot (0) is set in the mask
        _frames.HumanSlot = 0;
        Ticks(2000, 2004);
        _probe.Answer = (_, _, _) => null;
        Ticks(2004, 2010);
        int calls = _probe.Calls;
        _r.Shot(new ShotInput { Tick = 2010, Weapon = 0, Class = 0, Speed = 0, MaxSpeed = 215 });
        Ticks(2010, 2100);
        _r.RoundEnd(2100, 3, 8);
        _r.Finalize(1, 2164);
        var s = _sink.Store;
        Assert.Equal(new[] { (2000, 1), (2004, 0) }, s.Los.Span.ToArray().Select(x => (x.Tick, x.Vis)));
        Assert.Equal(calls, _probe.Calls); // no trace after the failure
        Assert.Equal("trace returned no result", s.Meta.Env.LosError);
        Assert.Equal("mixed", s.Meta.Env.VisSource);
        Assert.Equal(1, s.Shots[0].VisTarget);
        Assert.Single(_warnings, w => w.Contains("Line of sight turned off"));
    }

    /// <summary>Fails if a failure between rounds records env.losError but leaves env.visSource at "los".</summary>
    [Fact]
    public void AFailureBetweenRoundsMarksTheSourceMixed()
    {
        Ticks(2000, 2010);
        _r.RoundEnd(2100, 3, 8);
        _r.DisableLos("probe could not be created (NullReferenceException: x)", 2200); // e.g. at the next map-ready step
        _r.Flush();
        Assert.Equal(("mixed", "probe could not be created (NullReferenceException: x)"), (_sink.Store.Meta.Env.VisSource, _sink.Store.Meta.Env.LosError));
    }

    [Fact]
    public void AFailureBeforeTheMatchIsRecordedAndANewMapRetries()
    {
        var sink = new ListSink();
        var probe = new FakeProbe();
        var r = new Recorder(sink, _frames, new PerfCounter(), _ => { });
        r.AttachLos(probe);
        r.DisableLos("a trace to a point 4 units above the eye was blocked", 0); // the startup self-check
        r.StartCapture(new MatchMeta { Id = "fedcba9876543210fedcba9876543210", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { Plugin = "t", MaxRounds = 24 } });
        r.PlayerIndex("76561190000000001", "me", false);
        r.PlayerIndex("B:Rock", "Rock", true);
        r.SetHuman(H);
        r.BeginRound(0, 1000, 0, 0, partial: false, Nil.V);
        r.SetFreezePlayer(H, 3, 800, 1000, 100, true);
        r.SetFreezePlayer(B, 2, 1000, 900, 100, true);
        r.FreezeEnd(2000);
        for (int t = 2000; t < 2100; t++) r.Tick(t);
        r.Flush();
        Assert.Equal(0, probe.Calls);
        Assert.Equal(("mask", "a trace to a point 4 units above the eye was blocked"), (sink.Store.Meta.Env.VisSource, sink.Store.Meta.Env.LosError));
        r.AttachLos(probe);
        Assert.True(r.Los.Enabled);
    }

    /// <summary>
    /// Fails if a capture started mid-round (plugin loaded or resumed during a live round, so no freeze
    /// end follows) omits the visibility source and an earlier failure (audit PluginMidRoundError/Source).
    /// </summary>
    [Fact]
    public void AMidRoundStartRecordsAnEarlierFailureAndTheMaskSource()
    {
        var sink = new ListSink();
        var r = new Recorder(sink, _frames, new PerfCounter(), _ => { });
        r.AttachLos(new FakeProbe());
        r.DisableLos("first trace returned no result", 0); // at map load, before any capture
        r.StartCapture(new MatchMeta { Id = "00112233445566778899aabbccddeeff", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { Plugin = "t", MaxRounds = 24 } });
        r.PlayerIndex("76561190000000001", "me", false);
        r.SetHuman(H);
        r.BeginRound(3, 5000, 2, 1, partial: true, freezeTickIfLive: 4000);
        r.Flush();
        Assert.Equal(("mask", "first trace returned no result"), (sink.Store.Meta.Env.VisSource, sink.Store.Meta.Env.LosError));
    }

    [Fact]
    public void FileRoundTripKeepsLosRowsAndEnv()
    {
        Ticks(2000, 2001);
        _r.RoundEnd(2100, 3, 8);
        _r.Finalize(1, 2164);
        using var ms = new MemoryStream();
        MatchCodec.Write(_sink.Store, ms, inProgress: true);
        using var doc = JsonDocument.Parse(ms.ToArray());
        var aim = doc.RootElement.GetProperty("aim");
        Assert.Equal("[2000,2100]", aim.GetProperty("los").GetProperty("tick").GetRawText());
        Assert.Equal("[1,0]", aim.GetProperty("los").GetProperty("vis").GetRawText());
        Assert.Equal("los", doc.RootElement.GetProperty("env").GetProperty("visSource").GetString());
        Assert.True(doc.RootElement.GetProperty("perf").GetProperty("losChecks")[0].GetInt32() > 0);
        ms.Position = 0;
        var back = new MatchStore();
        MatchCodec.Read(ms, back);
        Assert.Equal(2, back.Los.Count);
        Assert.Equal("los", back.Meta.Env.VisSource);
        Assert.Equal(_sink.Store.Perf[0].LosTraces, back.Perf[0].LosTraces);
    }

    [Fact]
    public void FilesWithoutLineOfSightStillRead()
    {
        var r = new Recorder(_sink, new FrameSet(), new PerfCounter(), _ => { }); // no probe attached
        r.StartCapture(new MatchMeta { Id = "fedcba9876543210fedcba9876543210", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { Plugin = "t", MaxRounds = 24 } });
        r.PlayerIndex("76561190000000001", "me", false);
        r.SetHuman(0);
        r.BeginRound(0, 1000, 0, 0, partial: false, Nil.V);
        r.FreezeEnd(2000);
        r.Flush();
        Assert.Equal("mask", _sink.Store.Meta.Env.VisSource);
        using var ms = new MemoryStream();
        MatchCodec.Write(_sink.Store, ms, inProgress: true);
        // An older file has neither aim.los, env.visSource nor the perf los columns.
        using var doc = JsonDocument.Parse(ms.ToArray());
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(StripLos(doc.RootElement))), back);
        Assert.Equal(0, back.Los.Count);
        Assert.Null(back.Meta.Env.VisSource);
    }

    private static string StripLos(JsonElement root)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            void Copy(JsonElement e)
            {
                if (e.ValueKind != JsonValueKind.Object) { e.WriteTo(w); return; }
                w.WriteStartObject();
                foreach (var p in e.EnumerateObject())
                {
                    if (p.Name.StartsWith("los", StringComparison.Ordinal) || p.Name == "visSource") continue;
                    w.WritePropertyName(p.Name);
                    Copy(p.Value);
                }
                w.WriteEndObject();
            }
            Copy(root);
        }
        return System.Text.Encoding.UTF8.GetString(ms.ToArray());
    }
}
