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

    public LosTests()
    {
        _los.Attach(_probe);
        _los.BudgetMicros = 1e9; // timing-independent, except in the budget test
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

    [Fact]
    public void AnExhaustedBudgetMakesNoTraceAndKeepsPreviousStates()
    {
        _los.Check(0, 100, H, _f, _rows);
        int calls = _probe.Calls;
        _probe.Answer = (_, _, _) => false;
        _los.BudgetMicros = 0; // the deadline has passed before the first trace
        _los.Check(0, 104, H, _f, _rows);
        Assert.Equal(calls, _probe.Calls);
        Assert.Equal(2, _los.BudgetHits);
        Assert.True(_los.IsVisible(E1) && _los.IsVisible(E2));
    }

    [Fact]
    public void ATraceThatStartsInSolidIsBlocked()
    {
        Assert.True(LosTracker.IsClear(1f, startInSolid: false));
        Assert.False(LosTracker.IsClear(1f, startInSolid: true));
        Assert.False(LosTracker.IsClear(0.5f, startInSolid: false));
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
        _r.Los.BudgetMicros = 1e9;
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
        Assert.Equal((50, 3 + 3 * 47), (perf.LosChecks, perf.LosTraces)); // 2000..2196 every 4 ticks; blocked checks trace all three points
    }

    [Fact]
    public void ADeadEnemyIsHiddenAtTheKillTick()
    {
        Ticks(2000, 2003);
        _r.Kill(new KillInput { Tick = 2003, Killer = H, Victim = B, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        _r.Flush();
        Assert.Equal(new[] { (2000, 1), (2003, 0) }, _sink.Store.Los.Span.ToArray().Select(x => (x.Tick, x.Vis)));
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
