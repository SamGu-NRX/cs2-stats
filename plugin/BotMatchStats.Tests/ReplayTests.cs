using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using BotMatchStats.Core;
using Xunit.Abstractions;

namespace BotMatchStats.Tests;

/// <summary>
/// Replays the second match in fixtures/events_two_matches.jsonl (21 rounds, logged by the probe
/// plugin) through the recorder and the real writer, running the per-tick path for every tick
/// between events with frames rebuilt from the last known positions. The fixture has no spotted
/// masks, so visibility is synthetic: an enemy counts as visible within 3000 units and 60° of the
/// human's view. Reconciliation is checked against the game's own per-round stats in
/// fixtures/de_dust2_20261024_180954_match_end.json. Events are parsed before the replay so the
/// timings and allocation counts cover only recorder work.
/// </summary>
[Collection(AllocMeter.Collection)]
public class ReplayTests
{
    private readonly ITestOutputHelper _out;
    public ReplayTests(ITestOutputHelper output) => _out = output;

    private sealed class Who
    {
        public string Name = "";
        public bool IsBot;
        public int Team, Hp, Money;
        public float X, Y, Z, Yaw, Pitch;
    }

    private sealed class Ev
    {
        public string Type = "";
        public int Tick, Round, I1, I2, I3, I4;
        public bool F1;
        public float X, Y, Z;
        public string Weapon = "";
        public Who? A, B, C;
        public List<Who>? List;
    }

    private static string FixtureDir()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "fixtures", "events_two_matches.jsonl"))) d = d.Parent;
        return d == null ? throw new FileNotFoundException("fixtures/events_two_matches.jsonl not found above " + AppContext.BaseDirectory) : Path.Combine(d.FullName, "fixtures");
    }

    private static Who? ParseWho(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        var w = new Who
        {
            Name = e.GetProperty("PlayerName").GetString()!,
            IsBot = e.GetProperty("IsBot").GetBoolean(),
            Team = e.GetProperty("Team").GetInt32(),
            Hp = e.GetProperty("Hp").ValueKind == JsonValueKind.Number ? e.GetProperty("Hp").GetInt32() : 0,
            Money = e.TryGetProperty("Money", out var m) && m.ValueKind == JsonValueKind.Number ? m.GetInt32() : Nil.V,
        };
        if (e.GetProperty("Pos") is { ValueKind: JsonValueKind.Array } p) { w.X = p[0].GetSingle(); w.Y = p[1].GetSingle(); w.Z = p[2].GetSingle(); }
        if (e.GetProperty("Yaw").ValueKind == JsonValueKind.Number) w.Yaw = e.GetProperty("Yaw").GetSingle();
        if (e.GetProperty("Pitch").ValueKind == JsonValueKind.Number) w.Pitch = e.GetProperty("Pitch").GetSingle();
        return w;
    }

    private static Ev Parse(JsonElement e)
    {
        var d = e.GetProperty("Data");
        var ev = new Ev { Type = e.GetProperty("T").GetString()!, Tick = e.GetProperty("Tick").GetInt32(), Round = e.GetProperty("Round").GetInt32() };
        void Pos(JsonElement p) { ev.X = p[0].GetSingle(); ev.Y = p[1].GetSingle(); ev.Z = p[2].GetSingle(); }
        switch (ev.Type)
        {
            case "freeze_end": ev.List = d.EnumerateArray().Select(x => ParseWho(x)!).ToList(); break;
            case "hurt":
                ev.A = ParseWho(d.GetProperty("Victim")); ev.B = ParseWho(d.GetProperty("Attacker"));
                ev.Weapon = d.GetProperty("Weapon").GetString()!;
                ev.I1 = d.GetProperty("DmgHealth").GetInt32(); ev.I2 = d.GetProperty("DmgArmor").GetInt32();
                ev.I3 = d.GetProperty("Health").GetInt32(); ev.I4 = d.GetProperty("Hitgroup").GetInt32();
                break;
            case "death":
                ev.A = ParseWho(d.GetProperty("Victim")); ev.B = ParseWho(d.GetProperty("Attacker")); ev.C = ParseWho(d.GetProperty("Assister"));
                ev.Weapon = d.GetProperty("Weapon").GetString()!;
                ev.I1 = (d.GetProperty("Headshot").GetBoolean() ? 1 : 0) | (d.GetProperty("Penetrated").GetInt32() > 0 ? 2 : 0)
                    | (d.GetProperty("Thrusmoke").GetBoolean() ? 4 : 0) | (d.GetProperty("Attackerblind").GetBoolean() ? 8 : 0) | (d.GetProperty("Noscope").GetBoolean() ? 16 : 0);
                ev.F1 = d.GetProperty("Assistedflash").GetBoolean();
                break;
            case "blind":
                ev.A = ParseWho(d.GetProperty("Victim")); ev.B = ParseWho(d.GetProperty("Attacker"));
                ev.I1 = (int)Math.Round(d.GetProperty("BlindDuration").GetSingle() * 1000);
                break;
            case "fire":
                ev.A = ParseWho(d.GetProperty("Shooter"));
                ev.Weapon = WeaponNames.Strip(d.GetProperty("Weapon").GetString()!);
                AimMath.Forward(ev.A!.Pitch, ev.A.Yaw, out double fx, out double fy, out double fz);
                ev.X = (float)(ev.A.X + fx * 1000); ev.Y = (float)(ev.A.Y + fy * 1000); ev.Z = (float)(ev.A.Z + 64 + fz * 1000);
                break;
            case "plant": case "defuse": ev.A = ParseWho(d.GetProperty("Player")); break;
            case "he": case "flash": case "smoke": ev.A = ParseWho(d.GetProperty("Thrower")); Pos(d.GetProperty("Pos")); break;
            case "inferno": Pos(d.GetProperty("Pos")); break;
            case "buy": ev.A = ParseWho(d.GetProperty("Player")); ev.Weapon = d.GetProperty("Weapon").GetString()!; break;
            case "round_end": ev.I1 = d.GetProperty("Winner").GetInt32(); ev.I2 = d.GetProperty("Reason").GetInt32(); break;
        }
        return ev;
    }

    private static long Gz(MatchStore s, CompressionLevel level)
    {
        using var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, level, leaveOpen: true)) MatchCodec.Write(s, gz, inProgress: false);
        return ms.Length;
    }

    [Fact]
    public void FixtureMatchReconcilesAndMeetsBudget()
    {
        string dir = FixtureDir();
        var raw = File.ReadAllLines(Path.Combine(dir, "events_two_matches.jsonl")).Select(l => JsonDocument.Parse(l).RootElement).ToList();
        string Ty(int i) => raw[i].GetProperty("T").GetString()!;
        int Rd(int i) => raw[i].GetProperty("Round").GetInt32();
        int start = Enumerable.Range(1, raw.Count - 1).First(i => Ty(i) == "round_start" && Rd(i) == 0 && Ty(i - 1) == "round_end" && Rd(i - 1) == 0);
        int end = Enumerable.Range(start + 1, raw.Count - start - 1).First(i => Ty(i) == "round_start" && Rd(i) == 0);
        var events = raw.Skip(start).Take(end - start).Select(Parse).ToList();

        using var endDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "de_dust2_20261024_180954_match_end.json")));
        var endRoot = endDoc.RootElement;
        var results = endRoot.GetProperty("RoundResults").EnumerateArray().Select(x => x.GetInt32()).ToArray();
        var gameStats = new Dictionary<(int ri, string name), GameRoundStats>();
        var steam = new Dictionary<string, ulong>();
        foreach (var p in endRoot.GetProperty("Players").EnumerateArray())
        {
            string name = p.GetProperty("PlayerName").GetString()!;
            steam[name] = p.GetProperty("SteamID").GetUInt64();
            int ri = 0;
            foreach (var r in p.GetProperty("Rounds").EnumerateArray())
                gameStats[(ri++, name)] = new GameRoundStats { Kills = r.GetProperty("Kills").GetInt32(), Deaths = r.GetProperty("Deaths").GetInt32(), Assists = r.GetProperty("Assists").GetInt32(), Damage = r.GetProperty("Damage").GetInt32() };
        }

        string root = Path.Combine(Path.GetTempPath(), "bms-replay-" + Guid.NewGuid().ToString("N"));
        var warnings = new List<string>();
        var frames = new FrameSet();
        var perf = new PerfCounter();
        using var writer = new MatchWriter(root, null);
        Assert.True(writer.Drain(TimeSpan.FromSeconds(10))); // let the worker pre-warm its pool
        var rec = new Recorder(writer, frames, perf, warnings.Add);
        var pis = new Dictionary<string, int>();
        var last = new Who?[Limits.MaxPlayers];
        int human = Nil.V;
        var game = new GameRoundStats[Limits.MaxPlayers];
        var have = new bool[Limits.MaxPlayers];
        var pinames = new string[Limits.MaxPlayers];

        int Pi(Who? w)
        {
            if (w == null) return Nil.V;
            if (!pis.TryGetValue(w.Name, out int pi))
            {
                pi = rec.PlayerIndex(w.IsBot ? "B:" + w.Name : steam[w.Name].ToString(System.Globalization.CultureInfo.InvariantCulture), w.Name, w.IsBot);
                pis[w.Name] = pi;
                pinames[pi] = w.Name;
                frames.Active[frames.ActiveCount++] = pi;
                if (!w.IsBot) { human = pi; rec.SetHuman(pi); }
            }
            last[pi] = w;
            return pi;
        }

        // Measurements. Arrays are allocated up front so measuring does not allocate.
        var tickDur = new long[200_000];
        int tickN = 0;
        long tickAlloc = 0, tickAllocLater = 0, evMax = 0, evN = 0, evTs = 0;
        // AllocMeter: a GC pause spoils a reading by up to one allocation context, so a paused tick is held to
        // that slack instead of to zero; every 512th tick also reads exactly, inside a no-GC region
        int ticksPaused = 0, ticksExact = 0;
        long pausedMax = 0;
        var evDur = new long[10_000];
        string evMaxName = "";
        var allocTicks = new (int tick, long bytes)[32];
        int allocTickN = 0;
        var evAllocByRound = new List<long>();
        long evAllocRound = 0;
        int finalizeAt = Nil.V, prevTick = Nil.V;

        void FillFrames()
        {
            const int hs = 0;
            frames.HumanSlot = hs;
            Who? hw = human != Nil.V ? last[human] : null;
            for (int i = 0; i < frames.ActiveCount; i++)
            {
                int pi = frames.Active[i];
                var w = last[pi]!;
                ref var f = ref frames.ByPi[pi];
                f.Present = true;
                f.Alive = rec.IsAlive(pi);
                f.Team = w.Team;
                f.X = w.X; f.Y = w.Y; f.Z = w.Z; f.ViewZ = 64; f.Pitch = w.Pitch; f.Yaw = w.Yaw;
                f.Place = Nil.V;
                bool vis = false;
                if (hw != null && pi != human && w.Team != hw.Team)
                {
                    double dx = w.X - hw.X, dy = w.Y - hw.Y, dz = w.Z - hw.Z;
                    vis = Math.Sqrt(dx * dx + dy * dy + dz * dz) < 3000 && AimMath.AngleToDeg(hw.Pitch, hw.Yaw, dx, dy, dz) < 60;
                }
                f.Spot0 = vis ? 1u << hs : 0u;
                f.Spot1 = 0;
            }
        }

        void Finalize(int tick)
        {
            rec.Finalize(results[rec.Ri], tick);
            writer.Drain(TimeSpan.FromSeconds(10)); // rounds are ~100 s apart in a real match; the worker has long finished
        }

        void RunTicksUntil(int tick)
        {
            if (prevTick == Nil.V) { prevTick = tick; return; }
            for (int t = prevTick + 1; t < tick; t++)
            {
                if (finalizeAt != Nil.V && t >= finalizeAt) { finalizeAt = Nil.V; Finalize(t); }
                if (!rec.Live) continue;
                var meter = AllocMeter.Start(exact: rec.Ri > 0 && t % 512 == 0);
                long t0 = Stopwatch.GetTimestamp();
                FillFrames();
                rec.Tick(t);
                long dt = Stopwatch.GetTimestamp() - t0;
                var (bytes, paused, exact) = meter.Read();
                if (exact) ticksExact++;
                if (paused && rec.Ri > 0) { ticksPaused++; pausedMax = Math.Max(pausedMax, bytes); }
                long da = paused ? 0 : bytes;
                if (da != 0 && allocTickN < allocTicks.Length) allocTicks[allocTickN++] = (t, da);
                tickAlloc += da;
                if (rec.Ri > 0) tickAllocLater += da;
                if (rec.Ri > 0 && tickN < tickDur.Length) tickDur[tickN++] = dt;
            }
            prevTick = tick;
        }

        rec.StartCapture(new MatchMeta { Id = "feedfacefeedfacefeedfacefeedface", Map = "de_dust2", StartUtc = "2026-10-24T22:50:00Z", Env = new EnvInfo { Plugin = "replay", MaxRounds = 24 }, GameStart = 4500f });
        foreach (var e in events)
        {
            RunTicksUntil(e.Tick);
            int tick = e.Tick;
            if (e.Type == "round_start" && rec.RoundActive)
            {
                if (finalizeAt != Nil.V) { finalizeAt = Nil.V; Finalize(tick); }
                Array.Clear(have);
                for (int pi = 0; pi < rec.PlayerCount; pi++)
                    if (gameStats.TryGetValue((rec.Ri, pinames[pi]), out var s)) { game[pi] = s; have[pi] = true; }
                evAllocByRound.Add(evAllocRound);
                evAllocRound = 0;
            }

            long t0 = Stopwatch.GetTimestamp(), a0 = GC.GetAllocatedBytesForCurrentThread();
            switch (e.Type)
            {
                case "round_start":
                    if (rec.RoundActive) { rec.Reconcile(rec.Ri, game, have); rec.Flush(); }
                    rec.BeginRound(e.Round, tick, Nil.V, Nil.V, partial: false, Nil.V);
                    break;
                case "freeze_end":
                    foreach (var w in e.List!)
                    {
                        int pi = Pi(w);
                        rec.SetTeam(pi, w.Team);
                        rec.SetFreezePlayer(pi, w.Team, w.Money, Nil.V, w.Hp, w.Hp > 0);
                    }
                    rec.FreezeEnd(tick);
                    break;
                case "hurt":
                {
                    int a = Pi(e.B), v = Pi(e.A);
                    rec.Hurt(tick, a, v, e.I1, e.I2, e.I3, e.Weapon.Length == 0 ? Nil.V : rec.Weapons.Get(e.Weapon), e.I4,
                        WeaponNames.IsBulletWeapon(e.Weapon), WeaponNames.NadeSourceOf(e.Weapon));
                    if (v != Nil.V) rec.HitMask(tick, a, v, frames.ByPi[v].Spot0 | (uint)(tick & 0x3FF) << 10, 0u, true); // synthetic mask values
                    break;
                }
                case "death":
                    rec.Kill(new KillInput
                    {
                        Tick = tick, Victim = Pi(e.A), Killer = Pi(e.B), Assister = Pi(e.C), AssistedFlash = e.F1,
                        Weapon = rec.Weapons.Get(e.Weapon), Flags = e.I1, NadeType = WeaponNames.NadeSourceOf(e.Weapon),
                        VX = e.A!.X, VY = e.A.Y, VZ = e.A.Z,
                        HasKillerPos = e.B != null, KX = e.B?.X ?? 0, KY = e.B?.Y ?? 0, KZ = e.B?.Z ?? 0,
                    });
                    break;
                case "blind": rec.Blind(tick, Pi(e.B), Pi(e.A), e.I1); break;
                case "fire":
                    if (Pi(e.A) == human && WeaponNames.IsBulletWeapon(e.Weapon))
                    {
                        FillFrames();
                        rec.Shot(new ShotInput { Tick = tick, Weapon = rec.Weapons.Get(e.Weapon), Speed = 0, MaxSpeed = 250 });
                        rec.Impact(tick, e.X, e.Y, e.Z);
                    }
                    break;
                case "plant": rec.BombPlanted(tick, Pi(e.A), Nil.V); break;
                case "defuse": rec.BombDefused(tick, Pi(e.A)); break;
                case "he": rec.Grenade(tick, Pi(e.A), GrenadeType.He, e.X, e.Y, e.Z); break;
                case "flash": rec.Grenade(tick, Pi(e.A), GrenadeType.Flash, e.X, e.Y, e.Z); break;
                case "smoke": rec.Grenade(tick, Pi(e.A), GrenadeType.Smoke, e.X, e.Y, e.Z); break;
                case "inferno": rec.Grenade(tick, Nil.V, GrenadeType.Molotov, e.X, e.Y, e.Z); break;
                case "buy":
                    if (WeaponNames.TryUtilType(e.Weapon, out var ut)) rec.UtilBought(Pi(e.A), ut, Nil.V);
                    break;
                case "round_end":
                    rec.RoundEnd(tick, e.I1, e.I2);
                    finalizeAt = tick + 64;
                    break;
            }
            long dt = Stopwatch.GetTimestamp() - t0;
            evAllocRound += GC.GetAllocatedBytesForCurrentThread() - a0;
            evTs += dt;
            if (rec.Ri > 0 && evN < evDur.Length) evDur[evN] = dt;
            evN++;
            if (rec.Ri > 0 && dt > evMax) { evMax = dt; evMaxName = e.Type; }
            if (e.Type == "round_start") writer.Drain(TimeSpan.FromSeconds(10));
        }
        RunTicksUntil(prevTick + 65);
        if (rec.RoundActive && !rec.RoundFinalized) Finalize(prevTick);
        Array.Clear(have);
        for (int pi = 0; pi < rec.PlayerCount; pi++)
            if (gameStats.TryGetValue((rec.Ri, pinames[pi]), out var s)) { game[pi] = s; have[pi] = true; }
        rec.Reconcile(rec.Ri, game, have);
        evAllocByRound.Add(evAllocRound);
        rec.EndCapture("complete", "2026-10-24T23:10:00Z", prevTick);
        Assert.True(writer.Drain(TimeSpan.FromSeconds(30)));

        string final = Path.Combine(writer.MatchesDir, "2026", "20261024T225000Z_de_dust2_feedface.json.gz");
        long bytes = new FileInfo(final).Length;
        var store = new MatchStore();
        using (var gz = new GZipStream(File.OpenRead(final), CompressionMode.Decompress)) MatchCodec.Read(gz, store);
        double Us(long ts) => ts * 1e6 / Stopwatch.Frequency;
        var sorted = tickDur.Take(tickN).OrderBy(x => x).ToArray();
        double Pct(double p) => Us(sorted[Math.Min(sorted.Length - 1, (int)(sorted.Length * p))]);

        var evSorted = evDur.Where(x => x > 0).OrderBy(x => x).ToArray();
        double EvPct(double p) => Us(evSorted[Math.Min(evSorted.Length - 1, (int)(evSorted.Length * p))]);
        var mism = store.Mismatches.Span.ToArray();
        _out.WriteLine($"rounds {store.RoundCount}, kills {store.Kills.Count}, damage {store.Damage.Count}, blinds {store.Blinds.Count}, grenades {store.Grenades.Count}, pos {store.Pos.Count}, engagements {store.Engagements.Count}, shots {store.Shots.Count}");
        _out.WriteLine($"file {bytes} bytes gzip; last write {store.LastWriteMs:F1} ms, max write {store.MaxWriteMs:F1} ms (worker thread)");
        _out.WriteLine($"tick path (rounds >= 1): {tickN} ticks, avg {Us(sorted.Sum()) / tickN:F2} us, p50 {Pct(0.5):F2}, p99 {Pct(0.99):F2}, p99.9 {Pct(0.999):F2}, max {Us(sorted[^1]):F1} us");
        _out.WriteLine($"tick path allocated {tickAlloc} bytes in total, {tickAllocLater} in rounds >= 1; ticks that allocated: {string.Join(", ", allocTicks.Take(allocTickN).Select(a => $"{a.tick}:{a.bytes}"))}; {ticksExact} ticks read exactly; {ticksPaused} ticks paused by a GC, at most {pausedMax} bytes");
        _out.WriteLine($"recorder event calls: {evN}, avg {Us(evTs) / evN:F2} us, p99 {EvPct(0.99):F1}, p99.9 {EvPct(0.999):F1}, max {Us(evMax):F1} us ({evMaxName}, rounds >= 1)");
        _out.WriteLine($"event-path allocation per round (bytes): {string.Join(", ", evAllocByRound)}");
        _out.WriteLine($"buffer pool misses on the game thread: {writer.BufferMisses}");
        _out.WriteLine($"recon: {store.ReconRounds.Count} rounds checked, mismatches: {mism.Length}; capUnknown {store.CapUnknown}");
        foreach (var m in mism) _out.WriteLine($"  r{m.Ri} pi{m.Pi} {m.Field} ours {m.Ours} game {m.Game} hits {m.Hits}");
        foreach (var w in warnings.Take(10)) _out.WriteLine("  warn: " + w);

        try
        {
            Assert.Equal(21, store.RoundCount);
            Assert.Equal(21, store.ReconRounds.Count);
            Assert.Empty(mism);
            Assert.True(store.HitMask.Count > 0);
            _out.WriteLine($"hitMask rows {store.HitMask.Count}");
            Assert.True(store.Engagements.Count > 0);
            Assert.True(store.Shots.Count > 0);
            Assert.All(Enumerable.Range(0, 21), ri => Assert.Equal(RoundResult.FromMatchStatsCode(results[ri], out int ws, out _) ? ws : Nil.V, store.Round(ri).WinSide));
            Assert.Equal(0, writer.BufferMisses); // the pre-warmed pool covers every hand-off
            Assert.Equal(0, tickAllocLater);
            Assert.True(ticksPaused < tickN / 100, $"{ticksPaused} of {tickN} ticks were paused by a GC"); // the zero check still covers almost every tick
            Assert.InRange(pausedMax, 0, AllocMeter.PausedSlack); // a paused tick allocating more than a pause can add
            Assert.True(ticksExact >= 50, $"only {ticksExact} ticks were read exactly");

            // Size breakdown last: it clears tables.
            foreach (var level in new[] { CompressionLevel.Fastest, CompressionLevel.Optimal })
            {
                var sw = Stopwatch.StartNew();
                long size = Gz(store, level);
                _out.WriteLine($"gzip {level}: {size} bytes, encode+compress {sw.Elapsed.TotalMilliseconds:F1} ms");
            }
            long full = Gz(store, CompressionLevel.Fastest);
            store.Pos.Clear();
            long noPos = Gz(store, CompressionLevel.Fastest);
            store.Shots.Clear();
            long noShots = Gz(store, CompressionLevel.Fastest);
            _out.WriteLine($"size share: pos {full - noPos} bytes, aim.shots {noPos - noShots} bytes, everything else {noShots} bytes");
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
