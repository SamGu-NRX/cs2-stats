using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BotMatchStats.Core;

namespace BotMatchStats.Tests;

/// <summary>Regression tests for the independent review findings and the TLA+ traces.</summary>
public class ReviewFixTests
{
    private static (Recorder rec, ListSink sink, FrameSet frames) NewRound(int ri = 0, bool freezeEnd = true)
    {
        var sink = new ListSink();
        var frames = new FrameSet();
        var r = new Recorder(sink, frames, new PerfCounter(), _ => { });
        r.StartCapture(new MatchMeta { Id = "33333333333333333333333333333333", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { MaxRounds = 24 } });
        r.PlayerIndex("h", "h", false); r.PlayerIndex("b1", "b1", true); r.PlayerIndex("b2", "b2", true);
        r.SetHuman(0);
        r.BeginRound(ri, 1000, 0, 0, false, Nil.V);
        r.SetFreezePlayer(0, 3, 800, 1000, 100, true);
        r.SetFreezePlayer(1, 2, 800, 900, 100, true);
        r.SetFreezePlayer(2, 2, 800, Nil.V, 100, false);
        if (freezeEnd) r.FreezeEnd(2000);
        return (r, sink, frames);
    }

    // ---- P1: restart right after a post-round resume -----------------------------------------

    [Fact]
    public void RestartIsDetectedAfterResumeBeforeAnyRoundBegins()
    {
        var store = CodecTests.SampleStore(); // two rounds: 0 (prior) and 1
        using var ms = new MemoryStream();
        MatchCodec.Write(store, ms, inProgress: true);
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(ms.ToArray()), back);
        Assert.Equal(2, back.Meta.RoundCount);

        var r = new Recorder(new ListSink(), new FrameSet(), new PerfCounter(), _ => { });
        r.Resume(back.Meta);
        Assert.Equal(Nil.V, r.Ri); // no round begun yet: the case the old check missed
        Assert.Equal(1, r.LastRound);
        Assert.True(r.IsRestart(0, warmup: false));  // mp_restartgame before the next round
        Assert.True(r.IsRestart(1, warmup: false));
        Assert.False(r.IsRestart(2, warmup: false)); // the normal next round
        Assert.True(r.IsRestart(2, warmup: true));
    }

    [Fact]
    public void FreshCaptureIsNeverARestart()
    {
        var r = new Recorder(new ListSink(), new FrameSet(), new PerfCounter(), _ => { });
        r.StartCapture(new MatchMeta { Id = "x", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z" });
        Assert.False(r.IsRestart(0, false));
        r.AddPriorRound(0, 5);
        Assert.True(r.IsRestart(0, false));
        Assert.False(r.IsRestart(1, false));
    }

    // ---- P2: equipment -----------------------------------------------------------------------

    [Fact]
    public void UnknownEquipmentStaysNullInRoundAndKillState()
    {
        var (r, sink, _) = NewRound();
        r.SetFreezePlayer(1, 2, 800, Nil.V, 100, true); // equipment unreadable
        r.Kill(new KillInput { Tick = 2100, Killer = 0, Victim = 1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        r.Flush();
        Assert.Equal(Nil.V, sink.Store.Kills[0].TEquip);
        Assert.Equal(1000, sink.Store.Kills[0].CtEquip);
    }

    [Fact]
    public void VictimEquipmentFromThePreHookIsUsed()
    {
        var (r, sink, _) = NewRound();
        r.SetEquipNow(1, 900 + 4750); // AWP picked up just before death, read in the pre-hook
        r.Kill(new KillInput { Tick = 2100, Killer = 0, Victim = 1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        r.Flush();
        Assert.Equal(5650, sink.Store.Kills[0].TEquip);
    }

    [Fact]
    public void EquipSourceIsRecordedPerRoundAndSummarisedInEnv()
    {
        var (r, sink, _) = NewRound();
        r.SetEquipSource(Recorder.EquipFromPawn);
        Assert.Equal("pawn", r.Meta.Env.EquipSource);
        r.SetEquipSource(Recorder.EquipFromInventory);
        Assert.Equal("mixed", r.Meta.Env.EquipSource);
        r.RoundEnd(3000, 3, 8);
        r.Finalize(1, 3064);
        Assert.Equal(Recorder.EquipFromInventory, sink.Store.Round(0).EquipSrc);
        using var ms = new MemoryStream();
        MatchCodec.Write(sink.Store, ms, false);
        using var doc = JsonDocument.Parse(ms.ToArray());
        Assert.Equal("mixed", doc.RootElement.GetProperty("env").GetProperty("equipSource").GetString());
        Assert.Equal("inventory", doc.RootElement.GetProperty("rounds").GetProperty("equipSrc")[0].GetString());
    }

    // ---- P2: death attribution ---------------------------------------------------------------

    [Fact]
    public void SuicideWorldFreezeAndBotControlAreDistinct()
    {
        var (r, sink, _) = NewRound(freezeEnd: false);
        r.Kill(new KillInput { Tick = 1500, Killer = 1, Victim = 1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V }); // suicide in freeze time
        r.FreezeEnd(2000);
        r.Kill(new KillInput { Tick = 2100, Killer = Nil.V, Victim = 2, Assister = Nil.V, Weapon = 0, NadeType = Nil.V }); // world
        r.Kill(new KillInput { Tick = 2200, Killer = 0, Victim = 1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V, KillerBody = 2, VictimBody = Nil.V });
        r.Flush();
        var k = sink.Store.Kills.Span.ToArray();
        Assert.Equal(Recorder.KillFlagSuicide | Recorder.KillFlagFreeze, k[0].Flags);
        Assert.Equal(Nil.V, k[0].Killer);
        Assert.Equal(0, k[1].Flags);
        Assert.Equal(Nil.V, k[1].Killer);
        Assert.Equal((0, 2, Nil.V), (k[2].Killer, k[2].KBody, k[2].VBody));
    }

    // ---- visibility validation data ----------------------------------------------------------

    [Fact]
    public void HitMaskKeepsOnlyHumanDamageToEnemies()
    {
        var (r, sink, _) = NewRound();
        r.HitMask(2100, 0, 1, 0x8000_0001u, 4u, true);   // human -> enemy: kept
        r.HitMask(2101, 1, 0, 1u, 0u, true);             // bot -> human: ignored
        r.HitMask(2102, 1, 2, 1u, 0u, false);            // bot -> bot: ignored
        r.SetHumanEntities(3, 4, 250);
        r.SetHumanEntities(9, 9, 9);                      // once per match
        r.Flush();
        var row = Assert.Single(sink.Store.HitMask.Span.ToArray());
        Assert.Equal((0, 2100, 1, 0x8000_0001u, 4u, true), (row.Ri, row.Tick, row.Victim, row.M0, row.M1, row.Spotted));
        using var ms = new MemoryStream();
        MatchCodec.Write(sink.Store, ms, false);
        using var doc = JsonDocument.Parse(ms.ToArray());
        Assert.Equal("[2147483649]", doc.RootElement.GetProperty("aim").GetProperty("hitMask").GetProperty("m0").GetRawText());
        var env = doc.RootElement.GetProperty("env");
        Assert.Equal((3, 4, 250), (env.GetProperty("humanSlot").GetInt32(), env.GetProperty("humanController").GetInt32(), env.GetProperty("humanPawn").GetInt32()));
    }

    // ---- P2: clutch inputs -------------------------------------------------------------------

    [Fact]
    public void AliveAtFreezeEndAndLeavesAreRecorded()
    {
        var (r, sink, _) = NewRound();
        r.Leave(2300, 1);
        r.Leave(2400, 2);
        Assert.False(r.IsAlive(1));
        r.RoundEnd(3000, 3, 8);
        r.Finalize(1, 3064);
        var round = sink.Store.Round(0);
        Assert.Equal(new[] { 1, 1, 0 }, round.Alive0.Take(3));
        var l = sink.Store.Leaves.Span.ToArray();
        Assert.Equal((0, 2300, 1, 1), (l[0].Ri, l[0].Tick, l[0].Pi, l[0].Alive));
        Assert.Equal((2, 0), (l[1].Pi, l[1].Alive));
    }

    // ---- P2: allocation claim ----------------------------------------------------------------

    [Fact]
    public void FirstSightOfNewPlacesDoesNotAllocate()
    {
        var t = new PlaceTable(128);
        t.SetMap("de_dust2");
        var names = new[] { "LongDoors", "TSpawn", "BombsiteB", "OutsideTunnel", "Middle", "CTSpawn", "Pit", "TopofMid" };
        var raw = names.Select(n => { var b = new byte[18]; Encoding.UTF8.GetBytes(n).CopyTo(b, 0); return b; }).ToArray();
        long before = GC.GetAllocatedBytesForCurrentThread();
        foreach (var b in raw) t.Lookup(b);
        foreach (var b in raw) t.Lookup(b);
        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
        Assert.Equal(names, t.ToArray());
        Assert.Equal(CtSetupCounter.A, t.Area(0));
        Assert.Equal(CtSetupCounter.Other, t.Area(1));
        Assert.Equal(CtSetupCounter.B, t.Area(2));
        Assert.Equal(CtSetupCounter.Ct, t.Area(5));
    }

    // ---- storage: delta-encoded positions ----------------------------------------------------

    [Fact]
    public void PositionsAreDeltaEncodedPerPlayerAndLossless()
    {
        var s = new MatchStore();
        s.Meta = CodecTests.SampleStore().Meta;
        s.Pos.Add(new PosRow { Ri = 0, Tick = 1000, Pi = 0, X = 100, Y = -200, Z = 30, Place = 2, Alive = 1 });
        s.Pos.Add(new PosRow { Ri = 0, Tick = 1000, Pi = 1, X = -5, Y = 7, Z = 0, Place = Nil.V, Alive = 1 });
        s.Pos.Add(new PosRow { Ri = 0, Tick = 1016, Pi = 0, X = 112, Y = -190, Z = 30, Place = 2, Alive = 1 });
        s.Pos.Add(new PosRow { Ri = 1, Tick = 9000, Pi = 1, X = -5, Y = 9, Z = -4, Place = 0, Alive = 1 });
        using var ms = new MemoryStream();
        MatchCodec.Write(s, ms, false);
        using var doc = JsonDocument.Parse(ms.ToArray());
        var pos = doc.RootElement.GetProperty("pos");
        Assert.Equal("delta", pos.GetProperty("enc").GetString());
        Assert.Equal("[1000,1000,16,8000]", pos.GetProperty("tick").GetRawText());
        Assert.Equal("[100,-5,12,0]", pos.GetProperty("x").GetRawText());
        Assert.Equal("[-200,7,10,2]", pos.GetProperty("y").GetRawText());
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(ms.ToArray()), back);
        Assert.Equal(s.Pos.Span.ToArray(), back.Pos.Span.ToArray());
    }

    // ---- reconciliation coverage -------------------------------------------------------------

    [Fact]
    public void PartialRoundsRecordCoverageWithoutComparing()
    {
        var sink = new ListSink();
        var r = new Recorder(sink, new FrameSet(), new PerfCounter(), _ => { });
        r.StartCapture(new MatchMeta { Id = "44444444444444444444444444444444", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z" });
        r.PlayerIndex("h", "h", false); r.PlayerIndex("b", "b", true);
        r.BeginRound(3, 1000, 0, 0, partial: true, 900);
        r.SetTeam(0, 3); r.SetTeam(1, 2);
        r.RoundEnd(2000, 3, 8);
        r.Finalize(1, 2064);
        r.Reconcile(3, new GameRoundStats[Limits.MaxPlayers], new bool[Limits.MaxPlayers]);
        r.Flush();
        var rr = Assert.Single(sink.Store.ReconRounds.Span.ToArray());
        Assert.Equal((3, 0, 2), (rr.Ri, rr.Checked, rr.Checked + rr.Missing));
        using var ms = new MemoryStream();
        MatchCodec.Write(sink.Store, ms, false);
        using var doc = JsonDocument.Parse(ms.ToArray());
        var rounds = doc.RootElement.GetProperty("recon").GetProperty("rounds");
        Assert.Equal("[0]", rounds.GetProperty("checkedPlayers").GetRawText());
        Assert.Equal("[2]", rounds.GetProperty("expectedPlayers").GetRawText());
    }
}

/// <summary>The two traces found by formal/Capture.tla.</summary>
public class LifecycleTests
{
    private static MatchMeta File(int rounds, float gameStart = 500f) => new() { Map = "de_dust2", GameStart = gameStart, RoundCount = rounds };

    // Safety trace: RoundStart -> Unload -> publish -> Load -> Restart -> Scan -> Resume.
    [Fact]
    public void ScanAnswerFromBeforeARestartIsRejected()
    {
        // The scan was requested as generation 1; the restart during the scan bumped it to 2.
        Assert.True(Lifecycle.ScanStale(false, 0, 500f, scanRoundsPlayed: 7, scanGameStart: 500f));
        Assert.False(Lifecycle.AcceptResume(resultGen: 1, currentGen: 2, File(7), "de_dust2", 500f, 0, false));
        // Even with a matching generation, a file the live round counter is behind is another game.
        Assert.False(Lifecycle.AcceptResume(2, 2, File(7), "de_dust2", 500f, 0, false));
    }

    [Theory]
    [InlineData(7, 7, "de_dust2", 500f, false, true)]   // reload between rounds
    [InlineData(7, 6, "de_dust2", 500f, false, true)]   // reload during the round after the last finalized one
    [InlineData(7, 5, "de_dust2", 500f, false, false)]  // counter went back: restart
    [InlineData(7, 7, "de_mirage", 500f, false, false)] // map changed
    [InlineData(7, 7, "de_dust2", 900f, false, false)]  // new game start time
    [InlineData(7, 7, "de_dust2", 500f, true, false)]   // warmup
    public void AcceptResumeChecksIdentity(int fileRounds, int liveRounds, string map, float gameStart, bool warmup, bool expected) =>
        Assert.Equal(expected, Lifecycle.AcceptResume(3, 3, File(fileRounds), map, gameStart, liveRounds, warmup));

    [Theory]
    [InlineData(false, 7, 500f, false)]
    [InlineData(false, 8, 500f, false)]
    [InlineData(true, 7, 500f, true)]
    [InlineData(false, 0, 500f, true)]
    [InlineData(false, 7, 501f, true)]
    public void ScanStaleOnGameChange(bool warmup, int rounds, float gs, bool expected) =>
        Assert.Equal(expected, Lifecycle.ScanStale(warmup, rounds, gs, 7, 500f));

    // Liveness trace: RoundStart -> Unload -> publish -> Load -> Scan -> FreezeEnd -> Event -> RoundEnd -> WinPanel -> Resume.
    [Theory]
    [InlineData(true, 1, true)]
    [InlineData(false, Lifecycle.GamePhaseMatchEnded, true)]
    [InlineData(false, 3, false)]
    public void MatchOverAtResume(bool winPanelSeen, int phase, bool expected) =>
        Assert.Equal(expected, Lifecycle.MatchOverAtResume(winPanelSeen, phase));

    [Fact]
    public void WriterEchoesScanGenerationAndAbandonsTheRejectedFile()
    {
        string root = Path.Combine(Path.GetTempPath(), "bms-gen-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = CodecTests.SampleStore();
            var meta = store.Meta;
            using var w = new MatchWriter(root, null);
            var buf = w.Rent();
            foreach (var r in store.Kills.Span) buf.Kills.Add(r);
            for (int i = 0; i < store.RoundCount; i++) buf.AddRound(store.Round(i));
            w.Submit(new WriteJob { Kind = JobKind.InProgress, Buffer = buf, Meta = meta.Clone() });

            // Generation 1 was asked for the old game and finds its file.
            w.RequestScan(meta.Map, meta.GameStart, 1);
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
            var first = Drain(w);
            Assert.Equal(1, Assert.Single(first, m => m.Resume != null).Gen);
            Assert.Equal(1, Assert.Single(first, m => m.ScanDone).Gen);

            // The game restarted meanwhile: the plugin rejects that answer and asks again (generation 2)
            // with the live identity. The old file is then written out as abandoned, not resumed.
            w.RequestScan(meta.Map, meta.GameStart + 60, 2);
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
            var second = Drain(w);
            Assert.DoesNotContain(second, m => m.Resume != null);
            Assert.Equal(2, Assert.Single(second, m => m.ScanDone).Gen);
            string final = Path.Combine(w.MatchesDir, "2026", meta.BaseName + ".json.gz");
            using var gz = new GZipStream(System.IO.File.OpenRead(final), CompressionMode.Decompress);
            using var doc = JsonDocument.Parse(gz);
            Assert.Equal("abandoned", doc.RootElement.GetProperty("status").GetString());
            Assert.Empty(Directory.GetFiles(w.InProgressDir));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private static List<WorkerMessage> Drain(MatchWriter w)
    {
        var l = new List<WorkerMessage>();
        while (w.Messages.TryDequeue(out var m)) l.Add(m);
        return l;
    }
}
