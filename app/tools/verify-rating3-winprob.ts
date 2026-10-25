// Evaluate the shipped TypeScript lookup on the same untouched test matches as Python.
// Usage: vite-node tools/verify-rating3-winprob.ts -- <HLTV directory> <metrics output>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rating3WinProbabilityCT, type BuyType } from "../src/stats/winprob";

interface HltvMap {
  v: number;
  match: { matchId: string };
  info: string[];
  scoreboards: { rows: { pid: string }[] }[];
  performance: {
    players: { pid: string; events: Record<string, [number, string][]> }[];
    rounds: Record<string, { side: string; events: {
      icon: string; badge: string; alive: [number, number]; y: string;
    }[] }>;
  };
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 2) throw new Error("Expected HLTV data directory and output JSON path");
const [dataDir, output] = args;
const fit = JSON.parse(readFileSync(resolve(root, "model/rating3/winprob_metrics.json"), "utf8"));
const testMatches = new Set<string>(fit.splits.test.matches);
const errors: number[] = [];
const situations = new Map<string, number[]>();
let maps = 0;
const bySituation = (name: string, error: number) => {
  if (!situations.has(name)) situations.set(name, []);
  situations.get(name)!.push(error);
};
for (const source of fit.source_audit.sources as { file: string; sha256: string }[]) {
  const bytes = readFileSync(resolve(dataDir, source.file));
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
    throw new Error(`${source.file} changed since the Python fit; refit before comparing`);
  }
  const map: HltvMap = JSON.parse(bytes.toString("utf8"));
  if (!testMatches.has(String(map.match.matchId))) continue;
  maps++;
  const mapName = /Map(Ancient|Anubis|Cache|Dust2|Inferno|Mirage|Nuke)/.exec(map.info[0])?.[1];
  if (!mapName) throw new Error(`${source.file}: missing map name`);
  const firstPids = new Set(map.scoreboards[0].rows.map((p) => String(p.pid)));
  for (const [roundName, round] of Object.entries(map.performance.rounds)) {
    const tooltip = map.performance.players.find((p) => firstPids.has(String(p.pid)))?.events[roundName]?.[0]?.[1];
    if (!tooltip) throw new Error(`${source.file}/${roundName}: missing equipment tooltip`);
    const buys = [...tooltip.matchAll(/\$[\d.]+K?\s*\((PISTOL|ECO|HALF|FULL)\)/g)].map((m) => m[1] as BuyType);
    if (buys.length !== 2) throw new Error(`${source.file}/${roundName}: expected two buy types`);
    if (round.side !== "t-side" && round.side !== "ct-side") throw new Error(`Unknown side ${round.side}`);
    const ti = round.side === "t-side" ? 0 : 1;
    let planted: 0 | 1 = 0;
    let lastKillSide: "t" | "ct" | "none" = "none";
    let terminalWinner: "t" | "ct" | undefined;
    for (const event of round.events) {
      if (["kill.svg", "ct_win.svg", "t_win.svg"].includes(event.icon)) {
        lastKillSide = event.badge === "ct_badge.png" ? "ct" : "t";
      }
      if (event.icon === "bombplant.svg") planted = 1;
      if (event.icon === "bomb_exploded.svg") terminalWinner = "t";
      if (event.icon === "bomb_defused.svg" || event.icon === "stopwatch.svg") terminalWinner = "ct";
      const predicted = rating3WinProbabilityCT({
        tAlive: event.alive[ti], ctAlive: event.alive[1 - ti], planted,
        tBuy: buys[ti], ctBuy: buys[1 - ti], lastKillSide, terminalWinner,
      }, mapName);
      if (predicted === null) throw new Error(`${source.file}/${roundName}: lookup has no answer`);
      const actualCT = ti === 0 ? 1 - Number(event.y) : Number(event.y);
      const error = 100 * Math.abs(predicted - actualCT);
      errors.push(error);
      bySituation(mapName, error);
      bySituation(event.icon, error);
      bySituation(terminalWinner ? "terminal" : planted ? "postplant" : "preplant", error);
    }
  }
}
function metrics(values: number[]) {
  return { n: values.length, mae_pp: values.reduce((a, b) => a + b, 0) / values.length,
    rmse_pp: Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length), max_pp: Math.max(...values) };
}
const result = { maps, test: metrics(errors), python: fit.test.overall,
  situations: Object.fromEntries([...situations].map(([name, values]) => [name, metrics(values)])) };
if (result.test.n !== result.python.n || Math.abs(result.test.mae_pp - result.python.mae_pp) > 1e-10) {
  throw new Error(`TypeScript and Python disagree: ${JSON.stringify(result)}`);
}
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
