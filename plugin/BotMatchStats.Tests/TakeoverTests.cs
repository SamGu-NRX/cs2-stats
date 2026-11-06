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
        _r.SetBody(2401, H, C1);               // the handle can still name the dead pawn
        _r.SetBody(2500, H, C2);
        _r.RoundEnd(3000, 2, 9);
        _r.SetBody(3001, H, Nil.V);            // not live: ignored
        _r.Finalize(5, 3064);

        Begin(1, 10_000);
        _r.SetBody(11_100, H, C2);             // every round starts in its own pawn, so this is a new takeover
        _r.Flush();

        var rows = _sink.Store.Takeovers.Span.ToArray().Select(t => (t.Ri, t.Tick, t.Pi, t.Body));
        Assert.Equal(new[] { (0, 2300, H, C1), (0, 2400, H, Nil.V), (0, 2500, H, C2), (1, 11_100, H, C2) }, rows);
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
            Assert.Equal("[2300,2400]", t.GetProperty("tick").GetRawText());
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

    [Fact]
    public void ResumedMatchKeepsItsTakeovers()
    {
        string root = Path.Combine(Path.GetTempPath(), "bms-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = TakeoverStore();
            var meta = store.Meta;
            using var w = new MatchWriter(root, null);
            var buf = w.Rent();
            foreach (var r in store.Takeovers.Span) buf.Takeovers.Add(r);
            for (int i = 0; i < store.RoundCount; i++) buf.AddRound(store.Round(i));
            w.Submit(new WriteJob { Kind = JobKind.InProgress, Buffer = buf, Meta = meta.Clone() });
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));

            // A reload: the scan reads the in-progress file back into the writer's store.
            w.RequestScan(meta.Map, meta.GameStart, 1);
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
            Assert.Contains(Drain(w), m => m.Resume != null);

            var done = meta.Clone();
            done.Status = "complete";
            w.Submit(new WriteJob { Kind = JobKind.Final, Meta = done });
            Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
            var back = new MatchStore();
            using (var gz = new GZipStream(File.OpenRead(Path.Combine(w.MatchesDir, meta.Year, meta.BaseName + ".json.gz")), CompressionMode.Decompress))
                MatchCodec.Read(gz, back);
            Assert.Equal(store.Takeovers.Span.ToArray(), back.Takeovers.Span.ToArray());
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
