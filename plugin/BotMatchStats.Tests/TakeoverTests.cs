using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BotMatchStats.Core;

namespace BotMatchStats.Tests;

/// <summary>Overtime round results, bot takeovers, and reconciliation on the game's per-pawn basis.</summary>
public class TakeoverTests
{
    // The human and two CT bots against three T bots.
    private const int H = 0, C1 = 1, C2 = 2, E1 = 3, E2 = 4, E3 = 5;

    private readonly ListSink _sink = new();
    private readonly List<string> _warnings = new();
    private readonly Recorder _r;

    public TakeoverTests()
    {
        _r = new Recorder(_sink, new FrameSet(), new PerfCounter(), _warnings.Add);
        _r.StartCapture(new MatchMeta { Id = "55555555555555555555555555555555", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { MaxRounds = 24 } });
        _r.PlayerIndex("h", "h", false);
        foreach (var n in new[] { "c1", "c2", "e1", "e2", "e3" }) _r.PlayerIndex("B:" + n, n, true);
        _r.SetHuman(H);
    }

    private void Begin(int ri, int tick)
    {
        _r.BeginRound(ri, tick, 0, 0, partial: false, Nil.V);
        for (int pi = 0; pi <= E3; pi++) _r.SetFreezePlayer(pi, pi <= C2 ? 3 : 2, 800, 1000, 100, true);
        _r.FreezeEnd(tick + 1000);
    }

    private static KillInput KillBy(int tick, int killer, int victim) =>
        new() { Tick = tick, Killer = killer, Victim = victim, Assister = Nil.V, Weapon = 0, NadeType = Nil.V };

    // ---- round results -----------------------------------------------------------------------

    [Fact]
    public void RoundWithoutResultSlotTakesTheEventAndAKnownCodeStillWins()
    {
        Begin(30, 10_000);
        _r.RoundEnd(12_000, 2, 9);
        _r.Finalize(Nil.V, 12_064); // past MatchStats_RoundResults' 30 slots
        Begin(31, 20_000);
        _r.RoundEnd(22_000, 3, 12);
        _r.Finalize(Nil.V, 22_064);
        Begin(32, 30_000);
        _r.RoundEnd(32_000, 2, 9);  // the event says T elimination
        _r.Finalize(1, 32_064);     // the code says CT elimination: the code wins
        _r.EndCapture("complete", "2026-10-24T18:00:00Z", 32_100);

        var s = _sink.Store;
        Assert.Equal((2, RoundResult.HowElim), (s.Round(30).WinSide, s.Round(30).How));
        Assert.Equal((3, RoundResult.HowTime), (s.Round(31).WinSide, s.Round(31).How));
        Assert.Equal((3, RoundResult.HowElim), (s.Round(32).WinSide, s.Round(32).How));
        Assert.Empty(s.Meta.UnknownResults);
        Assert.Contains(_warnings, w => w.Contains("Round 32: round_end winner 2 disagrees"));
        // One line for the whole match, naming each round the event filled.
        var filled = Assert.Single(_warnings, w => w.Contains("came from round_end"));
        Assert.Contains("30 (no slot, winner 2, reason 9), 31 (no slot, winner 3, reason 12)", filled);
        Assert.DoesNotContain("32 (", filled);
    }

    [Fact]
    public void UnmappedEventReasonKeepsTheWinnerAndLeavesHowNull()
    {
        Begin(30, 10_000);
        _r.RoundEnd(12_000, 3, 99);
        _r.Finalize(Nil.V, 12_064);
        Assert.Equal((3, Nil.V), (_sink.Store.Round(30).WinSide, _sink.Store.Round(30).How));
        Assert.Equal(new[] { 30 }, _sink.Store.Meta.UnknownResults);
        Assert.Contains(_warnings, w => w.Contains("Round 30: MatchStats_RoundResults no slot, round_end winner 3 reason 99; winSide 3, how null"));
    }

    [Fact]
    public void PriorRoundWithoutSlotStaysNullWithoutAPerRoundWarning()
    {
        _r.AddPriorRound(30, Nil.V);
        _r.AddPriorRound(31, Nil.V);
        _r.Flush();
        Assert.Equal((Nil.V, Nil.V), (_sink.Store.Round(31).WinSide, _sink.Store.Round(31).How));
        Assert.Equal(new[] { 30, 31 }, _sink.Store.Meta.UnknownResults);
        Assert.Empty(_warnings); // the game layer logs the missing slots once
    }

    // ---- takeovers ---------------------------------------------------------------------------

    [Fact]
    public void TwoSuccessiveBodiesInOneRoundThenResetAtRoundStart()
    {
        Begin(0, 1000);
        _r.SetBody(2100, H, Nil.V);            // in its own pawn: no row
        _r.Kill(KillBy(2200, E1, H));
        _r.SetBody(2300, H, C1);
        _r.SetBody(2301, H, C1);               // unchanged: no row
        _r.Kill(new KillInput { Tick = 2400, Killer = E2, Victim = H, VictimBody = C1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        _r.SetBody(2401, H, C1);               // the end row is at the death tick + 1; the handle can still name the dead pawn
        _r.SetBody(2500, H, C2);
        _r.RoundEnd(3000, 2, 9);
        _r.SetBody(3001, H, Nil.V);            // not live: ignored
        _r.Finalize(5, 3064);

        Begin(1, 10_000);
        _r.SetBody(11_100, H, C2);             // every round starts in its own pawn, so this is a new takeover
        _r.Flush();

        var rows = _sink.Store.Takeovers.Span.ToArray().Select(t => (t.Ri, t.Tick, t.Pi, t.Body));
        Assert.Equal(new[] { (0, 2300, H, C1), (0, 2401, H, Nil.V), (0, 2500, H, C2), (1, 11_100, H, C2) }, rows);
    }

    /// <summary>The body a controller drove at <paramref name="tick"/>, read as the schema says: the last row with tick ≤ the event's.</summary>
    private static int BodyAt(MatchStore s, int ri, int pi, int tick)
    {
        int body = Nil.V;
        foreach (var t in s.Takeovers.Span)
            if (t.Ri == ri && t.Pi == pi && t.Tick <= tick) body = t.Body;
        return body;
    }

    [Fact]
    public void SameTickTradeAndTakeoverTickEventsResolveToTheBody()
    {
        Begin(0, 1000);
        _r.Kill(KillBy(2200, E1, H));
        // The handler check records the takeover before the human's first event in C1, on the same tick.
        _r.SetBody(2300, H, C1);
        _r.Hurt(2300, H, E1, 30, 0, 70, 0, 2, true, Nil.V, attackerBody: C1);
        // A trade: C1's pawn deals 40 and dies on tick 2400.
        _r.Hurt(2400, H, E2, 40, 0, 60, 0, 2, true, Nil.V, attackerBody: C1);
        _r.Hurt(2400, E2, H, 100, 0, 0, 0, 1, true, Nil.V, victimBody: C1);
        _r.Kill(new KillInput { Tick = 2400, Killer = E2, Victim = H, VictimBody = C1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        _r.Hurt(2401, E1, C2, 10, 0, 90, 0, 2, true, Nil.V);
        _r.Flush();

        var s = _sink.Store;
        var humanHits = s.Damage.Span.ToArray().Where(d => d.Attacker == H).ToArray();
        Assert.Equal(new[] { (2300, 30), (2400, 40) }, humanHits.Select(d => (d.Tick, d.Dmg)));
        Assert.All(humanHits, d => Assert.Equal(C1, BodyAt(s, 0, H, d.Tick)));
        Assert.Equal(C1, BodyAt(s, 0, H, 2400)); // the fatal hit and the death are the body's
        Assert.Equal(Nil.V, BodyAt(s, 0, H, 2401));
    }

    [Fact]
    public void TakeoverRoundReconcilesWhenTheGameCreditsTheBody()
    {
        Begin(0, 1000);
        _r.Hurt(2100, E1, H, 100, 0, 0, 0, 1, true, Nil.V);
        _r.Kill(KillBy(2100, E1, H));
        _r.SetBody(2200, H, C1);
        // Driving C1: damage, a kill, and an assist all belong to C1 in CSPerRoundStats_t.
        _r.Hurt(2300, H, E1, 100, 0, 0, 0, 1, true, Nil.V, attackerBody: C1);
        _r.Kill(new KillInput { Tick = 2300, Killer = H, KillerBody = C1, Victim = E1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        _r.Hurt(2400, H, E2, 40, 0, 60, 0, 2, true, Nil.V, attackerBody: C1);
        _r.Hurt(2410, C2, E2, 60, 0, 0, 0, 1, true, Nil.V);
        _r.Kill(new KillInput { Tick = 2410, Killer = C2, Victim = E2, Assister = H, AssisterBody = C1, Weapon = 0, NadeType = Nil.V });
        // Lethal on C1's pawn, which has full HP although the controller H is already dead.
        _r.Hurt(2500, E3, H, 100, 0, 0, 0, 1, true, Nil.V, victimBody: C1);
        _r.Kill(new KillInput { Tick = 2500, Killer = E3, Victim = H, VictimBody = C1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        _r.RoundEnd(3000, 2, 9);
        _r.Finalize(5, 3064);

        var game = new GameRoundStats[Limits.MaxPlayers];
        var have = new bool[Limits.MaxPlayers];
        for (int pi = 0; pi <= E3; pi++) have[pi] = true;
        game[H] = new GameRoundStats { Deaths = 1 };
        game[C1] = new GameRoundStats { Kills = 1, Deaths = 1, Assists = 1, Damage = 140 };
        game[C2] = new GameRoundStats { Kills = 1, Damage = 60 };
        game[E1] = new GameRoundStats { Kills = 1, Deaths = 1, Damage = 100 };
        game[E2] = new GameRoundStats { Deaths = 1 };
        game[E3] = new GameRoundStats { Kills = 1, Damage = 100 };
        _r.Reconcile(0, game, have);
        _r.Flush();

        var s = _sink.Store;
        Assert.Empty(s.Mismatches.Span.ToArray());
        var rr = Assert.Single(s.ReconRounds.Span.ToArray());
        Assert.Equal((6, 6, 6, 6, 6), (rr.Checked, rr.KillsOk, rr.DeathsOk, rr.AssistsOk, rr.DamageOk));
        // File rows still name the controller.
        var kill = s.Kills[1];
        Assert.Equal((H, C1), (kill.Killer, kill.KBody));
        Assert.Equal(H, s.Damage[1].Attacker);
        Assert.Equal(H, s.Kills[2].Assister);
    }

    // ---- file --------------------------------------------------------------------------------

    private MatchStore TakeoverStore()
    {
        Begin(0, 1000);
        _r.Kill(KillBy(2200, E1, H));
        _r.SetBody(2300, H, C1);
        _r.Kill(new KillInput { Tick = 2400, Killer = E2, Victim = H, VictimBody = C1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
        _r.RoundEnd(3000, 2, 9);
        _r.Finalize(5, 3064);
        return _sink.Store;
    }

    [Fact]
    public void CodecRoundTripsTakeovers()
    {
        var s = TakeoverStore();
        using var ms = new MemoryStream();
        MatchCodec.Write(s, ms, inProgress: true);
        using (var doc = JsonDocument.Parse(ms.ToArray()))
        {
            var t = doc.RootElement.GetProperty("takeovers");
            Assert.Equal("[2300,2401]", t.GetProperty("tick").GetRawText());
            Assert.Equal("[0,0]", t.GetProperty("pi").GetRawText());
            Assert.Equal("[1,null]", t.GetProperty("body").GetRawText());
            Assert.Equal(0, doc.RootElement.GetProperty("recon").GetProperty("dropped").GetProperty("takeovers").GetInt32());
        }
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(ms.ToArray()), back);
        Assert.Equal(s.Takeovers.Span.ToArray(), back.Takeovers.Span.ToArray());
    }

    [Fact]
    public void FilesWithoutTakeoversStillRead()
    {
        using var ms = new MemoryStream();
        MatchCodec.Write(TakeoverStore(), ms, inProgress: true);
        var node = System.Text.Json.Nodes.JsonNode.Parse(ms.ToArray())!.AsObject();
        node.Remove("takeovers");
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(Encoding.UTF8.GetBytes(node.ToJsonString())), back);
        Assert.Equal(0, back.Takeovers.Count);
    }

    /// <summary>
    /// A reload while the human drives C1: the in-progress file goes through the writer's scan, a new
    /// Recorder resumes it mid-round (as InitMidRound does: alive state from the pawns, then the body
    /// check), and the final file must close the takeover. Without the restore, the resumed recorder
    /// starts with no takeover and never writes the end row, leaving the saved one open.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ResumedMatchClosesItsOpenTakeover(bool bodyDiedDuringReload)
    {
        string root = Path.Combine(Path.GetTempPath(), "bms-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            Begin(0, 1000);
            _r.Kill(KillBy(2200, E1, H));
            _r.SetBody(2300, H, C1);
            _r.Flush(); // the unload's seal: round 0 is still open
            var store = _sink.Store;
            var meta = store.Meta;

            using var w = new MatchWriter(root, null);
            var buf = w.Rent();
            foreach (var r in store.Takeovers.Span) buf.Takeovers.Add(r);
            foreach (var r in store.Kills.Span) buf.Kills.Add(r);
            w.Submit(new WriteJob { Kind = JobKind.InProgress, Buffer = buf, Meta = meta.Clone() });
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
            w.RequestScan(meta.Map, meta.GameStart, 1);
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
            var resumed = Assert.Single(Drain(w), m => m.Resume != null).Resume!;

            var rec = new Recorder(w, new FrameSet(), new PerfCounter(), _ => { });
            rec.Resume(resumed);
            rec.BeginRound(0, 5000, 0, 0, partial: true, freezeTickIfLive: 1000);
            for (int pi = 0; pi <= E3; pi++)
            {
                rec.SetTeam(pi, pi <= C2 ? 3 : 2);
                rec.SetAlive(pi, pi != H && pi != E1 && !(pi == C1 && bodyDiedDuringReload), 100);
            }
            rec.SetBody(5000, H, C1);
            if (!bodyDiedDuringReload)
                rec.Kill(new KillInput { Tick = 5100, Killer = E2, Victim = H, VictimBody = C1, Assister = Nil.V, Weapon = 0, NadeType = Nil.V });
            rec.EndCapture("abandoned", "2026-10-24T18:00:00Z", 5200);
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));

            var back = new MatchStore();
            using (var gz = new GZipStream(File.OpenRead(Path.Combine(w.MatchesDir, meta.Year, meta.BaseName + ".json.gz")), CompressionMode.Decompress))
                MatchCodec.Read(gz, back);
            var rows = back.Takeovers.Span.ToArray().Select(t => (t.Ri, t.Tick, t.Pi, t.Body));
            var end = bodyDiedDuringReload ? (0, 5000, H, Nil.V) : (0, 5101, H, Nil.V);
            Assert.Equal(new[] { (0, 2300, H, C1), end }, rows);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    [Fact]
    public void ResumeWritesARowWhenTheBodyChangedDuringTheReload()
    {
        var meta = new MatchMeta { LastTakeover = new TakeoverRow { Ri = 0, Tick = 2300, Pi = H, Body = C1 } };
        var rec = new Recorder(_sink, new FrameSet(), new PerfCounter(), _ => { });
        rec.Resume(meta);
        foreach (var n in new[] { "h", "c1", "c2" }) rec.PlayerIndex(n, n, n != "h");
        rec.BeginRound(0, 5000, 0, 0, partial: true, freezeTickIfLive: 1000);
        rec.SetAlive(C2, true, 100);
        rec.SetBody(5000, H, C2);
        rec.Flush();
        var t = Assert.Single(_sink.Store.Takeovers.Span.ToArray());
        Assert.Equal((0, 5000, H, C2), (t.Ri, t.Tick, t.Pi, t.Body));
    }

    // ---- capture ends between round_end and the delayed finalize -----------------------------

    [Fact]
    public void AbandonAfterRoundEndTakesTheResultFromTheEvent()
    {
        Begin(0, 1000);
        _r.RoundEnd(3000, 2, 9);
        _r.EndCapture("abandoned", "2026-10-24T18:00:00Z", 3010); // map end: the code cannot be read
        var round = _sink.Store.Round(0);
        Assert.Equal((2, RoundResult.HowElim), (round.WinSide, round.How));
        Assert.Empty(_sink.Store.Meta.UnknownResults);
        Assert.Equal(new[] { 0 }, _sink.Store.Meta.PartialRounds);
    }

    [Fact]
    public void AbandonAfterRoundEndPrefersAKnownCode()
    {
        Begin(0, 1000);
        _r.RoundEnd(3000, 2, 9);
        _r.EndCapture("abandoned", "2026-10-24T18:00:00Z", 3010, resultCode: 1); // the human left; rules still readable
        Assert.Equal(3, _sink.Store.Round(0).WinSide);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AbandonListsTheRoundAsUnknownOnlyWhenItStaysNull(bool roundEnded)
    {
        Begin(0, 1000);
        if (roundEnded) _r.RoundEnd(3000, 3, 99); // winner known, reason unmapped: how stays null
        _r.EndCapture("abandoned", "2026-10-24T18:00:00Z", 3010);
        var round = _sink.Store.Round(0);
        Assert.Equal(roundEnded ? 3 : Nil.V, round.WinSide);
        Assert.Equal(Nil.V, round.How);
        // A round cut off before round_end has no result to know; it is partial, not unknown.
        Assert.Equal(roundEnded ? new[] { 0 } : Array.Empty<int>(), _sink.Store.Meta.UnknownResults);
    }

    private static List<WorkerMessage> Drain(MatchWriter w)
    {
        var l = new List<WorkerMessage>();
        while (w.Messages.TryDequeue(out var m)) l.Add(m);
        return l;
    }
}
