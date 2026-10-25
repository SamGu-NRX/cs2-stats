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
