// A moment's clip id: the name of its files in the clips folder (%APPDATA%\BotMatchStats\clips). It
// must stay the same across rescans and re-extractions, so a rendered clip keeps its moment, and it
// must not hold a file name or SteamID, since it ends up in paths the app shows.

/** The part of a match file path that survives re-extraction: a Valve match's demo folder ("valve/<demo>"), else the path. */
export function matchKey(file: string): string {
  const m = /^valve\/([^/]+)\//.exec(file);
  return m ? `valve/${m[1]}` : file;
}

/** 64 bits of FNV-1a over the text's UTF-16 code units, as 16 hex digits. */
export function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** "c-<16 hex>-r<round>": the match, the POV player and the round. */
export const clipId = (file: string, player: string, round: number): string => {
  if (!Number.isInteger(round) || round < 1) throw new Error(`clipId: round must be a round number, got ${round}`);
  return `c-${fnv64(`${matchKey(file)}|${player}`)}-r${round}`;
};

/** A clip id as clipId writes it; anything else is refused before it names a file. */
export const CLIP_ID = /^c-[0-9a-f]{16}-r[1-9][0-9]{0,2}$/;
