import { expect, it } from "vitest";
import type { RoleBlend } from "../../../stats/identity";
import { roleDecisionLabel } from "./role-decision";

const decision = (fields: Partial<RoleBlend>) => fields as RoleBlend;

it("renders a calibrated primary with a plain percentage", () => {
  expect(roleDecisionLabel(decision({ primary: "Entry", probability: 0.73, top2: null, reason: null, calibrationStatus: { Entry: "calibrated" } }))).toBe("Entry 73%");
});

it("labels rule-only and measured primaries", () => {
  expect(roleDecisionLabel(decision({ primary: "Trader", probability: 0.64, top2: null, reason: null, calibrationStatus: { Trader: "fit" } }))).toBe("Trader 64% fit");
  expect(roleDecisionLabel(decision({ primary: "AWPer", probability: 0.64, top2: null, reason: null, calibrationStatus: { AWPer: "measured" } }))).toBe("AWPer 64% AWP rounds");
});

it("renders the gated top two without inventing a percentage", () => {
  expect(roleDecisionLabel(decision({ primary: null, probability: null, top2: ["Entry", "Lurker"], reason: "Close fit." }))).toBe("Entry / Lurker");
});

it("renders the engine reason when it abstains without a top two", () => {
  expect(roleDecisionLabel(decision({ primary: null, probability: null, top2: null, reason: "Need at least 30 side rounds for a role." }))).toBe("Need at least 30 side rounds for a role.");
});
