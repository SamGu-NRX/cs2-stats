// After a refit the kept facts are rated again, once; the file is never read and derived again.
import { expect, it } from "vitest";
import type { MatchFacts } from "../stats/facts";
import type { RatingInputs } from "../stats/rate";
import { cachedFacts, type FactsSource } from "./cached-facts";
import type { Cached } from "./derive-file";

const inputs = { startTick: [7] } as RatingInputs;
const rated = (model: string, base = {}) => ({ ...base, match: { model } }) as MatchFacts;

it("derives a file once, then rates its record again only when the model changes", async () => {
  // fails if a refit derives every match again, or rates it again on every read, or loses the inputs
  // the next refit needs
  const store = new Map<string, Cached>();
  const calls: string[] = [];
  const source = (model: string): FactsSource => ({
    model,
    get: async (k) => store.get(k),
    put: async (k, c) => void store.set(k, c),
    rate: (c) => { calls.push(`rate ${model}`); return rated(model, c.facts); },
    derive: async () => { calls.push(`derive ${model}`); return { facts: rated(model), inputs, origin: "plugin" }; },
  });
  await cachedFacts("k", source("A"));
  await cachedFacts("k", source("A"));
  const refit = await cachedFacts("k", source("B"));
  await cachedFacts("k", source("B"));
  expect(calls).toEqual(["derive A", "rate B"]);
  expect(refit.facts.match.model).toBe("B");
  expect(store.get("k")).toEqual({ facts: rated("B"), inputs, origin: "plugin" });
});
