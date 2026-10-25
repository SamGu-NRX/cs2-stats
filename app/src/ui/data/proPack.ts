// The pro pack's format: types and a strict parser, with no React or host dependency. See packs.ts
// for where the pack lives and how it loads.
export const ATTRIBUTE_ORDER = ["firepower", "entrying", "trading", "opening", "closing", "sniping", "utility"] as const;
export type AttributeId = (typeof ATTRIBUTE_ORDER)[number];
export const HLTV_ORIGIN = "https://www.hltv.org";

export interface Pro {
  name: string;
  slug: string;
  team: string;
  country: string;
  /** ISO 3166 alpha-2 */
  code: string | null;
  rating3: number;
  /** path of the player's stats page on HLTV */
  hltv: string;
  photo: string;
  logo: string;
  flag: string | null;
  both: (number | null)[];
  ct: (number | null)[];
  t: (number | null)[];
}

const scores = (v: unknown) => Array.isArray(v) && v.length === ATTRIBUTE_ORDER.length && v.every((x) => x === null || typeof x === "number");

/** Checks the pack's shape and names the first problem, rather than guessing at a partial file. */
export function parseProPack(text: string): { pros: Pro[]; source: string } {
  const raw = JSON.parse(text) as { version?: unknown; source?: unknown; pros?: unknown };
  if (raw.version !== 1) throw new Error(`pros.json: version is ${JSON.stringify(raw.version)}, this app reads version 1`);
  if (!Array.isArray(raw.pros)) throw new Error("pros.json: \"pros\" must be an array");
  raw.pros.forEach((p: Record<string, unknown>, i: number) => {
    for (const k of ["name", "slug", "team", "country", "hltv", "photo", "logo"]) if (typeof p[k] !== "string") throw new Error(`pros.json: pros[${i}].${k} must be a string`);
    if (typeof p.rating3 !== "number") throw new Error(`pros.json: pros[${i}].rating3 must be a number`);
    for (const k of ["both", "ct", "t"]) if (!scores(p[k])) throw new Error(`pros.json: pros[${i}].${k} must hold ${ATTRIBUTE_ORDER.length} scores`);
  });
  return { pros: raw.pros as Pro[], source: typeof raw.source === "string" ? raw.source : "" };
}

