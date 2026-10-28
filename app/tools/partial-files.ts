// Output files written beside their final name and renamed into place at the end, so a reader never sees a
// half-written file (rating-dump.ts).
import { rmSync, renameSync, type WriteStream } from "node:fs";

/**
 * Ends each stream and renames its <file>.partial over <file>. With nothing written (rows 0), it deletes the
 * partial files instead and throws, so an empty run never replaces the last good output.
 */
export async function finishPartials(files: readonly [WriteStream, string][], rows: number, what: string): Promise<void> {
  await Promise.all(files.map(([s]) => new Promise<void>((done, fail) => {
    s.on("error", fail);
    s.end(() => done());
  })));
  if (rows === 0) {
    for (const [, file] of files) rmSync(`${file}.partial`, { force: true });
    throw new Error(`${what}: nothing was written, so the previous files are kept`);
  }
  for (const [, file] of files) renameSync(`${file}.partial`, file);
}
