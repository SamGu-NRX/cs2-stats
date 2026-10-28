// Turns between a match's table decodes (load.ts eachInTurn), which the stats worker's idle read takes.
import { expect, it } from "vitest";
import { eachInTurn } from "./load";

const timerTurn = () => new Promise<void>((r) => setTimeout(r, 0));

it("lets a call posted while tables decode run before the last decode when given a turn, and not otherwise", async () => {
  // fails if the idle read ignores its turn: a worker message posted during it would wait for every
  // table's decode, since decodes whose bytes are in run back to back through microtasks
  const order: string[] = [];
  const decode = async (t: string) => { order.push(t); };
  setTimeout(() => order.push("call"), 0);
  await eachInTurn(["match", "players", "positions"], decode, timerTurn);
  expect(order.indexOf("call")).toBeGreaterThan(-1);
  expect(order.indexOf("call")).toBeLessThan(order.indexOf("positions"));
  // a tool call's own read takes no turn: it runs straight through, the call after it
  order.length = 0;
  setTimeout(() => order.push("call"), 0);
  await eachInTurn(["match", "players", "positions"], decode);
  expect(order).toEqual(["match", "players", "positions"]);
  await timerTurn();
  expect(order.at(-1)).toBe("call");
});
