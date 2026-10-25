// Decides, for each listed file, whether the in-memory summary is still valid. A file is reused
// only when its cache key (path, size, mtime, derive version, model) is unchanged from the previous
// sync; anything else must be re-read, and its cached match view dropped.
export interface SyncPlan {
  keys: Map<string, string>;
  /** files whose summary from the previous sync is still valid */
  reuse: Set<string>;
  /** files that are new or changed since the previous sync */
  changed: string[];
}

export function planSync(files: { file: string; key: string }[], previous: Map<string, string>): SyncPlan {
  const keys = new Map(files.map((f) => [f.file, f.key]));
  const reuse = new Set<string>();
  const changed: string[] = [];
  for (const f of files) {
    if (previous.get(f.file) === f.key) reuse.add(f.file);
    else changed.push(f.file);
  }
  return { keys, reuse, changed };
}
