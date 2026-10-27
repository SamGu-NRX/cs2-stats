// CS2 match share codes ("CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"). A code is 25 base-57 digits, least
// significant first, of an 18-byte number: the match id (8 bytes), the reservation id (8 bytes) and the
// low 16 bits of the TV port (2 bytes), each little-endian. The layout is the one csgo-sharecode
// (github.com/akiver/csgo-sharecode) documents; its published example decodes the same here (sharecode.test.ts).
//
// Valve's demo files carry the match id too: the game saves a match's demo as
// match730_<match id, 21 digits>_<TV port>_<server>.dem, and the Valve importer names each match folder
// after that file (extractor/valve_import.py), so a Valve match's file path gives its match id.

const DICT = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
const CODE = /^CSGO(?:-[A-Za-z0-9]{5}){5}$/;

export interface ShareCode { matchId: bigint; reservationId: bigint; tvPort: number }

const le = (bytes: number[]) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);

/** The ids inside a share code; null for anything that is not one. */
export function decodeShareCode(code: string): ShareCode | null {
  if (!CODE.test(code)) return null;
  const chars = code.slice(5).replaceAll("-", "");
  let big = 0n;
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = DICT.indexOf(chars[i]);
    if (d < 0) return null;
    big = big * 57n + BigInt(d);
  }
  if (big >> 144n) return null;
  const bytes: number[] = [];
  for (let i = 17; i >= 0; i--) bytes.push(Number((big >> BigInt(8 * i)) & 0xffn));
  return { matchId: le(bytes.slice(0, 8)), reservationId: le(bytes.slice(8, 16)), tvPort: Number(le(bytes.slice(16, 18))) };
}

/** The share code for these ids; the inverse of decodeShareCode. */
export function encodeShareCode({ matchId, reservationId, tvPort }: ShareCode): string {
  const leBytes = (n: bigint, len: number) => Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const bytes = [...leBytes(matchId, 8), ...leBytes(reservationId, 8), ...leBytes(BigInt(tvPort), 2)];
  let big = bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
  let out = "";
  for (let i = 0; i < 25; i++) { out += DICT[Number(big % 57n)]; big /= 57n; }
  return `CSGO-${out.match(/.{5}/g)!.join("-")}`;
}

const VALVE_DEMO = /^valve\/match730_(\d{1,21})_\d+_\d+\//;

/** The Valve match id in a Valve match's file path ("valve/match730_<id>_<port>_<server>/<version>"); null for any other file. */
export function valveMatchId(file: string): bigint | null {
  const m = VALVE_DEMO.exec(file);
  return m ? BigInt(m[1]) : null;
}
