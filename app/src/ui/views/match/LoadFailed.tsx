// A worker call that failed: one line naming what did not load and the worker's reason. A skeleton
// means still loading; this line means it stopped, so the two must not look alike.
export function LoadFailed({ what, error }: { what: string; error: string }) {
  return <p className="meta load-failed" role="alert">{what} could not load: {error}</p>;
}
