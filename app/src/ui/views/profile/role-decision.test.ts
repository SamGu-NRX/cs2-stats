import { expect, it } from "vitest";
import type { RoleBlend } from "../../../stats/identity";
import { roleDecisionLabel } from "./role-decision";

const decision = (fields: Partial<RoleBlend>) => fields as RoleBlend;

it("renders only the gated primary when one exists", () => {
  expect(roleDecisionLabel(decision({ primary: "Entry", probability: 0.73, top2: null, reason: null }))).toBe("Entry 73%");
});

it("renders the gated top two without inventing a percentage", () => {
  expect(roleDecisionLabel(decision({ primary: null, probability: null, top2: ["Entry", "Lurker"], reason: "Close fit." }))).toBe("Entry / Lurker");
});

it("renders the engine reason when it abstains without a top two", () => {
  expect(roleDecisionLabel(decision({ primary: null, probability: null, top2: null, reason: "Need at least 30 side rounds for a role." }))).toBe("Need at least 30 side rounds for a role.");
});
