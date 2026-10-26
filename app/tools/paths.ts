// Path containment on real paths, for the tools and the dev server: a lexical prefix check misses a
// case variant on Windows (PUBLIC\x is public\x) and follows a symbolic link or junction anywhere.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The real path of `p`: its nearest existing ancestor through realpathSync.native (links, junctions
 * and the folder names' real case resolved), then the segments that do not exist yet, so a file about
 * to be written has a real path too.
 */
export function realPathOf(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(existsSync(cur) ? realpathSync.native(cur) : cur, ...rest);
}

/**
 * Whether `child` is `dir` or inside it, compared on real paths, and without case on Windows, where
 * the file system ignores it.
 */
export function isInside(child: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(norm(realPathOf(dir)), norm(realPathOf(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
