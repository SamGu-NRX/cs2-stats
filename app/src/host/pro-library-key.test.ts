// @vitest-environment jsdom
// A pro map's cache key names the library it was listed from (host.ts listProSafely, worker/keys.ts factsKey).
import { afterEach, expect, it, vi } from "vitest";
import { factsKey } from "../worker/keys";
import { createHost } from "./host";

const MAP = { file: "pro/vitality-vs-mouz-1/m1-mirage/v-1.16.0-0a1b2c3d", size: 2048, mtime: 1_793_000_000_000 };

/** The web host's endpoints, with the pro library answering from `library` and the same map in each. */
function serve(library: string | null) {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/__pro/list") return json({ folder: library, library, files: [MAP], skipped: [], incomplete: 0, error: null });
    if (url === "/__matches/list") return json({ folder: "matches", files: [] });
    if (url.endsWith("samples/index.json")) return json([]);
    return new Response("", { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

it("gives a map at the same path, size and time in another library another cache key", async () => {
  // fails if switching libraries reuses the old library's facts, entry, sessions and presence for a map
  // whose relative path, size and modified time happen to match: the worker would show the old numbers
  const keyOf = async (library: string | null) => {
    serve(library);
    const entry = (await (await createHost()).list()).find((e) => e.file === MAP.file)!;
    return factsKey(entry, "model");
  };
  const a = await keyOf("C:\\libraries\\a\\demos");
  const b = await keyOf("D:\\libraries\\b\\demos");
  expect(a).not.toBe(b);
  // the same library keeps its key, so a rescan reads the cache instead of deriving every map again
  expect(await keyOf("C:\\libraries\\a\\demos")).toBe(a);
});
