using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using BotMatchStats.Core;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using Microsoft.Extensions.Logging;

namespace BotMatchStats.Game;

/// <summary>
/// Keeps first-call costs and logging out of live rounds (see <see cref="Warmup"/> for the evidence).
/// - Core code is compiled and exercised on a background thread at load.
/// - Engine-bound code is compiled, and its CounterStrikeSharp paths run once, on the game thread in
///   small steps between live rounds, after a map has loaded.
/// - Log lines are queued and written between live rounds; logging writes to the console and files.
/// </summary>
public sealed partial class BotMatchStatsPlugin
{
    /// <summary>Game-thread warm-up work per housekeeping call.</summary>
    private const double WarmStepBudgetMs = 1.0;
    private const int MaxQueuedLogs = 512;

    private readonly Queue<(LogLevel Level, string Text)> _logQueue = new();
    private volatile string? _coreWarmResult;
    private (RuntimeMethodHandle Method, RuntimeTypeHandle[]? Inst)[]? _gameMethods;
    private int _gameMethodNext;
    private Action[]? _engineSteps;
    private int _engineStepNext, _engineWarmTries;
    private TraceLosProbe? _losProbe;
    /// <summary>func_bomb_target entity index → 0 for A, 1 for B, read once per map.</summary>
    private readonly Dictionary<int, int> _bombSites = new();

    /// <summary>Queues a log line; <see cref="FlushLogs"/> writes it outside live rounds.</summary>
    private void Log(LogLevel level, string text)
    {
        if (_logQueue.Count < MaxQueuedLogs) _logQueue.Enqueue((level, text));
    }

    private void FlushLogs()
    {
        while (_logQueue.TryDequeue(out var e)) Logger.Log(e.Level, "BotMatchStats: {Text}", e.Text);
    }

    private void StartCoreWarmup()
    {
        var t = new Thread(() =>
        {
            string? err = null;
            var took = Warmup.Run(e => err = e);
            _coreWarmResult = err ?? $"core warm-up done in {took.TotalMilliseconds:F0} ms";
        })
        { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "BotMatchStats warm-up" };
        t.Start();
    }

    /// <summary>Called by TryInit on the game thread once a map has loaded.</summary>
    private void OnMapReady()
    {
        BuildBombSites();
        AttachLos();
        _gameMethods ??= MethodsToPrepare();
        _engineSteps ??= EngineSteps();
        _engineStepNext = 0;
        _engineWarmTries = 0;
    }

    /// <summary>
    /// Creates the probe and makes the first trace now, while the map loads: in game, that first call
    /// took 7.7 ms (native and managed first-use costs), and later calls 9-41 µs per check. The two
    /// points are arbitrary; only a failure (exception, non-number) matters here.
    /// </summary>
    private void AttachLos()
    {
        var rec = _rec!;
        try
        {
            _losProbe = new TraceLosProbe();
            rec.AttachLos(_losProbe);
        }
        catch (Exception ex)
        {
            _losProbe = null;
            rec.AttachLos(null);
            Log(LogLevel.Warning, $"line of sight unavailable ({ex.GetType().Name}: {ex.Message}); visibility uses the spotted mask");
            return;
        }
        long t0 = Stopwatch.GetTimestamp();
        bool? first = _losProbe.Clear(0, 0, 0, 0, 0, 8);
        double us = PerfCounter.Us(Stopwatch.GetTimestamp() - t0);
        if (first == null) rec.DisableLos(_losProbe.Error ?? "first trace returned no result", Server.TickCount);
        else Log(LogLevel.Information, $"line of sight on (first trace at map load: {us:F0} µs)");
    }

    private void BuildBombSites()
    {
        _bombSites.Clear();
        foreach (var t in Utilities.FindAllEntitiesByDesignerName<CBombTarget>("func_bomb_target"))
            if (t.IsValid) _bombSites[(int)t.Index] = t.IsBombSiteB ? 1 : 0;
    }

    /// <summary>
    /// One housekeeping slice of warm-up, outside live rounds only: compile the plugin's engine-bound
    /// methods, then run the CounterStrikeSharp paths that handlers use, one path per slice. The
    /// deadline is checked before each unit of work, so a slice overruns by at most one method or path.
    /// </summary>
    private void WarmStep()
    {
        if (_rec == null || _rec.Live) return;
        if (_coreWarmResult is { } msg) { _coreWarmResult = null; Log(LogLevel.Information, msg); }
        long deadline = Stopwatch.GetTimestamp() + (long)(WarmStepBudgetMs * Stopwatch.Frequency / 1000);
        var methods = _gameMethods;
        while (methods != null && _gameMethodNext < methods.Length)
        {
            if (Stopwatch.GetTimestamp() >= deadline) return;
            var (m, inst) = methods[_gameMethodNext++];
            try { if (inst == null) RuntimeHelpers.PrepareMethod(m); else RuntimeHelpers.PrepareMethod(m, inst); } catch (Exception) { /* compiled on first call instead */ }
        }
        var steps = _engineSteps;
        if (steps == null || _engineStepNext >= steps.Length || Stopwatch.GetTimestamp() >= deadline) return;
        if (++_engineWarmTries > 240) { _engineStepNext = steps.Length; return; } // a minute without a living human
        if (_humanSlot < 0 || PawnOfSlot(_humanSlot) is var p && (p == 0 || !Mem.Alive(p))) return;
        try { steps[_engineStepNext](); }
        catch (Exception ex) { Log(LogLevel.Warning, $"engine warm-up step {_engineStepNext} failed: {ex.Message}"); }
        _engineStepNext++;
    }

    /// <summary>
    /// What the game-thread warm-up compiles: the plugin's engine-bound methods, the property getters
    /// of every game event it handles, and GameEvent.Get for the value types those getters read.
    /// Compiling runs no code, but these types belong to CounterStrikeSharp, so it happens on the game thread.
    /// </summary>
    private static (RuntimeMethodHandle, RuntimeTypeHandle[]?)[] MethodsToPrepare()
    {
        const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        var list = new List<(RuntimeMethodHandle, RuntimeTypeHandle[]?)>();
        foreach (var t in typeof(BotMatchStatsPlugin).Assembly.GetTypes())
        {
            if (t.Namespace != typeof(BotMatchStatsPlugin).Namespace || t.ContainsGenericParameters) continue;
            foreach (var m in t.GetMethods(all))
                if (!m.IsAbstract && !m.ContainsGenericParameters && m.GetMethodBody() != null) list.Add((m.MethodHandle, null));
        }
        Type[] events =
        {
            typeof(EventRoundStart), typeof(EventRoundFreezeEnd), typeof(EventRoundEnd), typeof(EventPlayerDeath), typeof(EventPlayerHurt),
            typeof(EventPlayerBlind), typeof(EventWeaponFire), typeof(EventBulletImpact), typeof(EventGrenadeThrown), typeof(EventHegrenadeDetonate),
            typeof(EventFlashbangDetonate), typeof(EventSmokegrenadeDetonate), typeof(EventSmokegrenadeExpired), typeof(EventInfernoStartburn),
            typeof(EventDecoyStarted), typeof(EventBombPlanted), typeof(EventBombDefused), typeof(EventItemPurchase), typeof(EventPlayerSpawn),
            typeof(EventPlayerDisconnect),
        };
        foreach (var t in events)
            foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                if (p.GetMethod is { } g) list.Add((g.MethodHandle, null));
        var get = typeof(CounterStrikeSharp.API.Modules.Events.GameEvent).GetMethod("Get");
        if (get != null)
            foreach (var arg in new[] { typeof(bool), typeof(int), typeof(float), typeof(string), typeof(ulong), typeof(CCSPlayerController) })
                list.Add((get.MethodHandle, new[] { arg.TypeHandle }));
        return list.ToArray();
    }

    /// <summary>
    /// The CounterStrikeSharp paths handlers use, each run once on the living human (results discarded),
    /// one per warm-up slice; the last checks the trace against a known-clear segment.
    /// </summary>
    private Action[] EngineSteps()
    {
        nint Pawn() => PawnOfSlot(_humanSlot);
        return new Action[]
        {
            () => CurrentEnv(),
            () => _ = new CCSPlayerController(_slots[_humanSlot].Ctrl).InGameMoneyServices?.Account,
            () => ReadPerRoundStats(_humanSlot, 0, out _),
            () => _ = HasPrimary(_humanSlot),
            () => { var p = Pawn(); _ = Mem.ActiveItemDef(p); _ = EquipOf(p); _ = Mem.Utility(p, _ammoSlot, out _); },
            () => _ = (_rules?.MatchStats_RoundResults.Length, _teamT?.Score, _teamCt?.Score, _rules?.TotalRoundsPlayed, _rules?.WarmupPeriod, _rules?.RoundWinStatus),
            () => CheckLosProbe(Pawn()),
        };
    }

    /// <summary>A trace from the human's eye to a point just above it must be clear; anything else turns line of sight off for this map.</summary>
    private void CheckLosProbe(nint pawn)
    {
        var probe = _losProbe;
        if (probe == null || !_rec!.Los.Enabled) return;
        Mem.Origin(pawn, out float x, out float y, out float z);
        if (float.IsNaN(x)) return;
        double ez = z + Mem.Read<float>(pawn, Mem.ViewZ);
        probe.SetIgnore(pawn);
        bool? clear = probe.Clear(x, y, ez, x, y, ez + 4);
        if (clear == true) return;
        _rec.DisableLos(clear == null ? probe.Error ?? "no result" : "a trace to a point 4 units above the eye was blocked", Server.TickCount);
    }
}
