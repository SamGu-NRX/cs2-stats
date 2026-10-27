// @vitest-environment jsdom
// Outside links on the desktop go through the open_external command, because the web view drops a
// target="_blank" link (src-tauri/src/lib.rs, "outside links"; external.ts). The Rust side checks which
// URLs it opens (lib.rs opens_only_https_pages_on_the_hosts_the_app_links_to).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { openExternal } = await import("./external");

const URL = "https://leetify.com/app/match-details/0/overview";

describe("outside links", () => {
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    invoke.mockClear();
    vi.restoreAllMocks();
  });

  it("go to the host's open_external on the desktop, never to a web view window", async () => {
    // fails if a desktop link falls back to window.open, which the web view drops
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openExternal(URL);
    expect(invoke).toHaveBeenCalledWith("open_external", { url: URL });
    expect(open).not.toHaveBeenCalled();
  });

  it("open a tab in a browser build", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openExternal(URL);
    expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("are never a target=_blank link in the views, which the desktop would drop", () => {
    // fails if a view adds an outside link that bypasses OutsideLink and openExternal
    const ui = path.resolve(import.meta.dirname, "../ui");
    const found = readdirSync(ui, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
      .filter((f) => /_blank/.test(readFileSync(path.join(ui, f), "utf8")));
    expect(found).toEqual([]);
  });
});
