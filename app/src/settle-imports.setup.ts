// Loaded before every test file (vite.config.ts test.setupFiles). After each test, wait for the module
// loads it started, such as a lazy page it opened, before the next test or file begins. CI runs every
// file in one process: a load still running when its file ends goes on evaluating modules into the next
// file's fresh registry before that file's vi.mock calls apply, which is how app-shortcuts' Clips page
// broke the killfeed test (#63, #65). vi.dynamicImportSettled waits for every module load in flight.
import { afterEach, vi } from "vitest";

afterEach(async () => {
  await vi.dynamicImportSettled();
});
