// Output files written beside their final name and renamed into place at the end, so a reader never sees a
// half-written file (rating-dump.ts).
import { rmSync, renameSync, type WriteStream } from "node:fs";

/**
 * Ends each stream and renames its <file>.partial over <file>. If the stream of required (one of the final file
 * names) wrote nothing, it deletes the partial files instead and throws, so an empty run never replaces the last
 * good output. The check reads the bytes the stream wrote, not a count the caller keeps.
 */
export async function finishPartials(files: readonly [WriteStream, string][], required: string, what: string): Promise<void> {
  await Promise.all(files.map(([s]) => new Promise<void>((done, fail) => {
    s.on("error", fail);
    s.end(() => done());
  })));
  const main = files.find(([, file]) => file === required);
  if (!main) throw new Error(`${what}: ${required} is not one of the files written`);
  if (main[0].bytesWritten === 0) {
    for (const [, file] of files) rmSync(`${file}.partial`, { force: true });
    throw new Error(`${what}: nothing was written, so the previous files are kept`);
  }
  for (const [, file] of files) renameSync(`${file}.partial`, file);
}
