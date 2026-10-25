// The one coverage rule for Rating 3.0, in a module with no engine code so the UI thread can read it.
// A match (or a set of matches) whose kill-by-kill log covers under half its rounds gets no rating: the
// rating of a few covered rounds is not the match's rating. rating3.ts rating3Of applies it to every
// summary; the UI's career set (ui/data/engine.ts careerEntries) applies it per match.

/** Share of a match's rounds the facts must cover before it is rated. Ours, no fit. */
export const R3_MIN_COVERAGE = 0.5;

export const coveredEnough = (m: { nRounds: number; roundsPlayed: number }) => m.nRounds >= R3_MIN_COVERAGE * m.roundsPlayed;
