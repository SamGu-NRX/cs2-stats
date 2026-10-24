"""Builds an HLTV-style match page from a cs2-stats snapshot (the server's own match/per-round stats).

Usage: python -I matchpage.py <snapshot.json> <out.html> [events.jsonl]
"""
import html
import json
import re
import sys

snap = json.load(open(sys.argv[1], encoding="utf-8"))
out_path = sys.argv[2]
events_path = sys.argv[3] if len(sys.argv) > 3 else None

n = snap["RoundsPlayed"]
HALF = 12

# ---- round outcomes. MatchStats_RoundResults codes, matched against round_end winner/reason
# events from the 2026-10-24 18:09 match (CS2 1.41.9.2):
#   1 = CT eliminated the Ts, 3 = bomb defused, 4 = time ran out (CT), 5 = Ts eliminated the CTs,
#   6 = bomb exploded. Any other code is a hard error rather than a guess.
ROUND_RESULT = {1: (3, "elim"), 3: (3, "defuse"), 4: (3, "time"), 5: (2, "elim"), 6: (2, "bomb")}
alive_ct, alive_t, codes = snap["AliveCT"], snap["AliveT"], snap["RoundResults"]
rounds = []
for i in range(n):
    if codes[i] not in ROUND_RESULT:
        sys.exit(f"Unknown round result code {codes[i]} in round {i + 1}; add it to ROUND_RESULT.")
    side, how = ROUND_RESULT[codes[i]]
    rounds.append({"side": side, "elim": how == "elim", "how": how,
                   "left": alive_ct[i] if side == 3 else alive_t[i]})

players = snap["Players"]
human = next(p for p in players if not p["IsBot"])
cur_team = human["Team"]  # side the human's team is on now


def team_side(round_idx, team_now):
    """Side a team (identified by its current side) played in a given round; MR12 halves swap."""
    cur_half = (n - 1) // HALF if n else 0
    r_half = round_idx // HALF
    return team_now if (cur_half - r_half) % 2 == 0 else (5 - team_now)


us_wins = sum(1 for i, r in enumerate(rounds) if r["side"] == team_side(i, cur_team))
them_wins = n - us_wins
# The team entity's score follows the team across halftime, so it must match the tally.
team_score = {t["TeamNum"]: t["Score"] for t in snap["Teams"]}
if (team_score.get(cur_team), team_score.get(5 - cur_team)) != (us_wins, them_wins):
    sys.exit(f"Round tally {us_wins}-{them_wins} disagrees with the game's score "
             f"{team_score.get(cur_team)}-{team_score.get(5 - cur_team)}")


# ---- event log (optional): trades and traded deaths
# The log can span several matches: the game rolls into a new match after the end screen
# and its round counter restarts. Split there and use the segment that ends on this match's
# last round (events on the end screen carry round index n).
traded_deaths, trade_kills, covered, full_log, trade_note = set(), {}, [], False, ""
kill_counts, traded_count, opening_traded = {}, {}, {}
if events_path:
    segments, seg = [], []
    for line in open(events_path, encoding="utf-8"):
        if not line.strip():
            continue
        e = json.loads(line)
        if seg and e["Round"] < seg[-1]["Round"]:
            segments.append(seg)
            seg = []
        seg.append(e)
    segments.append(seg)
    fits = [s for s in segments if max(e["Round"] for e in s) in (n - 1, n)]
    fits.sort(key=lambda s: min(e["Round"] for e in s))
    evs = [e for e in (fits[0] if fits else []) if e["Round"] < n]
    covered = sorted({e["Round"] for e in evs if e["T"] == "freeze_end"})
    full_log = covered == list(range(n))
    deaths = [e for e in evs if e["T"] == "death" and e["Data"]["Attacker"]]
    # A death is traded when its killer is killed by one of the victim's teammates within 5 s.
    for i, e in enumerate(deaths):
        victim, killer = e["Data"]["Victim"], e["Data"]["Attacker"]
        for f in deaths[i + 1:]:
            if f["Round"] != e["Round"] or f["Time"] - e["Time"] > 5:
                break
            if f["Data"]["Victim"]["Slot"] == killer["Slot"] and f["Data"]["Attacker"]["Team"] == victim["Team"]:
                traded_deaths.add((e["Round"], victim["PlayerName"]))
                name = f["Data"]["Attacker"]["PlayerName"]
                trade_kills[name] = trade_kills.get(name, 0) + 1
                break
    # Kill-by-kill counts for the Sniping, Trading and Entrying groups. Enemy kills only.
    SNIPERS = {"awp", "ssg08", "scar20", "g3sg1"}
    enemy_kills = [e for e in deaths if e["Data"]["Attacker"]["Team"] != e["Data"]["Victim"]["Team"]]
    first_kill = {}
    for e in enemy_kills:
        first_kill.setdefault(e["Round"], e)
    for e in enemy_kills:
        killer, victim = e["Data"]["Attacker"]["PlayerName"], e["Data"]["Victim"]["PlayerName"]
        c = kill_counts.setdefault(killer, {"sk": 0, "sok": 0, "k": 0}); c["k"] += 1
        if e["Data"]["Weapon"] in SNIPERS:
            c["sk"] += 1
            if first_kill.get(e["Round"]) is e:
                c["sok"] += 1
    for (r, victim) in traded_deaths:
        traded_count[victim] = traded_count.get(victim, 0) + 1
        fk = first_kill.get(r)
        if fk is not None and fk["Data"]["Victim"]["PlayerName"] == victim:
            opening_traded[victim] = opening_traded.get(victim, 0) + 1
    logged = sorted({e["Round"] for e in evs})
    scope = "every round" if full_log else "rounds " + ", ".join(str(r + 1) for r in logged)
    trade_note = (f"Trade kills (a kill within 5 s of a teammate's death, avenging it), from the event log for {scope}: "
                  + (", ".join(f"{k} {v}" for k, v in sorted(trade_kills.items(), key=lambda x: -x[1])) or "none"))


# ---- per-player stats
def stats(p):
    m, rs = p["Match"], p["Rounds"][:n]
    kast_rounds = sum(1 for i, r in enumerate(rs)
                      if r["Kills"] or r["Assists"] or not r["Deaths"]
                      or (full_log and (i, p["PlayerName"]) in traded_deaths))
    kpr, dpr, apr = m["Kills"] / n, m["Deaths"] / n, m["Assists"] / n
    adr = m["Damage"] / n
    kast = 100 * kast_rounds / n
    impact = 2.13 * kpr + 0.42 * apr - 0.41
    rating = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587
    shots = m["ShotsFiredTotal"]
    return {
        "name": p["PlayerName"], "bot": p["IsBot"], "team": p["Team"],
        "k": m["Kills"], "d": m["Deaths"], "a": m["Assists"], "diff": m["Kills"] - m["Deaths"],
        "adr": adr, "kast": kast, "rating": rating, "impact": impact,
        "hs": 100 * m["HeadShotKills"] / m["Kills"] if m["Kills"] else 0,
        "ok": m["EntryWins"], "od": m["EntryCount"] - m["EntryWins"],
        "k2": m["Enemy2Ks"], "k3": m["Enemy3Ks"], "k4": m["Enemy4Ks"], "k5": m["Enemy5Ks"],
        "c1": (m["I1v1Wins"], m["I1v1Count"]), "c2": (m["I1v2Wins"], m["I1v2Count"]),
        "util": m["UtilityDamage"], "flashed": m["EnemiesFlashed"],
        "flash_ok": (m["Flash_Successes"], m["Flash_Count"]),
        "acc": 100 * m["ShotsOnTargetTotal"] / shots if shots else 0,
        "eq": sum(r["EquipmentValue"] for r in rs) / n,
        "per_round": [(r["Kills"], r["Deaths"], r["Damage"]) for r in rs],
    }


S = [stats(p) for p in players if p["Team"] in (2, 3)]


def pct_rank(vals, v):
    """Share of the other players this value strictly beats, 0-100 (ties at the bottom score 0)."""
    return round(100 * sum(1 for x in vals if x < v) / (len(vals) - 1))


def attr(key_fn):
    vals = [key_fn(s) for s in S]
    return {s["name"]: pct_rank(vals, key_fn(s)) for s in S}


fire = attr(lambda s: s["k"] / n + s["adr"] / 100 + (s["k3"] + s["k4"] + s["k5"]) / n)
opening = attr(lambda s: s["ok"] - 0.5 * s["od"])
clutch = attr(lambda s: s["c1"][0] + 2 * s["c2"][0])
utility = attr(lambda s: s["util"] / n + 2 * s["flashed"] / n)


def kc(s, key):
    return kill_counts.get(s["name"], {}).get(key, 0)


# These three need every kill in order, so they only exist when the event log covers the match.
if full_log:
    sniping = attr(lambda s: kc(s, "sk") / n + kc(s, "sok") / n)
    trading = attr(lambda s: trade_kills.get(s["name"], 0) / n
                   + 0.5 * trade_kills.get(s["name"], 0) / max(s["k"], 1))
    entrying = attr(lambda s: traded_count.get(s["name"], 0) / n + opening_traded.get(s["name"], 0) / n)

# ---- render
esc = html.escape


def rating_cls(r):
    return "pos" if r >= 1.10 else "neg" if r < 0.90 else ""


def team_rows(team_side_now):
    rows = sorted([s for s in S if s["team"] == team_side_now], key=lambda s: -s["rating"])
    out = []
    for s in rows:
        diff_cls = "pos" if s["diff"] > 0 else "neg" if s["diff"] < 0 else ""
        tag = "" if s["bot"] else '<span class="you">You</span>'
        out.append(f"""<tr><td class="pl">{esc(s['name'])}{tag}</td>
<td>{s['k']}-{s['d']}</td><td class="{diff_cls}">{s['diff']:+d}</td><td>{s['adr']:.1f}</td>
<td>{s['kast']:.1f}%</td><td>{s['hs']:.0f}%</td><td class="rt {rating_cls(s['rating'])}">{s['rating']:.2f}</td></tr>""")
    return "\n".join(out)


def log_cells(s):
    if not full_log:
        return ""
    sk, k = kc(s, "sk"), s["k"]
    sniper = f"{sk} ({100 * sk / k:.0f}%)" if sk else "–"
    td = traded_count.get(s["name"], 0)
    traded = f"{td}/{s['d']}" if s["d"] else "–"
    return f"<td>{sniper}</td><td>{trade_kills.get(s['name'], 0)}</td><td>{traded}</td>"


def detail_rows(team_side_now):
    rows = sorted([s for s in S if s["team"] == team_side_now], key=lambda s: -s["rating"])
    out = []
    for s in rows:
        mk = " ".join(f"{c}×{k}K" for k, c in ((2, s["k2"]), (3, s["k3"]), (4, s["k4"]), (5, s["k5"])) if c) or "–"
        cl = ", ".join(f"1v{x} {w}/{c}" for x, (w, c) in ((1, s["c1"]), (2, s["c2"])) if c) or "–"
        # The server tracks shots fired and equipment value for humans only; bots read 0.
        acc = "–" if s["bot"] else f"{s['acc']:.0f}%"
        eq = "–" if s["bot"] else f"${s['eq']:,.0f}"
        out.append(f"""<tr><td class="pl">{esc(s['name'])}</td><td>{s['ok']}:{s['od']}</td><td class="mk">{mk}</td>
<td>{cl}</td>{log_cells(s)}<td>{s['util']}</td><td>{s['flashed']}</td><td>{acc}</td><td>{eq}</td></tr>""")
    return "\n".join(out)


def bar(v):
    return f'<span class="bar"><i style="width:{v}%"></i></span><b>{v}</b>'


def extra_bars(s):
    if not full_log:
        return ""
    return (f"<span>Entrying</span>{bar(entrying[s['name']])}<span>Trading</span>{bar(trading[s['name']])}"
            f"<span>Sniping</span>{bar(sniping[s['name']])}")


def profile_cards():
    cards = []
    for s in sorted(S, key=lambda s: (s["team"] != cur_team, -s["rating"])):
        trait = f'<span class="muted">{s["k"]}-{s["d"]} · {s["adr"]:.0f} ADR · {s["kast"]:.0f}% KAST</span>'
        side = "us" if s["team"] == cur_team else "them"
        cards.append(f"""<div class="card {side}"><div class="ch"><span class="nm">{esc(s['name'])}</span>
<span class="rt {rating_cls(s['rating'])}">{s['rating']:.2f}</span></div><div class="tr">{trait}</div>
<div class="attrs"><span>Firepower</span>{bar(fire[s['name']])}{extra_bars(s)}<span>Opening</span>{bar(opening[s['name']])}
<span>Clutching</span>{bar(clutch[s['name']])}<span>Utility</span>{bar(utility[s['name']])}</div></div>""")
    return "\n".join(cards)


def history():
    cells_us, cells_them = [], []
    for i in range(max(n, 2 * HALF)):
        gap = ' class="gap"' if i == HALF else ""
        if i >= n:
            cells_us.append(f'<td{gap}><span class="e"></span></td>')
            cells_them.append(f'<td{gap}><span class="e"></span></td>')
            continue
        r = rounds[i]
        we_won = r["side"] == team_side(i, cur_team)
        how = {"elim": "elimination", "defuse": "bomb defused", "time": "time ran out", "bomb": "bomb exploded"}[r["how"]]
        mark = f'<span class="w {"el" if r["elim"] else "ob"}" title="Round {i + 1}: {how}, {r["left"]} left">{r["left"]}</span>'
        (cells_us if we_won else cells_them).append(f"<td{gap}>{mark}</td>")
        (cells_them if we_won else cells_us).append(f'<td{gap}><span class="l"></span></td>')
    us_first = "T" if team_side(0, cur_team) == 2 else "CT"
    them_first = "CT" if us_first == "T" else "T"
    return f"""<table class="hist"><tr><th>Your team<small>{us_first} → {'CT' if us_first == 'T' else 'T'}</small></th>{''.join(cells_us)}</tr>
<tr><th>Opponents<small>{them_first} → {'CT' if them_first == 'T' else 'T'}</small></th>{''.join(cells_them)}</tr></table>"""


def lineup(team):
    count = sum(1 for x in S if x["team"] == team and x["bot"])
    return f"{count} bots"


log_heads = "<th>Sniper K</th><th>Trade K</th><th>Traded D</th>" if full_log else ""
kast_note = ("KAST counts rounds with a kill, assist, survival, or a traded death." if full_log else
             "KAST counts rounds with a kill, assist, or survival; the event log does not cover every round, so trades are left out and it is a lower bound.")


status = "Final" if snap["Reason"] == "match_end" else f"Live · after round {n}"
page = f"""<!doctype html><html><head><meta charset="utf-8"><style>
:root {{ --us: var(--chart-1); --them: var(--chart-2); }}
body {{ font-family: var(--font-sans); color: var(--foreground); }}
.wrap {{ display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }}
.head {{ display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }}
.head .t {{ font-size: 15px; font-weight: 600; }} .head .t.r {{ text-align: right; }}
.score {{ font-family: var(--font-mono); font-size: 40px; font-weight: 700; letter-spacing: -1px; font-variant-numeric: tabular-nums; }}
.score .u {{ color: var(--us); }} .score .x {{ color: var(--muted-foreground); padding: 0 8px; font-weight: 400; }}
.meta {{ text-align: center; color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }}
h3 {{ font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted-foreground); margin: 0 0 8px; font-weight: 600; }}
.scroll {{ overflow-x: auto; }}
table {{ border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }}
.st th, .st td {{ padding: 7px 10px; font-size: 13px; text-align: center; white-space: nowrap; border-bottom: 1px solid var(--border); }}
.st th {{ font-size: 11px; color: var(--muted-foreground); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }}
.st th:first-child {{ text-align: left; }} .st td.pl {{ text-align: left; font-weight: 500; }}
.st thead tr.team th {{ text-align: left; font-size: 13px; color: var(--foreground); text-transform: none; letter-spacing: 0; border-bottom: 2px solid var(--us); }}
.st.them thead tr.team th {{ border-bottom-color: var(--them); }}
.st td {{ font-family: var(--font-mono); }} .st td.pl {{ font-family: var(--font-sans); }}
.pos {{ color: var(--success); }} .neg {{ color: var(--destructive); }}
.rt {{ font-weight: 700; }}
.you {{ margin-left: 8px; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--accent-surface); color: var(--accent-surface-foreground); vertical-align: 1px; }}
.mk {{ font-size: 12px; }}
.hist {{ border-collapse: separate; border-spacing: 3px; }}
.hist th {{ text-align: left; font-size: 12px; font-weight: 600; padding-right: 10px; white-space: nowrap; }}
.hist th small {{ display: block; font-weight: 400; color: var(--muted-foreground); font-size: 10px; }}
.hist td {{ padding: 0; }} .hist td.gap {{ padding-left: 14px; }}
.hist span {{ display: block; width: 22px; height: 22px; border-radius: 5px; font: 600 11px/22px var(--font-mono); text-align: center; }}
.hist tr:first-child .w {{ background: var(--us); color: var(--primary-foreground); }}
.hist tr:last-child .w {{ background: var(--them); color: var(--primary-foreground); }}
.hist .w.ob {{ box-shadow: inset 0 0 0 2px var(--warning); }}
.hist .l {{ background: var(--secondary); opacity: .5; }} .hist .e {{ border: 1px dashed var(--border); }}
.legend {{ font-size: 11px; color: var(--muted-foreground); margin-top: 6px; }}
.cards {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }}
.card {{ background: var(--card); border-radius: var(--radius); padding: 16px; border-left: 3px solid var(--us); }}
.card.them {{ border-left-color: var(--them); }}
.ch {{ display: flex; justify-content: space-between; align-items: baseline; }} .nm {{ font-weight: 600; }}
.ch .rt {{ font-family: var(--font-mono); }}
.tr {{ font-size: 12px; margin: 4px 0 10px; }} .muted {{ color: var(--muted-foreground); }} .small {{ font-size: 11px; margin-top: 2px; }}
.attrs {{ display: grid; grid-template-columns: 70px 1fr 26px; gap: 5px 8px; align-items: center; font-size: 11px; }}
.attrs b {{ font: 600 11px var(--font-mono); text-align: right; }}
.bar {{ height: 6px; background: var(--secondary); border-radius: 3px; overflow: hidden; }}
.bar i {{ display: block; height: 100%; background: var(--foreground); opacity: .75; }}
.notes {{ font-size: 11px; color: var(--muted-foreground); line-height: 1.55; display: grid; gap: 4px; }}
</style></head><body><div class="wrap">
<div><div class="head"><div class="t">Your team<div class="muted" style="font-size:12px;font-weight:400">{esc(human['PlayerName'])} + {lineup(cur_team)}</div></div>
<div class="score"><span class="u">{us_wins}</span><span class="x">:</span><span>{them_wins}</span></div>
<div class="t r">Opponents<div class="muted" style="font-size:12px;font-weight:400">{lineup(5 - cur_team)}</div></div></div>
<div class="meta">{esc(snap['Map'])} · MR12 · {status}</div></div>
<div><h3>Round history</h3><div class="scroll">{history()}</div>
<div class="legend">Number = players left alive on the winning side. Outlined = won by bomb, defuse or time instead of elimination. Hover a round for details.</div></div>
<div class="scroll"><table class="st"><thead><tr class="team"><th colspan="7">Your team</th></tr>
<tr><th>Player</th><th>K-D</th><th>+/-</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Rating</th></tr></thead>
<tbody>{team_rows(cur_team)}</tbody></table></div>
<div class="scroll"><table class="st them"><thead><tr class="team"><th colspan="7">Opponents</th></tr>
<tr><th>Player</th><th>K-D</th><th>+/-</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Rating</th></tr></thead>
<tbody>{team_rows(5 - cur_team)}</tbody></table></div>
<div><h3>Detailed stats</h3><div class="scroll"><table class="st"><thead>
<tr><th>Player</th><th>Opening K:D</th><th>Multi-kills</th><th>Clutches</th>{log_heads}<th>Util dmg</th><th>Flashed</th><th>Accuracy</th><th>Avg equip</th></tr></thead>
<tbody>{detail_rows(cur_team)}{detail_rows(5 - cur_team)}</tbody></table></div></div>
<div><h3>Playstyle this match</h3><div class="cards">{profile_cards()}</div></div>
<div class="notes">
<div>Rating uses the public approximation of HLTV Rating 2.0. HLTV's current rating (3.0) adds round swing and eco adjustment, and its full formula isn't published; round swing comes with the stats app.</div>
<div>{kast_note}</div>
<div>Attribute bars rank each player against the other nine in this lobby (100 = best here), not against pros. Entrying = traded deaths and traded opening deaths per round; Trading = trade kills per round and as a share of kills; Sniping = AWP/SSG 08/autosniper kills and sniper opening kills per round. These three need the full kill log.</div>
{f'<div>{esc(trade_note)}</div>' if trade_note else ''}
</div></div></body></html>"""
open(out_path, "w", encoding="utf-8").write(page)
print("rounds", n, "score", us_wins, them_wins, "players", len(S))
for s in sorted(S, key=lambda s: -s["rating"]):
    print(f"{s['name'][:14]:14} {s['k']:>2}-{s['d']:<2} adr {s['adr']:5.1f} kast {s['kast']:5.1f} rating {s['rating']:.2f}")
