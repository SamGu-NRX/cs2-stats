// Which matches can be replayed. A replay needs every player's position, view direction and HP four
// times a second: the extractor's positions table has them for pro and Valve demos (extracted folders).
// The capture plugin's files (.json.gz) sample bots once a second with no view or HP, so they get none.

export const canReplay = (file: string) => !file.endsWith(".json.gz");

export const NO_REPLAY = "Recorded matches don't keep the positions a replay needs.";
