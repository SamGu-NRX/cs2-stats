using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;

namespace BotMatchStats.Core;

/// <summary>
/// Compiles and exercises the engine-free recording code before a match needs it.
///
/// Why: the recordings' perf rows show every budget violation is a first call. Round 0's round_start
/// took 16-21 ms and its slowest tick 4.4-4.7 ms; round 1's housekeeping (the first round hand-off)
/// took 8-16 ms. From round 2 on, ticks average 2-5 µs with a maximum of 255 µs and handlers stay
/// under 125 µs, apart from the first bomb plant and first hurt (about 0.7 ms each). First calls pay
/// for JIT compilation of each method and of each generic instantiation it touches, so compiling
/// them early removes the spikes without changing what is recorded.
///
/// How: <see cref="Run"/> plays a short scripted match on a private <see cref="Recorder"/> whose
/// sink discards everything, encodes it once, then asks the runtime to compile every remaining
/// method of the Core types. It touches no engine state and no shared mutable state, so it runs on a
/// background thread at plugin load. Code shared with the live recorder is compiled once per process.
/// </summary>
public static class Warmup
{
    private sealed class DiscardSink : IRecorderSink
    {
        public readonly MatchStore Store = new();
        public RoundBuffer Rent() => new();
        public void Submit(WriteJob job)
        {
            if (Store.Meta.Id != job.Meta.Id) Store.Clear();
            Store.Append(job.Buffer!);
            Store.Meta = job.Meta;
        }
    }

    private sealed class AlternatingProbe : ILosProbe
    {
        private int _n;
        public bool? Clear(double ax, double ay, double az, double bx, double by, double bz) => (_n++ & 1) == 0;
    }

    /// <summary>Plays the script and compiles Core. Returns how long it took. Never throws.</summary>
    public static TimeSpan Run(Action<string>? onError = null)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            Script();
            PrepareAssemblyMethods(typeof(Recorder).Assembly, t => t.Namespace == typeof(Recorder).Namespace);
        }
        catch (Exception ex)
        {
            onError?.Invoke($"warm-up failed: {ex.GetType().Name}: {ex.Message}");
        }
        return sw.Elapsed;
    }

    /// <summary>
    /// Compiles every non-generic, non-abstract method declared by the selected types of an assembly.
    /// Compiling does not run the code. Callers choose which types; engine-bound types must only be
    /// prepared on the game thread.
    /// </summary>
    public static int PrepareAssemblyMethods(Assembly asm, Func<Type, bool> include)
    {
        int n = 0;
        const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        foreach (var t in asm.GetTypes())
        {
            if (t.ContainsGenericParameters || !include(t)) continue;
            foreach (var m in t.GetMethods(all))
            {
                if (m.IsAbstract || m.ContainsGenericParameters || m.GetMethodBody() == null) continue;
                try { RuntimeHelpers.PrepareMethod(m.MethodHandle); n++; } catch (Exception) { /* a method the runtime will not pre-compile is compiled on first call instead */ }
            }
            foreach (var c in t.GetConstructors(all))
            {
                if (c.IsStatic || c.GetMethodBody() == null) continue;
                try { RuntimeHelpers.PrepareMethod(c.MethodHandle); n++; } catch (Exception) { }
            }
        }
        return n;
    }

    /// <summary>One capture with every recorder entry point the game layer calls, in the order a match calls them.</summary>
    private static void Script()
    {
        var sink = new DiscardSink();
        var frames = new FrameSet();
        var perf = new PerfCounter();
        var r = new Recorder(sink, frames, perf, static _ => { });
        r.Los.Attach(new AlternatingProbe());
        r.StartCapture(new MatchMeta { Id = "warmup", Map = "de_dust2", StartUtc = "2026-01-01T00:00:00Z", Env = new EnvInfo { Plugin = "warmup", MaxRounds = 24 } });
        const int n = 10;
        for (int i = 0; i < n; i++) r.PlayerIndex(i == 0 ? "76561190000000001" : "B:w" + i, "w" + i, i != 0);
        r.SetHuman(0);
        for (int i = 0; i < n; i++) { r.SetTeam(i, i < 5 ? 3 : 2); r.SetAlive(i, true, 100); }
        r.AddPriorRound(0, 1);
        r.BeginRound(1, 1000, 1, 0, partial: false, Nil.V);
        for (int i = 0; i < n; i++) r.SetFreezePlayer(i, i < 5 ? 3 : 2, 800, 4700, 100, true);
        r.SetEquipSource(Recorder.EquipFromPawn);
        r.SetHumanEntities(0, 1, 200);
        r.FreezeEnd(2000);
        r.Places.Lookup(Encoding.UTF8.GetBytes("LongA\0"));

        int weapon = r.Weapons.Get("ak47");
        frames.ActiveCount = n;
        for (int t = 2000; t < 2000 + 64 * 16; t++)
        {
            for (int i = 0; i < n; i++)
            {
                frames.Active[i] = i;
                frames.ByPi[i] = new PlayerFrame
                {
                    Present = true, Alive = true, Team = i < 5 ? 3 : 2, X = i * 100 + (t & 7), Y = i * 50, Z = 0, ViewZ = 64,
                    Pitch = 0, Yaw = (t % 360) - 180, Spot0 = (t & 64) != 0 ? 1u : 0u, Place = Nil.V,
                };
            }
            r.Tick(t);
            if (t % 16 == 0)
            {
                r.Shot(new ShotInput { Tick = t, Weapon = weapon, Class = 0, Speed = 50, MaxSpeed = 215 });
                r.Impact(t, 500, 300, 60);
                r.Hurt(t, 0, 5 + (t / 16) % 5, 27, 3, 50, weapon, 2, true, Nil.V);
                r.HitMask(t, 0, 5, 1u, 0u, true);
            }
        }
        r.SetEquipNow(1, 3000);
        r.Throw(2100, 1, UtilType.Flash, 1, 2, 3);
        r.Grenade(2150, 1, GrenadeType.Flash, 1, 2, 3);
        r.Blind(2150, 1, 6, 1500);
        r.Throw(2160, 6, UtilType.Smoke, 1, 2, 3);
        r.Grenade(2200, 6, GrenadeType.Smoke, 1, 2, 3, 77);
        r.SmokeExpired(2300, 77);
        r.UtilBought(2, UtilType.He, 300);
        r.BombPlanted(2400, 6, 0);
        r.Kill(new KillInput { Tick = 2500, Killer = 0, Victim = 6, Assister = 1, Weapon = weapon, Flags = 1, NadeType = Nil.V, KillerBody = Nil.V, VictimBody = Nil.V });
        r.Kill(new KillInput { Tick = 2600, Killer = 7, Victim = 0, Assister = Nil.V, Weapon = weapon, NadeType = Nil.V, KillerBody = Nil.V, VictimBody = Nil.V });
        r.BombDefused(2700, 1);
        r.Leave(2750, 9);
        r.RoundEnd(2800, 3, 7);
        for (int i = 0; i < n; i++) r.SetRoundEndEconomy(i, 4000, true);
        r.Finalize(2, 2864);
        r.Reconcile(1, new GameRoundStats[n], new bool[n]);
        r.Flush();
        r.EndCapture("complete", "2026-01-01T00:30:00Z", 3000);
        using var ms = new MemoryStream();
        MatchCodec.Write(sink.Store, ms, inProgress: true);
        ms.Position = 0;
        MatchCodec.Read(ms, new MatchStore());
        RandomHex();
    }

    /// <summary>The first call to the cryptographic random generator loads the OS provider (StartCapture's match id).</summary>
    private static void RandomHex() => System.Security.Cryptography.RandomNumberGenerator.GetHexString(32, lowercase: true);
}
