using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BotMatchStats.Core;

namespace BotMatchStats.Tests;

/// <summary>Collects hand-offs in memory instead of a worker thread.</summary>
internal sealed class ListSink : IRecorderSink
{
    public readonly List<WriteJob> Jobs = new();
    public readonly MatchStore Store = new();

    public RoundBuffer Rent() => new();

    public void Submit(WriteJob job)
    {
        Jobs.Add(job);
        if (Store.Meta.Id != job.Meta.Id) Store.Clear();
        Store.Append(job.Buffer!);
        Store.Meta = job.Meta;
    }
}

public class RecorderTests
{
    private readonly ListSink _sink = new();
    private readonly FrameSet _frames = new();
    private readonly List<string> _warnings = new();
    private readonly Recorder _r;
    private const int H = 0, B1 = 1, B2 = 2; // human CT, two T bots

    public RecorderTests()
    {
        _r = new Recorder(_sink, _frames, new PerfCounter(), _warnings.Add);
        _r.StartCapture(new MatchMeta { Id = "0123456789abcdef0123456789abcdef", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { Plugin = "t", MaxRounds = 24 } });
        Assert.Equal(H, _r.PlayerIndex("76561190000000001", "me", false));
        Assert.Equal(B1, _r.PlayerIndex("B:Rock", "Rock", true));
        Assert.Equal(B2, _r.PlayerIndex("B:Wolf", "Wolf", true));
        _r.SetHuman(H);
        _r.BeginRound(0, 1000, 0, 0, partial: false, Nil.V);
        _r.SetFreezePlayer(H, 3, 800, 1000, 100, true);
        _r.SetFreezePlayer(B1, 2, 1000, 900, 100, true);
        _r.SetFreezePlayer(B2, 2, 600, 700, 100, true);
        _r.FreezeEnd(2000);
    }

    [Fact]
    public void LethalDamageIsCappedAndKillStateIsBeforeTheKill()
    {
        _r.Hurt(2100, H, B1, 30, 5, 70, _r.Weapons.Get("ak47"), 2, true, Nil.V);
        _r.Hurt(2110, H, B1, 120, 0, 0, _r.Weapons.Get("ak47"), 1, true, Nil.V);
        _r.Kill(new KillInput { Tick = 2110, Killer = H, Victim = B1, Assister = Nil.V, Weapon = _r.Weapons.Get("ak47"), Flags = 1, NadeType = Nil.V, VX = 1.4f, VY = -2.6f, VZ = 3.5f, HasKillerPos = true, KX = 10, KY = 20, KZ = 30 });
        _r.RoundEnd(2500, 3, 8);
        _r.Finalize(1, 2564);

        var s = _sink.Store;
        Assert.Equal(new[] { 30, 70 }, s.Damage.Span.ToArray().Select(d => d.Dmg));
        var k = s.Kills[0];
        Assert.Equal((1, 2, 100, 170, 1000, 1600, 0, Nil.V), (k.CtAlive, k.TAlive, k.CtHp, k.THp, k.CtEquip, k.TEquip, k.Planted, k.SincePlant));
        Assert.Equal((1, -3, 4, 10), (k.VX, k.VY, k.VZ, k.KX)); // positions round half away from zero
        var round = s.Round(0);
        Assert.Equal((3, RoundResult.HowElim, 2000, 500), (round.WinSide, round.How, round.FreezeTick, round.DurTicks));
        Assert.Equal(3, round.Side[H]);
        Assert.Equal(800, round.Money[H]);
        Assert.Equal(2, _r.TallyOf(H).Hits);
        Assert.Equal(100, _r.TallyOf(H).Damage);
        Assert.Equal(1, _r.TallyOf(H).Kills);
        Assert.Equal(1, _r.TallyOf(B1).Deaths);
    }

    [Fact]
    public void TeamDamageIsKeptButNotTallied()
    {
        _r.Hurt(2100, B2, B1, 40, 0, 60, 0, Nil.V, false, Nil.V);
        _r.Flush();
        Assert.Single(_sink.Store.Damage.Span.ToArray());
        Assert.Equal(0, _r.TallyOf(B2).Damage);
    }

    [Fact]
    public void SuicideAndWorldDeathsHaveNoKillerOrAssister()
    {
        _r.Kill(new KillInput { Tick = 2200, Killer = B1, Victim = B1, Assister = B2, Weapon = 0, NadeType = Nil.V });
        _r.Flush();
        var k = _sink.Store.Kills[0];
        Assert.Equal((Nil.V, Nil.V, Nil.V), (k.Killer, k.Assister, k.FlashAssister));
        Assert.Equal(Nil.V, k.KX);
        Assert.Equal(1, _r.TallyOf(B1).Deaths);
        Assert.Equal(0, _r.TallyOf(B2).Assists);
    }

    [Fact]
    public void FlashAssistGoesToItsOwnColumnAndCountsAsAssist()
    {
        _r.Kill(new KillInput { Tick = 2200, Killer = H, Victim = B1, Assister = B2, AssistedFlash = true, Weapon = 0, NadeType = Nil.V });
        _r.Flush();
        var k = _sink.Store.Kills[0];
        Assert.Equal((Nil.V, B2), (k.Assister, k.FlashAssister));
        Assert.Equal(1, _r.TallyOf(B2).Assists);
    }

    [Fact]
    public void UtilityIsLinkedThrowToDetonationToBlindAndDamage()
    {
        _r.Throw(2100, B1, UtilType.Flash, 1, 2, 3);
        _r.Throw(2101, B1, UtilType.He, 1, 2, 3);
        _r.Throw(2102, B1, UtilType.Incendiary, 1, 2, 3);
        _r.Grenade(2150, B1, GrenadeType.Flash, 5, 5, 5);
        _r.Blind(2150, B1, H, 1800);
        _r.Blind(2150, B1, B1, 300); // self-flash is kept
        _r.Blind(2150, B1, B2, 0);   // zero duration is not a blind
        _r.Grenade(2160, B1, GrenadeType.He, 6, 6, 6);
        _r.Hurt(2160, B1, H, 40, 3, 60, _r.Weapons.Get("hegrenade"), 0, false, (int)GrenadeType.He);
        _r.Grenade(2170, B1, GrenadeType.Molotov, 7, 7, 7);
        _r.Hurt(2170 + 8 * 64, B1, H, 8, 0, 52, _r.Weapons.Get("inferno"), 0, false, (int)GrenadeType.Molotov);
        _r.Hurt(2170 + 8 * 64 + 1, B1, H, 8, 0, 44, _r.Weapons.Get("inferno"), 0, false, (int)GrenadeType.Molotov);
        _r.Kill(new KillInput { Tick = 2700, Killer = B1, Victim = H, Assister = Nil.V, Weapon = _r.Weapons.Get("hegrenade"), NadeType = (int)GrenadeType.He });
        _r.UtilBought(B2, UtilType.Smoke, 300);
        _r.UtilBought(B2, UtilType.Flash, 200);
        _r.UtilBought(B2, UtilType.Flash, 200);
        _r.UtilBought(B1, UtilType.He, Nil.V);
        _r.RoundEnd(2800, 2, 9);
        _r.Finalize(5, 2864);

        var s = _sink.Store;
        Assert.Equal(new[] { 0, 1, 2 }, s.Grenades.Span.ToArray().Select(g => g.Throw));
        Assert.Equal(new[] { 0, 0 }, s.Blinds.Span.ToArray().Select(b => b.Flash));
        Assert.Equal(2, s.Blinds.Count);
        Assert.Equal(new[] { 1, 2, Nil.V }, s.Damage.Span.ToArray().Select(d => d.Nade)); // the last fire tick is outside the 8 s window
        Assert.Equal(Nil.V, s.Kills[0].Nade); // the HE detonated 540 ticks earlier: outside the 1 s window
        var round = s.Round(0);
        Assert.Equal(new[] { 0, 2, 1, 0, 0, 0 }, round.UtilBought.Skip(B2 * 6).Take(6));
        Assert.Equal(700, round.UtilSpent[B2]);
        Assert.Equal(Nil.V, round.UtilSpent[B1]);
        Assert.Equal(0, round.UtilSpent[H]);
    }

    [Fact]
    public void UtilityLinksSurviveHandOffBetweenSegments()
    {
        _r.Throw(2100, B1, UtilType.Smoke, 0, 0, 0);
        _r.Grenade(2110, B1, GrenadeType.Smoke, 0, 0, 0);
        _r.Flush();
        _r.Throw(2200, B1, UtilType.Smoke, 0, 0, 0);
        _r.Flush();
        _r.Grenade(2210, B1, GrenadeType.Smoke, 0, 0, 0);
        _r.Flush();
        Assert.Equal(new[] { 0, 1 }, _sink.Store.Grenades.Span.ToArray().Select(g => g.Throw));
    }

    [Fact]
    public void UnknownResultCodeIsNullAndLogged()
    {
        _r.RoundEnd(2500, 3, 8);
        _r.Finalize(2, 2564);
        Assert.Equal(Nil.V, _sink.Store.Round(0).WinSide);
        Assert.Equal(Nil.V, _sink.Store.Round(0).How);
        Assert.Contains(_warnings, w => w.Contains("UNKNOWN MatchStats_RoundResults code 2"));
        Assert.Equal(new[] { 0 }, _sink.Store.Meta.UnknownResults);
    }

    [Fact]
    public void EventWinnerDisagreementIsLogged()
    {
        _r.RoundEnd(2500, 2, 9);
        _r.Finalize(1, 2564);
        Assert.Contains(_warnings, w => w.Contains("disagrees"));
        Assert.Equal(3, _sink.Store.Round(0).WinSide);
    }

    [Fact]
    public void ReconcileRecordsMismatchesWithNumbers()
    {
        _r.Hurt(2100, H, B1, 99, 0, 1, 0, 2, true, Nil.V);
        _r.RoundEnd(2500, 3, 8);
        _r.Finalize(1, 2564);
        var game = new GameRoundStats[Limits.MaxPlayers];
        var have = new bool[Limits.MaxPlayers];
        have[H] = have[B1] = true;
        game[H] = new GameRoundStats { Kills = 1, Damage = 100 }; // one kill we did not see; damage within rounding
        _r.Reconcile(0, game, have);
        _r.Flush();
        var rr = _sink.Store.ReconRounds[0];
        Assert.Equal((0, 2, 1, 2, 2, 2, 1), (rr.Ri, rr.Checked, rr.KillsOk, rr.DeathsOk, rr.AssistsOk, rr.DamageOk, rr.Missing));
        var m = Assert.Single(_sink.Store.Mismatches.Span.ToArray());
        Assert.Equal((0, H, ReconField.Kills, 0, 1), (m.Ri, m.Pi, m.Field, m.Ours, m.Game));
        Assert.Contains(_warnings, w => w.Contains("k ours 0 game 1"));
    }

    [Fact]
    public void ShotTargetAimErrorImpactAndHit()
    {
        // Human at origin, eye 64 up, facing +Y. Enemy 10 units right at distance 100, same eye height.
        _frames.ByPi[H] = new PlayerFrame { Present = true, Alive = true, Team = 3, X = 0, Y = 0, Z = 0, ViewZ = 64, Pitch = 0, Yaw = 90 };
        _frames.ByPi[B1] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 10, Y = 100, Z = 0, ViewZ = 64, Spot0 = 1u << 5 };
        _frames.ByPi[B2] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 0, Y = -100, Z = 0, ViewZ = 64, Spot0 = 1u << 5 };
        _frames.Active[0] = H; _frames.Active[1] = B1; _frames.Active[2] = B2; _frames.ActiveCount = 3;
        _frames.HumanSlot = 5;
        int ak = _r.Weapons.Get("ak47");
        _r.Shot(new ShotInput { Tick = 2100, Weapon = ak, Speed = 12, MaxSpeed = 215, Scoped = false, Ducked = true });
        _r.Impact(2100, 0, 1000, 64 - 17.455065f); // 1000 * tan(1 deg): 1 degree below the view
        _r.Impact(2100, 50, 50, 50); // later impacts of the same bullet are ignored
        _r.Hurt(2100, H, B1, 27, 4, 73, ak, 2, true, Nil.V);
        _r.Shot(new ShotInput { Tick = 2150, Weapon = ak, Speed = 230, MaxSpeed = 215 });
        _r.Flush();
        var shots = _sink.Store.Shots.Span.ToArray();
        Assert.Equal(2, shots.Length);
        Assert.Equal((B1, -571, 0, 0, 100, 2), (shots[0].Target, shots[0].AimErrYaw, shots[0].AimErrPitch, shots[0].ImpYaw, shots[0].ImpPitch, shots[0].Hit));
        Assert.Equal((1, 1, true), (shots[0].Burst, shots[0].Idx, shots[0].Ducked));
        Assert.Equal((2, 1, Nil.V), (shots[0].Impacts, shots[0].VisTarget, shots[0].Pen)); // non-fatal hit: pen unknown
        Assert.Equal((2, 1, Nil.V, Nil.V), (shots[1].Burst, shots[1].Idx, shots[1].Hit, shots[1].ImpYaw));
    }

    [Fact]
    public void TickBuildsEngagementsPositionsAndCtSetup()
    {
        _frames.ByPi[H] = new PlayerFrame { Present = true, Alive = true, Team = 3, X = 0, Y = 0, Z = 0, ViewZ = 64, Pitch = 0, Yaw = 90, Place = Nil.V };
        _frames.ByPi[B1] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 0, Y = 500, Z = 0, ViewZ = 64, Place = Nil.V };
        _frames.ByPi[B2] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = 0, Y = -500, Z = 0, ViewZ = 64, Place = Nil.V };
        _frames.Active[0] = H; _frames.Active[1] = B1; _frames.Active[2] = B2; _frames.ActiveCount = 3;
        _frames.HumanSlot = 0;
        _frames.ByPi[H].Place = _r.Places.Get("LongA");
        for (int t = 2000; t <= 2000 + 15 * 64; t++)
        {
            _frames.ByPi[B1].Spot0 = t >= 2010 && t < 2100 ? 1u : 0u;
            _r.Tick(t);
        }
        _r.RoundEnd(3000, 3, 8);
        _r.Finalize(1, 3064);
        var s = _sink.Store;
        var e = Assert.Single(s.Engagements.Span.ToArray());
        Assert.Equal((B1, 2010, 0, 2100), (e.Enemy, e.TVis, e.AngVis, e.TEnd));
        int humanSamples = s.Pos.Span.ToArray().Count(p => p.Pi == H);
        int botSamples = s.Pos.Span.ToArray().Count(p => p.Pi != H);
        Assert.Equal(15 * 4 + 1, humanSamples); // every 16 ticks from freeze end, inclusive of both ends
        Assert.Equal(2 * 16, botSamples);       // two bots, every 64 ticks
        Assert.True(s.Round(0).HasCtSetup);
        Assert.Equal(new[] { 1, 0, 0, 0, 0 }, s.Round(0).CtSetup);
    }

    [Fact]
    public void TickShotImpactAndHurtAllocateNothingAfterWarmup()
    {
        var sink = new ListSink();
        var frames = new FrameSet();
        var r = new Recorder(sink, frames, new PerfCounter(), _ => { });
        r.StartCapture(new MatchMeta { Id = "00000000000000000000000000000001", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { MaxRounds = 24 } });
        for (int i = 0; i < 10; i++) frames.Active[frames.ActiveCount++] = r.PlayerIndex("p" + i, "p" + i, i > 0);
        r.SetHuman(0);
        frames.HumanSlot = 0;
        int ak = r.Weapons.Get("ak47");
        r.Places.Get("LongA");
        long allocated = 0;

        void Round(int ri, bool measure)
        {
            int t0 = 100_000 * (ri + 1);
            r.BeginRound(ri, t0, 0, 0, false, Nil.V);
            for (int pi = 0; pi < 10; pi++) r.SetFreezePlayer(pi, pi < 5 ? 3 : 2, 800, 1000, 100, true);
            r.FreezeEnd(t0 + 1000);
            r.Grenade(t0 + 1000, 5, GrenadeType.Smoke, 0, 1400, 64, entityId: 9); // ahead of the human: shots run the smoke ray test
            for (int t = t0 + 1000; t < t0 + 1000 + 64 * 100; t++)
            {
                for (int pi = 0; pi < 10; pi++)
                {
                    ref var f = ref frames.ByPi[pi];
                    f.Present = true; f.Alive = true; f.Team = pi < 5 ? 3 : 2; f.ViewZ = 64; f.Place = 0;
                    f.X = pi * 50; f.Y = 800 + (t % 200); f.Z = 0; f.Yaw = 90 + (t % 30); f.Pitch = 0;
                    f.Spot0 = ((t / 40) + pi) % 3 == 0 ? 1u : 0u;
                }
                long a0 = GC.GetAllocatedBytesForCurrentThread();
                r.Tick(t);
                if (t % 7 == 0)
                {
                    r.Shot(new ShotInput { Tick = t, Weapon = ak, Speed = 100, MaxSpeed = 215 });
                    r.Impact(t, 100, 900, 60);
                    r.Impact(t, 100, 950, 60);
                    r.Hurt(t, 0, 5 + t % 5, 1, 0, 50, ak, 2, true, Nil.V);
                }
                if (measure) allocated += GC.GetAllocatedBytesForCurrentThread() - a0;
            }
            r.RoundEnd(t0 + 1000 + 64 * 100, 3, 8);
            r.Finalize(1, t0 + 1000 + 64 * 101);
        }

        Round(0, measure: false);
        Round(1, measure: true);
        Assert.True(sink.Store.Engagements.Count > 10);
        Assert.True(sink.Store.Shots.Count > 500);
        Assert.Contains(sink.Store.Shots.Span.ToArray(), x => x.Smoke == 1);
        Assert.Equal(0, allocated);
    }

    [Fact]
    public void PriorRoundsAreResultOnlyAndPartial()
    {
        var r = new Recorder(_sink, _frames, new PerfCounter(), _warnings.Add);
        r.StartCapture(new MatchMeta { Id = "ffffffffffffffffffffffffffffffff", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", FirstFullRound = 3 });
        r.AddPriorRound(0, 5);
        r.AddPriorRound(1, 6);
        r.AddPriorRound(2, 3);
        r.Flush();
        var s = _sink.Store;
        Assert.Equal(3, s.RoundCount);
        Assert.Equal(new[] { 2, 2, 3 }, Enumerable.Range(0, 3).Select(i => s.Round(i).WinSide));
        Assert.Equal(Nil.V, s.Round(1).FreezeTick);
        Assert.Equal(new[] { 0, 1, 2 }, s.Meta.PartialRounds);
    }
}

public class CodecTests
{
    internal static MatchStore SampleStore()
    {
        var sink = new ListSink();
        var frames = new FrameSet();
        var r = new Recorder(sink, frames, new PerfCounter(), _ => { });
        r.StartCapture(new MatchMeta { Id = "a1b2c3d4e5f60718293a4b5c6d7e8f90", Map = "de_dust2", StartUtc = "2026-10-24T22:14:29Z", Env = new EnvInfo { Plugin = "1.0.0", Cssharp = "1.0.378", MaxRounds = 24, BotDifficulty = 2 }, GameStart = 1234.5f });
        int h = r.PlayerIndex("76561199138360625", "me \"quoted\"", false);
        int b = r.PlayerIndex("B:Rock", "Rock", true);
        r.SetHuman(h);
        r.AddPriorRound(0, 5);
        r.BeginRound(1, 1000, 1, 0, false, Nil.V);
        r.SetFreezePlayer(h, 3, 800, 1000, 100, true);
        r.SetFreezePlayer(b, 2, 1000, 900, 100, true);
        r.FreezeEnd(1100);
        r.Throw(1150, b, UtilType.Molotov, 1, 2, 3);
        r.Grenade(1200, b, GrenadeType.Molotov, 4, 5, 6);
        r.Hurt(1210, b, h, 8, 0, 92, r.Weapons.Get("inferno"), 0, false, (int)GrenadeType.Molotov);
        r.Blind(1220, h, b, 1500);
        r.UtilBought(h, UtilType.Flash, 200);
        r.BombPlanted(1300, b, 1);
        r.Kill(new KillInput { Tick = 1400, Killer = h, Victim = b, Assister = Nil.V, Weapon = r.Weapons.Get("ak47"), Flags = 3, NadeType = Nil.V, VictimUtil = new UtilCounts { Known = true, Flash = 2 } });
        r.Kill(new KillInput { Tick = 1401, Killer = Nil.V, Victim = h, Assister = Nil.V, Weapon = r.Weapons.Get("world"), NadeType = Nil.V });
        frames.ByPi[h] = new PlayerFrame { Present = true, Alive = true, Team = 3, ViewZ = 64, Yaw = 90 };
        frames.Active[0] = h; frames.ActiveCount = 1;
        r.Shot(new ShotInput { Tick = 1390, Weapon = r.Weapons.Get("ak47"), Speed = 3, MaxSpeed = 215, Scoped = true });
        r.RoundEnd(1500, 3, 8);
        r.SetRoundEndEconomy(h, 0, false);
        r.SetRoundEndEconomy(b, 0, false);
        r.Finalize(1, 1564);
        return sink.Store;
    }

    private static string Encode(MatchStore s, bool inProgress)
    {
        using var ms = new MemoryStream();
        MatchCodec.Write(s, ms, inProgress);
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    [Fact]
    public void RoundTripIsLossless()
    {
        var s = SampleStore();
        string json = Encode(s, inProgress: true);
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(Encoding.UTF8.GetBytes(json)), back);
        Assert.Equal(json, Encode(back, inProgress: true));
        Assert.Equal(1234.5f, back.Meta.GameStart);
        Assert.Equal(s.Grenades.Count, back.Meta.GrenadeCount);
    }

    [Fact]
    public void SchemaShapeAndNulls()
    {
        using var doc = JsonDocument.Parse(Encode(SampleStore(), inProgress: false));
        var root = doc.RootElement;
        Assert.Equal(1, root.GetProperty("v").GetInt32());
        Assert.False(root.TryGetProperty("resume", out _));
        Assert.Equal("de_dust2", root.GetProperty("map").GetString());
        var rounds = root.GetProperty("rounds");
        Assert.Equal(JsonValueKind.Null, rounds.GetProperty("freezeTick")[0].ValueKind); // prior round
        Assert.Equal("elim", rounds.GetProperty("how")[1].GetString());
        Assert.Equal("B", rounds.GetProperty("bombSite")[1].GetString());
        Assert.Equal("[1,0]", rounds.GetProperty("score")[1].GetRawText());
        Assert.Equal("[3,2]", rounds.GetProperty("side")[1].GetRawText());
        Assert.Equal("[[0,1,0,0,0,0],[0,0,0,0,0,0]]", rounds.GetProperty("utilBought")[1].GetRawText());
        Assert.Equal("[null,null]", rounds.GetProperty("utilBought")[0].GetRawText());
        var kills = root.GetProperty("kills");
        Assert.Equal(JsonValueKind.Null, kills.GetProperty("killer")[1].ValueKind);
        Assert.Equal(JsonValueKind.Null, kills.GetProperty("kpos")[1].ValueKind);
        Assert.Equal("[0,2,0,0,0,0]", kills.GetProperty("vUtil")[0].GetRawText());
        Assert.Equal(JsonValueKind.Null, kills.GetProperty("vUtil")[1].ValueKind);
        Assert.Equal(8, kills.GetProperty("state")[0].GetArrayLength());
        Assert.Equal(0, root.GetProperty("damage").GetProperty("nade")[0].GetInt32());
        Assert.Equal(0, root.GetProperty("grenades").GetProperty("throw")[0].GetInt32());
        Assert.Equal("molotov", root.GetProperty("throws").GetProperty("type")[0].GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("blinds").GetProperty("flash")[0].ValueKind);
        Assert.Equal("me \"quoted\"", root.GetProperty("players").GetProperty("name")[0].GetString());
        var shot = root.GetProperty("aim").GetProperty("shots");
        Assert.True(shot.GetProperty("scoped")[0].GetBoolean());
        Assert.Equal(JsonValueKind.Null, shot.GetProperty("impact")[0].ValueKind);
    }

    [Fact]
    public void UnknownRoundResultRoundTrips()
    {
        var sink = new ListSink();
        var r = new Recorder(sink, new FrameSet(), new PerfCounter(), _ => { });
        r.StartCapture(new MatchMeta { Id = "22222222222222222222222222222222", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z" });
        r.AddPriorRound(0, 2); // unknown code: how is null
        r.Flush();
        using var ms = new MemoryStream();
        MatchCodec.Write(sink.Store, ms, inProgress: true);
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(ms.ToArray()), back);
        Assert.Equal(Nil.V, back.Round(0).How);
        Assert.Equal(new[] { 0 }, back.Meta.UnknownResults);
    }

    [Fact]
    public void RejectsOtherVersions()
    {
        var bad = Encoding.UTF8.GetBytes("{\"v\":2}");
        var ex = Assert.Throws<InvalidDataException>(() => MatchCodec.Read(new MemoryStream(bad), new MatchStore()));
        Assert.Contains("version 2", ex.Message);
    }
}

public class WriterTests
{
    [Fact]
    public void InProgressFinalAndResumeScan()
    {
        string root = Path.Combine(Path.GetTempPath(), "bms-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = CodecTests.SampleStore();
            var meta = store.Meta;
            using (var w = new MatchWriter(root, null))
            {
                // Replay the sample through the real writer: one in-progress write.
                var buf = w.Rent();
                var job = new WriteJob { Kind = JobKind.InProgress, Buffer = buf, Meta = meta.Clone() };
                CopyInto(store, buf);
                w.Submit(job);
                Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
                string inprog = Path.Combine(w.InProgressDir, meta.BaseName + ".json.gz");
                Assert.True(File.Exists(inprog));
                Assert.Empty(Directory.GetFiles(w.InProgressDir, "*.tmp"));

                // A scan for the same game resumes it; a scan for another game abandons it.
                w.RequestScan(meta.Map, meta.GameStart, 1);
                Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
                var msgs = Drain(w);
                var resume = Assert.Single(msgs, m => m.Resume != null);
                Assert.Equal(meta.Id, resume.Resume!.Id);
                Assert.Equal(2, resume.ResumeRounds);
                Assert.Contains(msgs, m => m.ScanDone);

                w.RequestScan(meta.Map, meta.GameStart + 100, 2);
                Assert.True(w.Drain(TimeSpan.FromSeconds(10)));
                Assert.False(File.Exists(inprog));
                string final = Path.Combine(w.MatchesDir, "2026", meta.BaseName + ".json.gz");
                Assert.True(File.Exists(final));
                using var gz = new GZipStream(File.OpenRead(final), CompressionMode.Decompress);
                using var doc = JsonDocument.Parse(gz);
                Assert.Equal("abandoned", doc.RootElement.GetProperty("status").GetString());
                Assert.Equal("20261024T221429Z_de_dust2_a1b2c3d4", meta.BaseName);
            }
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

    private static void CopyInto(MatchStore s, RoundBuffer b)
    {
        foreach (var r in s.Kills.Span) b.Kills.Add(r);
        foreach (var r in s.Damage.Span) b.Damage.Add(r);
        foreach (var r in s.Blinds.Span) b.Blinds.Add(r);
        foreach (var r in s.Grenades.Span) b.Grenades.Add(r);
        foreach (var r in s.Throws.Span) b.Throws.Add(r);
        foreach (var r in s.Shots.Span) b.Shots.Add(r);
        for (int i = 0; i < s.RoundCount; i++) b.AddRound(s.Round(i));
    }
}
