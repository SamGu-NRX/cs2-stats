"""Fit how HLTV shares a kill's swing between players, from HLTV's own per-event credits.

HLTV's map pages list, for every kill, each player's swing credit to 0.01 percentage points. The
engine's rating dump (app: pnpm rating-dump) holds the same kills with the damage each player did to
the victim. This script fits the weights the engine shares a kill by (app/src/stats/swing.ts):

- the gaining side shares the change in proportion to weight: each player's HP-capped damage on the
  victim this round, plus kill_weight for the killer and trade_weight for the earliest teammate the
  victim killed within trade_window_seconds;
- the victim's charge is shared with a failed trader (a teammate of the victim the same killer killed
  within the window after) in proportion victim_weight : failed_trade_weight.

Damage is in HP, so kill_weight and trade_weight are in HP-equivalents. flash_weight is fitted on
kills whose only other credited player did no damage and was not a trade candidate.

Run with isolated Python and explicit paths:

    python -I swing_credit_fit.py --data DATA --out DATA/model-rating3/swing_credit_metrics.json
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import sys

import numpy as np
from scipy.optimize import least_squares

sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)

CREDIT = re.compile(r"([^|]+?) \| ([+-]?[\d.]+)%")
# kills whose change is under this many percentage points carry too little resolution: credits are
# rounded to 0.01 points
MIN_CHANGE = 2.0
TICK_RATE = 64.0


def jsonl(path: Path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)


def hltv_kill_credits(hltv: Path, maps: set[str]) -> dict:
    """(map file, round number) -> [(killer pid, victim pid, change in points, {pid: credit})] in order."""
    out = {}
    for name in sorted(maps):
        d = json.loads((hltv / name).read_text(encoding="utf-8"))
        perf = d["performance"]
        pid = {p["nick"]: p["pid"] for p in perf["players"]}
        nicks = sorted(pid, key=len, reverse=True)
        for rname, rd in perf["rounds"].items():
            number = int(rname[5:])
            credits = defaultdict(dict)
            for p in perf["players"]:
                for i, (_, text) in enumerate(p["events"].get(rname, [])):
                    for nick, value in CREDIT.findall(text):
                        if nick.strip() == p["nick"]:
                            credits[i][p["pid"]] = float(value)
            evs = rd["events"]
            kills = out.setdefault((name, number), [])
            for i, e in enumerate(evs):
                title = e["title"]
                pair = next(((pid[n], pid[title[len(n) + 8:]]) for n in nicks
                             if title.startswith(n + " killed ") and title[len(n) + 8:] in pid), None)
                if pair is None:
                    continue
                change = abs(float(e["y"]) - float(evs[i - 1]["y"])) * 100
                kills.append((pair[0], pair[1], change, credits.get(i, {})))
    return out


def events(data: Path) -> list[dict]:
    """Every enemy kill of the dump joined to HLTV's credits for it, with the damage ledger."""
    root = data / "model-rating3"
    rounds = {(r["hltv"], r["ri"]): r["number"] for r in jsonl(root / "rating-winprob.private.jsonl")}
    by_round = defaultdict(list)
    for k in jsonl(root / "rating-kills.private.jsonl"):
        if k["postEnd"]:
            continue
        by_round[(k["hltv"], k["ri"])].append(k)
    hits = defaultdict(list)
    for h in jsonl(root / "rating-hits.private.jsonl"):
        if not h["postEnd"]:
            hits[(h["hltv"], h["ri"], h["victim"])].append(h)
    hltv = hltv_kill_credits(data / "hltv", {m for m, _ in rounds})
    out = []
    for (m, ri), kills in by_round.items():
        kills.sort(key=lambda k: k["tick"])
        enemy = [k for k in kills if k["enemy"] and k["killer"] is not None]
        listed = list(hltv.get((m, rounds[(m, ri)]), []))
        for k in enemy:
            # HLTV's kill with the same killer and victim, in order; a kill HLTV does not list is skipped
            at = next((i for i, x in enumerate(listed) if x[0] == k["killer"] and x[1] == k["victim"]), None)
            if at is None:
                continue
            _, _, change, credits = listed.pop(at)
            if change < MIN_CHANGE:
                continue
            dmg = defaultdict(float)
            for x in hits.get((m, ri, k["victim"]), []):
                if x["tick"] <= k["tick"] and x["attacker"] is not None:
                    dmg[x["attacker"]] += x["dmg"]
            traded = sorted(((d["victim"], (k["tick"] - d["tick"]) / TICK_RATE) for d in enemy
                             if d["killer"] == k["victim"] and d["tick"] <= k["tick"]), key=lambda x: -x[1])
            failed = [(d["victim"], (d["tick"] - k["tick"]) / TICK_RATE) for d in enemy
                      if d["killer"] == k["killer"] and d["victimSide"] == k["victimSide"] and d["tick"] > k["tick"]]
            out.append({"change": change, "killer": k["killer"], "victim": k["victim"], "dmg": dict(dmg),
                        "traded": traded, "failed": failed[:1], "credits": credits})
    return out


def gain_weights(e: dict, kill_w: float, trade_w: float, window: float) -> dict:
    """Each gaining player's weight: damage on the victim, plus the kill and trade weights."""
    w = {p: d for p, d in e["dmg"].items() if p != e["victim"]}
    w[e["killer"]] = w.get(e["killer"], 0) + kill_w
    for p, dt in e["traded"]:
        if dt <= window:
            w[p] = w.get(p, 0) + trade_w
            break
    return w


def gain_shares(e: dict, kill_w: float, trade_w: float, window: float) -> dict:
    w = gain_weights(e, kill_w, trade_w, window)
    total = sum(w.values())
    return {p: e["change"] * x / total for p, x in w.items()}


def clean(e: dict) -> bool:
    """No credited gaining player outside the damage ledger, the killer and the trade candidates: no flash credit."""
    cands = set(e["dmg"]) | {e["killer"]} | {p for p, _ in e["traded"]}
    return all(p in cands for p, v in e["credits"].items() if v > 0 and p != e["victim"])


def fit(ev: list[dict], window: float) -> dict:
    rows = [e for e in ev if clean(e)]

    def residuals(theta):
        out = []
        for e in rows:
            pred = gain_shares(e, theta[0], theta[1], window)
            pos = {p: v for p, v in e["credits"].items() if v > 0 and p != e["victim"]}
            for p in set(pred) | set(pos):
                out.append(pred.get(p, 0.0) - pos.get(p, 0.0))
        return np.array(out)

    sol = least_squares(residuals, [57.0, 100.0], loss="soft_l1", f_scale=0.02)
    err = np.abs(residuals(sol.x))
    return {"kill_weight": float(sol.x[0]), "trade_weight": float(sol.x[1]), "observations": len(rows),
            "credits": int(len(err)), "mae_points": float(err.mean()), "within_0_01": float((err <= 0.0101).mean())}


def flash_weight(ev: list[dict], kill_w: float, trade_w: float, window: float) -> dict:
    """Implied weight of one flasher: a credited gaining player with no damage who is not a trade candidate."""
    ws = []
    for e in ev:
        pos = {p: v for p, v in e["credits"].items() if v > 0 and p != e["victim"]}
        extra = [p for p in pos if p not in e["dmg"] and p != e["killer"] and p not in {q for q, _ in e["traded"]}]
        if len(extra) != 1 or e["killer"] not in pos:
            continue
        base = gain_weights(e, kill_w, trade_w, window)
        # the killer's credit fixes the total weight; what the known weights leave is the flasher's
        total = base[e["killer"]] * e["change"] / pos[e["killer"]]
        ws.append(total - sum(base.values()))
    ws = np.array(ws)
    return {"flash_weight": float(np.median(ws)), "observations": int(len(ws)),
            "iqr": [float(np.quantile(ws, 0.25)), float(np.quantile(ws, 0.75))]}


def victim_share(ev: list[dict], window: float) -> dict:
    """The failed trader's share of the victim's charge, where HLTV split it between exactly two players."""
    shares = []
    for e in ev:
        if not e["failed"] or e["failed"][0][1] > window:
            continue
        neg = {p: -v for p, v in e["credits"].items() if v < 0}
        f = e["failed"][0][0]
        if set(neg) == {e["victim"], f}:
            shares.append(neg[f] / e["change"])
    s = float(np.median(shares))
    return {"failed_trade_share": s, "observations": len(shares),
            "victim_weight": 100.0 * (1 - s) / s, "failed_trade_weight": 100.0}


def defuse_events(hltv: Path) -> list[dict]:
    """Every defuse HLTV credits: its change, the defuser, and the winners' positive credits from the
    events after the plant that moved the round the defusers' way, from HLTV's map files alone."""
    out = []
    for path in sorted(hltv.glob("map_*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("v") != 3:
            continue
        perf = d["performance"]
        team = {}
        for board in d["scoreboards"]:
            if "totalstats" in board["cls"].split():
                for r in board["rows"]:
                    team[r["player"]] = board["head"][0][1]
        for rname, rd in perf["rounds"].items():
            credits = defaultdict(dict)
            for p in perf["players"]:
                for i, (_, text) in enumerate(p["events"].get(rname, [])):
                    for nick, value in CREDIT.findall(text):
                        if nick.strip() == p["nick"]:
                            credits[i][nick.strip()] = float(value)
            evs = rd["events"]
            plant = None
            for i, e in enumerate(evs[1:], start=1):
                title = e["title"]
                change = (float(e["y"]) - float(evs[i - 1]["y"])) * 100
                if title.endswith(" planted the bomb"):
                    plant = i
                if not title.endswith(" defused the bomb") or plant is None or abs(change) < 0.05:
                    continue
                defuser = title[: -len(" defused the bomb")]
                if defuser not in team:
                    continue
                after = [credits.get(j, {}) for j in range(plant + 1, i)
                         if np.sign((float(evs[j]["y"]) - float(evs[j - 1]["y"]))) == np.sign(change)]
                pos = defaultdict(float)
                for c in after:
                    for nick, v in c.items():
                        if v > 0 and team.get(nick) == team[defuser]:
                            pos[nick] += v
                winners = {n: v for n, v in credits.get(i, {}).items() if team.get(n) == team[defuser]}
                out.append({"change": abs(change), "defuser": defuser, "replay": dict(pos), "credits": winners})
    return out


def defuse_share(hltv: Path) -> dict:
    """The defuser's share of a defuse's change when earlier events since the plant take the rest."""
    ev = [e for e in defuse_events(hltv) if e["replay"]]

    def errors(share):
        err = []
        for e in ev:
            total = sum(e["replay"].values())
            pred = {n: (1 - share) * e["change"] * v / total for n, v in e["replay"].items()}
            pred[e["defuser"]] = pred.get(e["defuser"], 0.0) + share * e["change"]
            err.extend(abs(pred.get(n, 0.0) - e["credits"].get(n, 0.0)) for n in set(pred) | set(e["credits"]))
        return np.array(err)

    grid = [float(round(x, 2)) for x in np.arange(0.30, 0.91, 0.05)]
    scores = {x: float(errors(x).mean()) for x in grid}
    best = min(scores, key=scores.get)
    err = errors(best)
    return {"defuse_share": best, "defuses": len(ev), "credits": int(len(err)), "mae_points": float(err.mean()),
            "within_0_01": float((err <= 0.0101).mean()), "grid_mae": {str(k): v for k, v in scores.items()}}


def fit_block(data: Path) -> dict:
    ev = events(data)
    windows = {}
    for window in (5.0, 5.25, 5.5, 5.75, 6.0):
        windows[window] = fit(ev, window)
    best = min(windows, key=lambda w: windows[w]["mae_points"])
    gain = windows[best]
    flash = flash_weight(ev, gain["kill_weight"], gain["trade_weight"], best)
    debit = victim_share(ev, best)
    defuse = defuse_share(data / "hltv")
    return {
        "kill_weight": gain["kill_weight"],
        "flash_weight": flash["flash_weight"],
        "trade_weight": gain["trade_weight"],
        "victim_weight": debit["victim_weight"],
        "failed_trade_weight": debit["failed_trade_weight"],
        "trade_window_seconds": best,
        "defuse_share": defuse["defuse_share"],
        "fit": {"kills": len(ev), "gain": gain, "flash": flash, "debit": debit, "defuse": defuse,
                "windows": {str(w): {k: v for k, v in r.items()} for w, r in windows.items()}},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    check_output(args.out, private=True, what="the swing credit fit report")
    block = fit_block(args.data)
    write_json(args.out, block, private=True, what="the swing credit fit report", indent=2)
    print(json.dumps({k: v for k, v in block.items() if k != "fit"}, indent=2))


if __name__ == "__main__":
    main()
