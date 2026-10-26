// A rescan asked for during a scan is never lost.
import { expect, it } from "vitest";
import { scanQueue } from "./scan-queue";

it("runs a rescan asked for mid-scan once the scan ends, so a match imported meanwhile appears", async () => {
  // fails if the request made during a busy scan is dropped (review of #29): the list stays without "b"
  let folder = ["a"];
  let shown: string[] = [];
  let release!: () => void;
  let scans = 0;
  const request = scanQueue(async () => {
    const listed = [...folder];
    if (scans++ === 0) await new Promise<void>((r) => { release = r; }); // the first scan is slow
    shown = listed;
  });
  const first = request();
  folder = [...folder, "b"]; // an import ends while the scan runs
  const fromImport = request();
  void request(); // a second request meanwhile still costs one more scan, not two
  release();
  await Promise.all([first, fromImport]);
  expect([shown, scans]).toEqual([["a", "b"], 2]);
});
