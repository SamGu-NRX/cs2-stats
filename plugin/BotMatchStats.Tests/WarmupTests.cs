using System.Diagnostics;
using BotMatchStats.Core;
using Xunit.Abstractions;

namespace BotMatchStats.Tests;

/// <summary>
/// The game-thread budget from the perf targets: every handler under 0.5 ms, ticks averaging under
/// 0.1 ms. These measure the engine-free part (the recorder) after <see cref="Warmup.Run"/>, playing
/// a full 10-player round with line of sight on, and fail if any single call exceeds the budget.
/// </summary>
public class WarmupTests
{
    private readonly ITestOutputHelper _out;
    public WarmupTests(ITestOutputHelper output) => _out = output;

    private const double HandlerBudgetUs = 500, TickAvgBudgetUs = 100;

    [Fact]
    public void WarmupRunsWithoutErrors()
    {
        string? err = null;
        var took = Warmup.Run(e => err = e);
        Assert.Null(err);
        _out.WriteLine($"warm-up {took.TotalMilliseconds:F1} ms");
        Assert.True(Warmup.PrepareAssemblyMethods(typeof(Recorder).Assembly, t => t == typeof(LosTracker)) > 5);
    }

    [Fact]
    public void AfterWarmupEveryRecorderCallStaysInBudget()
    {
        Warmup.Run();
        // Best of three, so a preemption on a busy machine (the tests run at Idle priority) is not read as a regression.
        Recorder r = null!;
        double maxUs = double.MaxValue, tickAvgUs = double.MaxValue;
        string worst = "";
        for (int i = 0; i < 3 && (maxUs >= HandlerBudgetUs || tickAvgUs >= TickAvgBudgetUs); i++)
        {
            var ri = Measure(out double m, out double a, out string w);
            if (m < maxUs) { maxUs = m; worst = w; r = ri; }
            tickAvgUs = Math.Min(tickAvgUs, a);
        }
        _out.WriteLine($"max call {maxUs:F1} µs ({worst}), tick average {tickAvgUs:F2} µs");
        Assert.True(r.Los.Enabled);
        Assert.True(maxUs < HandlerBudgetUs, $"{worst} took {maxUs:F0} µs");
        Assert.True(tickAvgUs < TickAvgBudgetUs, $"tick average {tickAvgUs:F1} µs");
    }

    /// <summary>
    /// Cold first-call cost, for the before/after numbers: run in a fresh process with
    /// BMS_COLD_BENCH=1 (and BMS_COLD_WARM=1 to warm up first), e.g.
    /// <c>dotnet test --filter ColdFirstRound --logger "console;verbosity=detailed"</c>.
    /// </summary>
    [Fact]
    public void ColdFirstRound()
    {
        if (Environment.GetEnvironmentVariable("BMS_COLD_BENCH") != "1") return;
        bool warm = Environment.GetEnvironmentVariable("BMS_COLD_WARM") == "1";
        double warmMs = warm ? Warmup.Run().TotalMilliseconds : 0;
        Measure(out double maxUs, out double tickAvgUs, out string worst, byName: true);
        _out.WriteLine($"COLD warm={warm} warmupMs={warmMs:F1} maxCallUs={maxUs:F0} ({worst}) tickAvgUs={tickAvgUs:F2} " + string.Join(" ", LastByName.Select(kv => $"{kv.Key}={kv.Value:F0}")));
    }

    private sealed class SpinProbe : ILosProbe
    {
        // Every third point is clear, so most enemies cost two or three traces.
        private int _n;
        public bool? Clear(double ax, double ay, double az, double bx, double by, double bz) => _n++ % 3 == 2;
    }

    /// <summary>One capture: start, a full live round with shots, hits, utility and kills, hand-off, end. Times every call.</summary>
    private static readonly Dictionary<string, double> LastByName = new();

    private static Recorder Measure(out double maxUs, out double tickAvgUs, out string worst, bool byName = false)
    {
        LastByName.Clear();
        var sink = new ListSink();
        var frames = new FrameSet();
        var r = new Recorder(sink, frames, new PerfCounter(), _ => { });
        r.Los.Attach(new SpinProbe());
        double max = 0;
        string w = "";
        void T(string name, Action a)
        {
            long t0 = Stopwatch.GetTimestamp();
            a();
            double us = (Stopwatch.GetTimestamp() - t0) * 1e6 / Stopwatch.Frequency;
            if (us > max) { max = us; w = name; }
            if (byName) LastByName[name] = Math.Max(LastByName.GetValueOrDefault(name), us);
        }
        T("StartCapture", () => r.StartCapture(new MatchMeta { Id = "0123456789abcdef0123456789abcdef", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z", Env = new EnvInfo { Plugin = "t", MaxRounds = 24 } }));
        T("PlayerIndex", () => { for (int i = 0; i < 10; i++) frames.Active[frames.ActiveCount++] = r.PlayerIndex("p" + i, "p" + i, i > 0); r.SetHuman(0); });
        T("BeginRound", () => r.BeginRound(0, 1000, 0, 0, false, Nil.V));
        T("FreezeEnd", () => { for (int pi = 0; pi < 10; pi++) r.SetFreezePlayer(pi, pi < 5 ? 3 : 2, 800, 4700, 100, true); r.FreezeEnd(2000); });
        int ak = r.Weapons.Get("ak47");
        long tickSum = 0;
        int ticks = 0;
        for (int t = 2000; t < 2000 + 64 * 90; t++)
        {
            for (int pi = 0; pi < 10; pi++)
            {
                ref var f = ref frames.ByPi[pi];
                f.Present = true; f.Alive = true; f.Team = pi < 5 ? 3 : 2; f.ViewZ = 64; f.Place = Nil.V;
                f.X = pi < 5 ? pi * 40 : 1500 + pi * 40; f.Y = (t % 200) - 100; f.Z = 0; f.Yaw = (t % 40) - 20; f.Pitch = 0;
            }
            long t0 = Stopwatch.GetTimestamp();
            r.Tick(t);
            long dt = Stopwatch.GetTimestamp() - t0;
            tickSum += dt;
            ticks++;
            double us = dt * 1e6 / Stopwatch.Frequency;
            if (us > max) { max = us; w = "Tick"; }
            if (byName) LastByName["Tick"] = Math.Max(LastByName.GetValueOrDefault("Tick"), us);
            if (t % 9 == 0)
            {
                T("Shot", () => r.Shot(new ShotInput { Tick = t, Weapon = ak, Speed = 100, MaxSpeed = 215 }));
                T("Impact", () => r.Impact(t, 900, 10, 60));
                T("Hurt", () => r.Hurt(t, 0, 5 + t % 5, 1, 0, 90, ak, 2, true, Nil.V));
                T("HitMask", () => r.HitMask(t, 0, 5 + t % 5, 1u, 0u, true, 1));
            }
            if (t == 3000) T("Throw+Grenade+Blind", () => { r.Throw(t, 6, UtilType.Flash, 0, 0, 0); r.Grenade(t + 1, 6, GrenadeType.Flash, 0, 0, 0); r.Blind(t + 1, 6, 0, 1500); });
            if (t == 4000) T("Kill", () => r.Kill(new KillInput { Tick = t, Killer = 0, Victim = 7, Assister = 1, Weapon = ak, NadeType = Nil.V, KillerBody = Nil.V, VictimBody = Nil.V }));
        }
        T("RoundEnd", () => { r.RoundEnd(2000 + 64 * 90, 3, 8); for (int pi = 0; pi < 10; pi++) r.SetRoundEndEconomy(pi, 4000, true); });
        T("Finalize", () => r.Finalize(1, 2000 + 64 * 91));
        T("Reconcile", () => r.Reconcile(0, new GameRoundStats[10], new bool[10]));
        T("Flush", () => r.Flush());
        T("BeginRound2", () => r.BeginRound(1, 9000, 1, 0, false, Nil.V));
        T("EndCapture", () => r.EndCapture("complete", "2026-10-24T18:00:00Z", 9100));
        maxUs = max;
        worst = w;
        tickAvgUs = tickSum * 1e6 / Stopwatch.Frequency / ticks;
        return r;
    }
}
