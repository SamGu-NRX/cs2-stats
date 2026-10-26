// The optional packs folder (%APPDATA%\BotMatchStats\packs: pro scores, agent art, the CS2 icon pack,
// the win-probability pack and a local pro pool), served to `vite dev` as GET /__packs/file?f=<rel>,
// the way the desktop app's read_pack command serves it. Only the dev server gets this route: a
// `vite preview` of a production build must not serve private files.
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { isInside } from "./paths";
import { fileParam, requestUrl } from "./request-param";

export const PACK_FILE = /\.(json|png|svg)$/;

export type PackAnswer = { status: 200; type: string; bytes: Buffer } | { status: 400 | 404 };

/**
 * One pack file: 400 for a name that is not a pack file or resolves outside the folder (links and
 * junctions included, on real paths) or to something other than a regular file, 404 when it does not
 * exist. `root` null (no APPDATA) is 400.
 */
export async function packFile(root: string | null, rel: string | null): Promise<PackAnswer> {
  if (!root || rel === null || !PACK_FILE.test(rel)) return { status: 400 };
  const abs = path.resolve(root, rel);
  if (!isInside(abs, root)) return { status: 400 };
  if (!existsSync(abs)) return { status: 404 };
  const real = realpathSync.native(abs);
  if (!existsSync(root) || !isInside(real, realpathSync.native(root))) return { status: 400 };
  if (!(await fs.stat(real)).isFile()) return { status: 400 };
  const type = rel.endsWith(".png") ? "image/png" : rel.endsWith(".svg") ? "image/svg+xml" : "application/json";
  return { status: 200, type, bytes: await fs.readFile(real) };
}

/** The dev server's /__packs route; there is no configurePreviewServer on purpose. */
export function packsFolder(root: string | null = process.env.APPDATA ? path.join(process.env.APPDATA, "BotMatchStats", "packs") : null): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = requestUrl(req);
    if (!url) { res.statusCode = 400; return res.end(); }
    if (url.pathname !== "/__packs/file") return next();
    const a = await packFile(root, fileParam(url.search, "f"));
    res.statusCode = a.status;
    if (a.status !== 200) return res.end();
    res.setHeader("Content-Type", a.type);
    res.setHeader("Cache-Control", "no-store");
    return res.end(a.bytes);
  };
  return { name: "cs2-packs-folder", configureServer: (s) => { s.middlewares.use(handler); } };
}
