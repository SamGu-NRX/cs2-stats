namespace BotMatchStats.Core;

/// <summary>
/// Decisions around reloads and resumes, kept pure so the traces found by the TLA+ model
/// (formal/Capture.tla) are regression-tested without the engine.
/// </summary>
public static class Lifecycle
{
    /// <summary>CCSGameRules.m_gamePhase for a finished match (GAMEPHASE_MATCH_ENDED in the CS:GO enum; unverified in CS2).</summary>
    public const int GamePhaseMatchEnded = 5;

    /// <summary>
    /// A scan result is used only if it answers the latest scan request and the file describes the
    /// game that is running now. A restart or map change while the scan was pending bumps the
    /// generation, so an old answer cannot resume the previous match into the new one.
    /// </summary>
    public static bool AcceptResume(int resultGen, int currentGen, MatchMeta file, string liveMap, float liveGameStart, int liveRoundsPlayed, bool liveWarmup)
    {
        if (resultGen != currentGen || liveWarmup) return false;
        if (file.Map != liveMap || Math.Abs(file.GameStart - liveGameStart) >= 0.01f) return false;
        // The live round counter cannot be behind the rounds already in the file (minus the one
        // that may still be in progress); being behind means the game restarted.
        return liveRoundsPlayed >= file.RoundCount - 1;
    }

    /// <summary>
    /// While a scan is pending, a round_start that shows a different game (warmup, the round counter
    /// going back, or a new game start time) makes the pending answer stale.
    /// </summary>
    public static bool ScanStale(bool warmup, int roundsPlayed, float gameStart, int scanRoundsPlayed, float scanGameStart) =>
        warmup || roundsPlayed < scanRoundsPlayed || Math.Abs(gameStart - scanGameStart) >= 0.01f;

    /// <summary>
    /// The match ended while capture was unavailable (a reload around cs_win_panel_match): the resumed
    /// capture must be closed as complete, because no later event will do it.
    /// </summary>
    public static bool MatchOverAtResume(bool winPanelSeen, int gamePhase) => winPanelSeen || gamePhase == GamePhaseMatchEnded;
}

/// <summary>What an event handler needs before it may read its event (see <see cref="MapGate.EventAllowed"/>).</summary>
public enum EventNeed
{
    /// <summary>The handler reads nothing from the event or from entities.</summary>
    Nothing,
    /// <summary>A running, initialized map.</summary>
    Map,
    /// <summary>A running, initialized map and an active capture.</summary>
    Capture,
    /// <summary>A running, initialized map and a round being recorded.</summary>
    Round,
}


/// <summary>
/// Whether a map is known to be running, so engine entities (and traces) may be touched. A game launch
/// loads plugins at the main menu, where entity reads fail and CounterStrikeSharp caches the failure
/// for every plugin until restart. So nothing touches entities until OnMapStart, or, after a hot
/// reload (no OnMapStart follows), until the server reports a map name. OnTick cannot stand in for
/// that: it also fires at the main menu (CS2-Smarter-Bot's BotState.Tick.cs saw the menu's
/// one-player limit from it).
///
/// The gate also owns what a map boundary invalidates: the plugin's init (game rules, teams, slots)
/// and the pending resume scan. A boundary resets both before the old capture is closed, so a close
/// that throws cannot leave housekeeping or handlers reading a torn-down map, and a scan answer for
/// the old map is never taken for the new one.
/// </summary>
public sealed class MapGate
{

    public bool MapRunning { get; private set; }
    /// <summary>Hot-reloaded and not yet sure a map is running; the plugin polls the map name meanwhile.</summary>
    public bool AwaitingHotReload { get; private set; }
    /// <summary>Game rules, teams and slots must be read again (TryInit) before entities are touched elsewhere.</summary>
    public bool NeedInit { get; private set; } = true;
    public bool ScanPending { get; private set; }
    /// <summary>Generation of the latest scan request; a boundary advances it so older answers are stale.</summary>
    public int ScanGen { get; private set; }

    /// <summary>Handlers, ticks and steady-state housekeeping may read entities.</summary>
    public bool EntitiesReady => MapRunning && !NeedInit;

    /// <summary>Whether an event handler with this need may run; checked before the handler reads any event field.</summary>
    public bool EventAllowed(EventNeed need, bool capturing, bool roundActive) => need switch
    {
        EventNeed.Nothing => true,
        EventNeed.Map => EntitiesReady,
        EventNeed.Capture => EntitiesReady && capturing,
        _ => EntitiesReady && roundActive,
    };

    public void PluginLoaded(bool hotReload) { MapRunning = false; AwaitingHotReload = hotReload; NeedInit = true; }
    public void Initialized() => NeedInit = false;

    public int NewScan() { ScanPending = true; return ++ScanGen; }
    public bool IsCurrentScan(int gen) => ScanPending && gen == ScanGen;
    public void ScanDone() => ScanPending = false;

    /// <summary>OnMapStart. <paramref name="closeOld"/> closes a capture left from a previous map (no OnMapEnd came).</summary>
    public void MapStarted(Action closeOld)
    {
        Boundary();
        MapRunning = true;
        closeOld();
    }

    /// <summary>OnMapEnd. <paramref name="closeCapture"/> writes the capture out; it runs after the gate has closed.</summary>
    public void MapEnded(Action closeCapture)
    {
        Boundary();
        closeCapture();
    }

    private void Boundary()
    {
        MapRunning = false;
        AwaitingHotReload = false;
        NeedInit = true;
        ScanPending = false;
        ScanGen++;
    }

    /// <summary>The server reported a non-empty map name while a hot reload was waiting.</summary>
    public void MapNamed()
    {
        if (!AwaitingHotReload) return;
        AwaitingHotReload = false;
        MapRunning = true;
    }
}
