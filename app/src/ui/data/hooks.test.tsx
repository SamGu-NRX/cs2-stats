// @vitest-environment jsdom
// useCall's stale flag: an answer kept while the next question loads is marked stale, and a refetch
// of the same question after a sync is not.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCall, type Loaded } from "./hooks";

const pending = new Map<string, (v: unknown) => void>();
let version = 1;
const client = { highlights: (q: { files: string[] }) => new Promise((resolve) => pending.set(q.files[0], resolve)) };
vi.mock("./provider", () => ({ useData: () => ({ client, version, matches: [], you: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("marks the kept answer stale while another question loads, and not after a sync refetches the same one", async () => {
  // fails if a view can render match A's rows as match B's while B loads, or if every sync blanks a view
  let seen: Loaded<unknown> | null = null;
  function Probe({ file }: { file: string }) {
    seen = useCall("highlights", [{ files: [file], filter: { player: "p" } }]);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<Probe file="a" />));
  await act(async () => pending.get("a")!(["rows of a"]));
  expect([seen!.data, seen!.stale]).toEqual([["rows of a"], false]);

  await act(async () => root.render(<Probe file="b" />));
  expect([seen!.data, seen!.stale, seen!.loading]).toEqual([["rows of a"], true, true]);
  await act(async () => pending.get("b")!(["rows of b"]));
  expect([seen!.data, seen!.stale]).toEqual([["rows of b"], false]);

  version = 2;
  await act(async () => root.render(<Probe file="b" />));
  expect([seen!.data, seen!.stale]).toEqual([["rows of b"], false]);
  act(() => root.unmount());
});
