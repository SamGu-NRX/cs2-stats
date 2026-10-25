"""Extract the schema v1 match tables (SCHEMA-v1.md) from one CS2 demo.

Usage: python -I extract.py <demo.dem> <out_dir> --source {local,valve,faceit,hltv}
       [--mapdata DIR] [--archive NAME] [--meta JSON] [--result result.json]

Writes zstd parquet tables to <out_dir> (via <out_dir>.tmp, renamed on success),
validates them against the demo's own end-of-match scoreboard, and prints or
writes a JSON result. Exit code 0 means every table was written and every
fatal check passed. --mapdata is an awpy-data release folder (geometry/*.mesh,
manifest.json); without it, or without the demo's map in it, mesh visibility
is null and match.visibility_status says why.

Two parsers, in order. awpy reads networked velocity, grenade trajectories and
its own kills/blinds/stats for cross-checks, and is freed before demoparser2
loads, so the demo is never in memory twice. demoparser2 builds every table.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import platform
import re
import secrets
import shutil
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from importlib.metadata import version as pkg_version
from pathlib import Path

# Rust thread pools (demoparser2, awpy, polars) default to every core and read
# these at import; the pipeline runs up to 4 workers, so cap each one first.
os.environ.setdefault("RAYON_NUM_THREADS", "4")
os.environ.setdefault("POLARS_MAX_THREADS", "4")

import hashlib  # noqa: E402

# Workers run this file with python -I, which leaves the script's folder off sys.path; add only
# this folder (never a demo's) so the sibling engagements module imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import polars as pl  # noqa: E402

from schema_v1 import KEYS, NULLABLE, TYPES  # noqa: E402
from engagements import (EYE_STANDING, SMOKE_HEIGHT, SMOKE_RADIUS, bot_id, eye_z, group_triggers,  # noqa: E402
                         in_view_cone, mesh_visible, smoke_blocked, visibility_onsets, window_ticks)

SCHEMA_VERSION = 1
EXTRACTOR_VERSION = "1.8.0"
SOURCES = ("local", "valve", "faceit", "hltv")
# Mesh visibility is withheld for a map whose mesh disagrees with the demo: at kills that were not
# wallbangs, the attacker must have mesh line of sight to the victim at least this often. Measured:
# 0.955 on fixture B (Ancient) with the matching mesh. No mismatched mesh has been
# tried, so the threshold is a guard against gross mismatch, not a calibrated cut.
MESH_MIN_KILL_AGREEMENT = 0.9
# A demo cut off mid-file: awpy refuses it with one of these, demoparser2 reads it up to the cut.
TRUNCATION_MESSAGES = ("unexpected end of data", "outside command stream")
TRUNCATED = "truncated_demo"
TRADE_WINDOW_S = 5.0  # set explicitly; awpy 3.1.1 hard-codes 5.25 s and exposes no parameter.
POSITION_STRIDE_TICKS = 16  # 4 Hz at 64 tick.
# Ticks per parse_ticks call in the every-tick flash/spotted pass. Each call re-reads the demo
# (about 1-2 s on the Dust2 test demo), and one whole-demo call peaked at 1.79 GB there, so
# 120k ticks (3 calls on Dust2) trades a few seconds for a bounded peak on long overtime demos.
ALL_TICK_CHUNK = 120_000
ZSTD_LEVEL = 9

# ---------------------------------------------------------------------------
# Item prices
# ---------------------------------------------------------------------------
# Prices come only from PRICE_FILE, decoded from this game build's files (its
# "source" field says how). It is keyed by game class names (weapon_m4a1);
# demoparser2 reports display names (M4A4), so DISPLAY_TO_CLASS translates.
# A name missing from either raises UnknownItemPrice; nothing is estimated.
PRICE_FILE = Path(__file__).resolve().parent / "prices_cs2_1.41.9.2.json"


def load_prices(path: Path = PRICE_FILE) -> tuple[dict[str, int], str]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("source", "weapons", "items"):
        if key not in raw:
            raise ValueError(f"{path}: missing {key!r}")
    table = {**raw["weapons"], **raw["items"]}
    bad = {k: v for k, v in table.items() if not isinstance(v, int) or v < 0}
    if bad:
        raise ValueError(f"{path}: non-integer or negative prices {bad}")
    return table, raw["source"]


CLASS_PRICES, PRICE_SOURCE = load_prices()

# demoparser2 0.42.0 display name -> game class name. The 29 pairs marked "seen"
# were confirmed on the test demos, where each weapon_fire row carries both the
# class (event field) and the display name (active weapon). The rest follow the
# same naming and have not been seen in a demo yet.
DISPLAY_TO_CLASS = {
    # seen
    "AK-47": "weapon_ak47", "AWP": "weapon_awp", "Butterfly Knife": "weapon_knife_butterfly",
    "Decoy Grenade": "weapon_decoy", "Desert Eagle": "weapon_deagle", "Dual Berettas": "weapon_elite",
    "FAMAS": "weapon_famas", "Five-SeveN": "weapon_fiveseven", "Flashbang": "weapon_flashbang",
    "Galil AR": "weapon_galilar", "Glock-18": "weapon_glock", "High Explosive Grenade": "weapon_hegrenade",
    "Incendiary Grenade": "weapon_incgrenade", "Karambit": "weapon_knife_karambit",
    "M4A1-S": "weapon_m4a1_silencer", "M4A4": "weapon_m4a1", "M9 Bayonet": "weapon_knife_m9_bayonet",
    "MAC-10": "weapon_mac10", "MP7": "weapon_mp7", "MP9": "weapon_mp9", "Molotov": "weapon_molotov",
    "P250": "weapon_p250", "SSG 08": "weapon_ssg08", "Skeleton Knife": "weapon_knife_skeleton",
    "Smoke Grenade": "weapon_smokegrenade", "Tec-9": "weapon_tec9", "USP-S": "weapon_usp_silencer",
    "Ursus Knife": "weapon_knife_ursus", "Zeus x27": "weapon_taser",
    # not yet seen in a demo
    "P2000": "weapon_hkp2000", "CZ75-Auto": "weapon_cz75a", "R8 Revolver": "weapon_revolver",
    "MP5-SD": "weapon_mp5sd", "UMP-45": "weapon_ump45", "P90": "weapon_p90", "PP-Bizon": "weapon_bizon",
    "Nova": "weapon_nova", "XM1014": "weapon_xm1014", "MAG-7": "weapon_mag7", "Sawed-Off": "weapon_sawedoff",
    "M249": "weapon_m249", "Negev": "weapon_negev", "SG 553": "weapon_sg556", "AUG": "weapon_aug",
    "G3SG1": "weapon_g3sg1", "SCAR-20": "weapon_scar20", "C4 Explosive": "weapon_c4",
    "Medi-Shot": "weapon_healthshot",
    "Knife": "weapon_knife", "knife": "weapon_knife", "knife_t": "weapon_knife_t", "Bayonet": "weapon_bayonet",
    "Classic Knife": "weapon_knife_css", "Flip Knife": "weapon_knife_flip", "Gut Knife": "weapon_knife_gut",
    "Huntsman Knife": "weapon_knife_tactical", "Falchion Knife": "weapon_knife_falchion",
    "Bowie Knife": "weapon_knife_survival_bowie", "Shadow Daggers": "weapon_knife_push",
    "Paracord Knife": "weapon_knife_cord", "Survival Knife": "weapon_knife_canis",
    "Navaja Knife": "weapon_knife_gypsy_jackknife", "Nomad Knife": "weapon_knife_outdoor",
    "Stiletto Knife": "weapon_knife_stiletto", "Talon Knife": "weapon_knife_widowmaker",
    "Kukri Knife": "weapon_knife_kukri",
    # equipment (item_purchase names)
    "Kevlar Vest": "item_kevlar", "Kevlar & Helmet": "item_assaultsuit",
    "Heavy Assault Suit": "item_heavyassaultsuit", "Defuse Kit": "item_defuser", "Rescue Kit": "item_cutters",
}


class UnknownItemPrice(KeyError):
    """An item has no price in PRICE_FILE (or no class-name mapping)."""


def item_price(name: str) -> int:
    cls = DISPLAY_TO_CLASS.get(name)
    if cls is None:
        raise UnknownItemPrice(f"no class-name mapping for item {name!r}; add it to extract.DISPLAY_TO_CLASS")
    if cls not in CLASS_PRICES:
        raise UnknownItemPrice(f"{name!r} ({cls}) is missing from {PRICE_FILE.name}")
    return CLASS_PRICES[cls]


# Buying a helmet over an existing vest is logged as "Kevlar & Helmet" at the difference.
HELMET_UPGRADE_COST = item_price("Kevlar & Helmet") - item_price("Kevlar Vest")
VEST_PRICE = item_price("Kevlar Vest")
DEFUSER_PRICE = item_price("Defuse Kit")

# Slot membership is a fact about the weapon, independent of price.
SECONDARY_WEAPONS = frozenset({
    "Glock-18", "USP-S", "P2000", "Dual Berettas", "P250", "Tec-9", "Five-SeveN",
    "CZ75-Auto", "Desert Eagle", "R8 Revolver",
})
PRIMARY_WEAPONS = frozenset({
    "MAC-10", "MP9", "MP7", "MP5-SD", "UMP-45", "P90", "PP-Bizon",
    "Nova", "XM1014", "MAG-7", "Sawed-Off", "M249", "Negev",
    "Galil AR", "FAMAS", "AK-47", "M4A4", "M4A1-S", "SG 553", "AUG",
    "SSG 08", "AWP", "G3SG1", "SCAR-20",
})


def inventory_value(inventory) -> int:
    return sum(item_price(x) for x in (inventory if inventory is not None else []))


def most_expensive(inventory, slot: frozenset[str]) -> tuple[str | None, int | None]:
    best, best_price = None, None
    for x in inventory if inventory is not None else []:
        if x in slot:
            p = item_price(x)
            if best_price is None or p > best_price:
                best, best_price = x, p
    return best, best_price


def check_purchase_cost(item: str, cost: int) -> str | None:
    """Return an error string when a purchase contradicts PRICE_FILE, else None."""
    if item == "Kevlar & Helmet" and cost == HELMET_UPGRADE_COST:
        return None
    try:
        expected = item_price(item)
    except UnknownItemPrice:
        return f"purchase of unpriced item {item!r} at {cost}"
    if expected != cost:
        return f"price table says {item!r}={expected}, demo purchase cost {cost}"
    return None


# ---------------------------------------------------------------------------
# Validation (pure functions over DataFrames; unit-tested)
# ---------------------------------------------------------------------------

def validate_scoreboard(kills: pd.DataFrame, game_damage: dict[int, int], scoreboard: pd.DataFrame) -> list[dict]:
    """Compare event-derived K/D/A, and the per-round damage counter, with the final-tick scoreboard.

    Definitions, each reproduced exactly on the two test demos:
    - kills: kills on enemies. A player with team kills or suicides may instead
      show kills minus those (CS2 deducts them); either value passes, noted.
    - deaths: every death, any cause.
    - assists: every assist, flash assists included, except when the
      assister is on the victim's team.
    - damage: game_damage, a player's player_rounds.game_damage summed over
      rounds (the game's own damage_total, read per round). The hit table is
      checked against it separately (hit_table_checks), so a hit the demo lost
      cannot decide this check.
    A player with events but no final-tick controller (a disconnect) is noted,
    not failed. kills carries steamids as UInt64 and uses the kills table's
    column names.
    """
    checks: list[dict] = []
    sb = scoreboard.set_index("steamid")
    enemy = kills[~kills.is_teamkill & ~kills.is_suicide & kills.attacker_steamid.notna()]
    tk = kills[kills.is_teamkill & ~kills.is_suicide]
    sui = kills[kills.is_suicide]
    involved = set(kills.attacker_steamid.dropna()) | set(kills.victim_steamid.dropna())
    # player_death names an assister even when he damaged his own teammate (the victim);
    # the scoreboard does not count that (seen on a pro demo).
    credited = (kills.assister_side != kills.v_side).fillna(True).astype(bool)
    for sid in sorted(involved | set(sb.index)):
        if sid not in sb.index:
            checks.append(dict(check="present_on_scoreboard", steamid=int(sid), expected=None, actual=None,
                               ok=True, fatal=False, note="absent from final scoreboard (disconnect)"))
            continue
        row = sb.loc[sid]
        k = int((enemy.attacker_steamid == sid).sum())
        n_tk = int((tk.attacker_steamid == sid).sum())
        n_sui = int((sui.victim_steamid == sid).sum())
        d = int((kills.victim_steamid == sid).sum())
        a = int(((kills.assister_steamid == sid) & credited).sum())
        dmg = int(game_damage.get(int(sid), 0))
        sb_k = int(row.kills_total)
        k_ok = sb_k == k or (n_tk + n_sui > 0 and sb_k == k - n_tk - n_sui)
        note = f"teamkills={n_tk} suicides={n_sui}" if n_tk + n_sui else ""
        checks.append(dict(check="kills", steamid=int(sid), expected=sb_k, actual=k, ok=k_ok, fatal=True, note=note))
        for name, exp, act in (("deaths", row.deaths_total, d), ("assists", row.assists_total, a)):
            checks.append(dict(check=name, steamid=int(sid), expected=int(exp), actual=act,
                               ok=int(exp) == act, fatal=True, note=""))
        checks.append(dict(check="damage", steamid=int(sid), expected=int(row.damage_total), actual=dmg,
                           ok=int(row.damage_total) == dmg, fatal=True, note=""))
        hs = int(((enemy.attacker_steamid == sid) & enemy.headshot).sum())
        checks.append(dict(check="headshot_kills", steamid=int(sid), expected=int(row.headshot_kills_total),
                           actual=hs, ok=int(row.headshot_kills_total) == hs, fatal=False, note=""))
    return checks


def validate_rounds(rounds: pd.DataFrame, final_score: dict[str, int]) -> list[dict]:
    """Every round has ordered start/freeze-end/end ticks; wins add up to the final score."""
    checks: list[dict] = []
    for r in rounds.itertuples():
        ticks = (r.start_tick, r.freeze_end_tick, r.end_tick)
        actual = [None if pd.isna(t) else int(t) for t in ticks]
        why = ("recording began with round 1 live; no freeze end" if getattr(r, "started_live", False) else
               "aborted round; it may end before its freeze end" if getattr(r, "aborted", False) else None)
        if why and pd.isna(r.freeze_end_tick) and not pd.isna(r.start_tick) and r.start_tick <= r.end_tick:
            checks.append(dict(check="round_ticks", round=int(r.round), expected="start<=end", actual=actual,
                               ok=True, fatal=False, note=why))
            continue
        present = all(t is not None and not pd.isna(t) for t in ticks)
        ordered = present and r.start_tick <= r.freeze_end_tick <= r.end_tick
        checks.append(dict(check="round_ticks", round=int(r.round), expected="start<=freeze_end<=end",
                           actual=actual, ok=bool(ordered), fatal=True, note=""))
    total = sum(final_score.values())
    played = int((~rounds["aborted"]).sum()) if "aborted" in rounds else len(rounds)
    checks.append(dict(check="round_count", expected=total, actual=played, ok=total == played, fatal=True,
                       note="aborted rounds have no winner and are not counted" if played != len(rounds) else ""))
    wins = rounds.winner_team.value_counts().to_dict()
    for team, score in final_score.items():
        checks.append(dict(check="team_wins", team=team, expected=int(score), actual=int(wins.get(team, 0)),
                           ok=int(wins.get(team, 0)) == int(score), fatal=True, note=""))
    seq = list(rounds["round"])
    checks.append(dict(check="round_numbers_contiguous", expected=list(range(1, len(seq) + 1)) == seq,
                       actual=True, ok=list(range(1, len(seq) + 1)) == seq, fatal=True, note=""))
    return checks


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SIDE = {2: "T", 3: "CT"}
# HLTV names demos "<team1>-vs-<team2>-m<N>-<map>.dem"; single-map matches drop "-m<N>".
FILE_RE = re.compile(r"^(?P<team1>.+?)-vs-(?P<team2>.+?)-(?:m(?P<n>\d+)-)?(?P<map>[a-z0-9_]+?)(?:-p(?P<part>\d+))?$")
# Events with no analytic value. Everything else lands in a dedicated table or events_misc.
NOISE_EVENTS = frozenset({"server_cvar", "hltv_chase", "hltv_fixed", "hltv_versioninfo", "hltv_status",
                          "hltv_message", "hltv_title", "hltv_replay", "hltv_cameraman"})
# demoparser2 synthesizes these even when the demo has no such game event.
SYNTH_EVENTS = ("round_start", "round_end", "round_officially_ended", "item_purchase")

STATE_PROPS = ["X", "Y", "Z", "pitch", "yaw", "health", "armor_value", "has_helmet", "has_defuser",
               "active_weapon_name", "inventory", "current_equip_value", "balance", "last_place_name",
               "team_num", "flash_duration", "is_scoped", "ducking", "ducked", "is_airborne", "is_walking",
               "shots_fired", "accuracy_penalty", "duck_amount", "zoom_lvl", "active_weapon_ammo",
               "CCSPlayerPawn.m_flVelocityModifier", "which_bomb_zone", "is_alive"]
LIGHT_PROPS = ["X", "Y", "Z", "team_num", "last_place_name"]
POSITION_PROPS = ["X", "Y", "Z", "pitch", "yaw", "is_alive", "health", "armor_value", "has_helmet",
                  "active_weapon_name", "last_place_name", "ducking", "ducked", "is_scoped", "is_walking",
                  "is_airborne", "flash_duration", "spotted", "approximate_spotted_by", "team_num",
                  "CCSPlayerPawn.m_flVelocityModifier", "balance", "duck_amount", "user_id"]
ECON_PROPS = ["balance", "cash_spent_this_round", "current_equip_value", "round_start_equip_value",
              "inventory", "armor_value", "has_helmet", "has_defuser", "team_num", "team_clan_name"]
# Scoreboard counters checked against the events, read at the start of the recording too.
BASELINE_PROPS = ["kills_total", "deaths_total", "assists_total", "damage_total", "headshot_kills_total",
                  "team_rounds_total"]
SCOREBOARD_PROPS = ["kills_total", "deaths_total", "assists_total", "damage_total", "headshot_kills_total",
                    "utility_damage_total", "enemies_flashed_total", "alive_time_total", "money_saved_total",
                    "kill_reward_total", "cash_earned_total", "equipment_value_total", "ace_rounds_total",
                    "4k_rounds_total", "3k_rounds_total", "objective_total", "mvps", "score", "team_num",
                    "team_clan_name", "team_rounds_total", "crosshair_code"]
UNAVAILABLE = {
    "damages.penetration": "player_hurt carries no penetration field; kills.penetrated has it for kill shots",
    "shots.aim_punch": "m_aimPunchAngle is not networked to GOTV (prop absent in demoparser2 and awpy)",
    "positions.spotted_by_mask": "raw m_bSpottedByMask not exposed; approximate_spotted_by (steamid list) stored",
    "infernos.extent": "per-flame positions not exposed; inferno origin and lifetime stored",
    "blinds.source": "player_blind is absent from GOTV demos; rebuilt from flash_duration changes",
    "velocity.source": "demoparser2 velocity is position-differenced; networked m_vecVelocity read via awpy",
    "spotted.lag": "m_bSpottedByMask lags real visibility; use it for information metrics, never for aim",
    "weapon_max_speed": "no verified per-weapon max-speed source available offline; join a cited table later",
}


def to_u64(s: pd.Series) -> pd.Series:
    """Normalize steamids to nullable UInt64; 0 and missing become NA.

    Steamids exceed 2**53, so they must never pass through float64: integer
    columns convert directly, anything else goes through int(str(v)).
    A float column cannot be trusted and raises.
    """
    if s.dtype.kind in "ui":
        vals = s.to_numpy().astype("uint64")
        arr = pd.array(vals, dtype="UInt64")
        arr[vals == 0] = pd.NA
        return pd.Series(arr, index=s.index)
    if s.dtype.kind == "f" and s.notna().any():
        raise TypeError(f"steamid column {s.name!r} is float64; precision already lost")
    out = []
    for v in s:
        if v is None or v is pd.NA or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
        else:
            iv = int(str(v))
            out.append(iv if iv else None)
    return pd.Series(pd.array(out, dtype="UInt64"), index=s.index)


def resolve_ids(steamid: pd.Series, name: pd.Series, bots: dict[str, int]) -> pd.Series:
    """Player ids: the SteamID64 for humans; for a bot (steamid 0 or missing) its bot_id, looked up by name."""
    ids = to_u64(steamid)
    missing = ids.isna() & name.isin(list(bots))
    if missing.any():
        ids = ids.copy()
        ids[missing] = pd.array([bots[n] for n in name[missing]], dtype="UInt64")
    return ids


def col(df: pd.DataFrame, name: str, default=np.nan) -> pd.Series:
    return df[name] if name in df.columns else pd.Series(default, index=df.index)


@dataclass
class Context:
    dem: Path
    out: Path
    archive: str
    meta_extra: dict
    tick_rate: float = 64.0
    timings: dict = field(default_factory=dict)
    tables: dict = field(default_factory=dict)
    info: dict = field(default_factory=dict)
    rss_gb: dict = field(default_factory=dict)
    velocity: pd.DataFrame | None = None  # networked velocity at every tick, from awpy
    mapdata: Path | None = None
    truncated: bool = False  # awpy could not read the demo to its end
    _awpy_demo: object = None

    def awpy_demo(self):
        if self._awpy_demo is None:
            from awpy import Demo
            self._awpy_demo = Demo(str(self.dem))
        return self._awpy_demo


class Timer:
    def __init__(self, ctx: Context, name: str):
        self.ctx, self.name = ctx, name

    def __enter__(self):
        self.t = time.perf_counter()

    def __exit__(self, *a):
        self.ctx.timings[self.name] = round(time.perf_counter() - self.t, 3)
        try:
            import psutil
            self.ctx.rss_gb[self.name] = round(psutil.Process().memory_info().rss / 1e9, 2)
        except Exception:  # noqa: BLE001 - memory telemetry is best-effort
            pass


def sample_grid(first: int, last: int) -> list[int]:
    """Position sample ticks: multiples of POSITION_STRIDE_TICKS, so every stage samples the same ticks."""
    s = POSITION_STRIDE_TICKS
    return list(range(-(-first // s) * s, last + 1, s))


# ---------------------------------------------------------------------------
# Rounds
# ---------------------------------------------------------------------------

def match_start_tick(begin_new_match: list[int], real_round_end_ticks: list[int]) -> int:
    """The last begin_new_match that at least one real round end follows (0 if none).

    A restart after a played round starts the match again (one pro demo: restarts at 99, 5290 and
    5429 after a round had ended; counting from 99 added that round's deaths and an extra round). A
    begin_new_match with no round after it does not: the first part of a split recording can end with one
    after its last round (one demo's first part: rounds end by 133021, begin_new_match at 137818).
    """
    followed = [t for t in begin_new_match if any(e > t for e in real_round_end_ticks)]
    return max(followed) if followed else 0


RESTORE_SETTLE_S = 1.0  # how long after a restore tick its counters are read


def restore_settle_ticks(rate: float) -> int:
    return int(round(RESTORE_SETTLE_S * rate))


def split_restores(windows: list[tuple[int, int]], kills_plus_deaths: dict[int, int], rate: float):
    """(rolled_back, aborted): an attempt is rolled back when the players' kills plus deaths are the same
    RESTORE_SETTLE_S after its restore tick as at its start; otherwise the game kept its stats."""
    settle = restore_settle_ticks(rate)
    rolled_back, aborted = [], []
    for a, b in windows:
        same = kills_plus_deaths.get(b + settle, 0) == kills_plus_deaths.get(a, 0)
        (rolled_back if same else aborted).append((a, b))
    return rolled_back, aborted


def real_round_ends(round_ends: pd.DataFrame) -> pd.Series:
    """A round_end with a winner. A backup restore ends an attempt with a winnerless one (and kills every
    player with "world" on that tick), seen on a pro demo; it is not a round."""
    winner = round_ends.winner.astype("string").str.strip()
    return winner.notna() & ~winner.isin(["", "nan", "None"])


def build_round_windows(round_starts, freeze_ends, round_ends: pd.DataFrame, match_start: int):
    """Return (rounds, voided) where rounds has start/freeze_end/end ticks per round.

    A backup restore replays a round: its earlier attempt has a round_start but
    no round_end. The round's start is the last round_start before its freeze
    end; earlier starts after the previous round's end open voided windows,
    whose events are dropped (the game rolls their stats back too).
    """
    rs = np.sort(np.asarray(round_starts, dtype=np.int64))
    fe = np.sort(np.asarray(freeze_ends, dtype=np.int64))
    real = real_round_ends(round_ends)
    # This also drops the winnerless round_end that some pro demos carry at tick 1, left over
    # from before the recording began.
    ends = round_ends[(round_ends.tick >= match_start) & real].sort_values("tick")
    rows, voided = [], []
    prev_end = None
    for i, e in enumerate(ends.itertuples()):
        lo = prev_end if prev_end is not None else -1
        fe_c = fe[(fe > lo) & (fe <= e.tick)]
        fe_t = int(fe_c.max()) if len(fe_c) else None
        bound = fe_t if fe_t is not None else e.tick
        rs_c = rs[(rs > lo) & (rs <= bound)] if prev_end is not None else rs[rs <= bound]
        start = int(rs_c.max()) if len(rs_c) else None
        if prev_end is not None and len(rs_c) > 1:
            voided.append((int(rs_c.min()), start))
        # Recording that begins with round 1 already live has no freeze end for round 1.
        started_live = i == 0 and fe_t is None and start is not None
        rows.append(dict(round=i + 1, start_tick=start, freeze_end_tick=fe_t, end_tick=int(e.tick),
                         started_live=started_live,
                         winner_side=str(e.winner) if e.winner is not None else None,
                         reason=str(e.reason) if e.reason is not None else None,
                         voided_attempts=int(max(len(rs_c) - 1, 0)) if prev_end is not None else 0))
        prev_end = int(e.tick)
    # Each restore also voids its attempt directly: from the last round_start before the
    # winnerless round_end up to that tick. This covers a restore inside round 1, which the
    # several-starts rule above cannot see (one pro demo: attempt 98, restore 4020).
    for r_tick in round_ends.tick[(round_ends.tick > match_start) & ~real]:
        before = rs[rs < r_tick]
        if len(before):
            voided.append((int(before.max()), int(r_tick)))
    return pd.DataFrame(rows), sorted(set(voided))


def assign_rounds(ticks: pd.Series, rounds: pd.DataFrame, voided: list[tuple[int, int]],
                  game_over: int | None = None) -> pd.Series:
    """Round number for each tick: round i spans [start_i, start_{i+1}); a voided window is [a, b].

    0 means warmup, a voided restore window, or after game over. The final
    scoreboard is read at game over (cs_win_panel_match), and players who
    die to "world" after it are not counted there (seen on a pro
    demo), so those events are dropped.
    """
    starts = rounds.start_tick.to_numpy(dtype=np.int64)
    t = ticks.to_numpy(dtype=np.int64)
    idx = np.searchsorted(starts, t, side="right")
    for a, b in voided:
        idx[(t >= a) & (t <= b)] = 0  # b is the restore tick; its "world" deaths are rolled back too
    if game_over is not None:
        idx[t > game_over] = 0
    return pd.Series(idx.astype(np.int16), index=ticks.index)


def game_damage_by_round(counter: pd.DataFrame, rounds: list[int], boundaries: list[int],
                         baseline: dict[int, int]) -> dict[tuple[int, int], int]:
    """The game's own damage per (round, player), the exact ADR input.

    damage_total rises once per round, on the next round's start tick; boundaries[i] is that tick for
    rounds[i] (the final tick for the last round). A round's damage is the counter's rise over the previous
    boundary, starting from baseline. It is the authoritative per-round damage: it also counts hits whose
    player_hurt the demo lost, which the hit table only recovers through rebuild_lost_hits.
    counter: (tick, steamid, damage_total) rows at the boundary ticks.
    """
    at = counter.dropna(subset=["steamid"]).pivot_table(index="tick", columns="steamid", values="damage_total",
                                                        aggfunc="first")
    before = {int(k): int(v) for k, v in baseline.items()}
    rise = {}
    for rnd, b in zip(rounds, boundaries):
        if b not in at.index:
            continue
        for sid, v in at.loc[b].dropna().items():
            rise[(int(rnd), int(sid))] = int(v) - before.get(int(sid), 0)
            before[int(sid)] = int(v)
    return rise


def rebuild_lost_hits(drops: pd.DataFrame, dmg: pd.DataFrame, side_of: dict) -> pd.DataFrame:
    """Damage rows for health drops that have no player_hurt event on that tick. They never name an attacker.

    GOTV demos can lose a stretch of events: on one pro demo, ticks 9168-9184 have no
    player_hurt or weapon_fire at all, yet health falls (48 -> 0 at 9173, 100 -> 45 at 9182) and
    the game credits both hits. HP before and after come from the networked health. Who did it cannot be
    told: one drop can mix hits from several players, team damage and world damage, and the events that
    would rule a player in or out (weapon_fire, grenade detonations) can be lost in the same gap. Every row
    has a null attacker and reconstructed_ambiguous = true; its HP shows up in the hit-table shortfall
    (hit_table_checks). Kills still come from player_death.
    drops: (tick, steamid, health_before, health_after, round) from the every-tick pass.
    """
    have = set(zip(dmg.tick.astype(int), dmg.victim_steamid.astype("Int64")))
    unexplained = np.array([(int(t), int(v)) not in have for t, v in zip(drops.tick, drops.steamid)], dtype=bool)
    lost = drops[(drops["round"] > 0).to_numpy() & unexplained]
    rows = [dict(tick=int(t), round=int(rnd), attacker_steamid=None, victim_steamid=int(v), weapon=None,
                 hitgroup=None, health_before=int(hp0), health_after=int(hp1), dmg_health_capped=int(hp0) - int(hp1),
                 is_self=False, is_team_damage=False, a_side=None, v_side=side_of.get((int(rnd), int(v))),
                 source="health", reconstructed_ambiguous=True)
            for t, v, hp0, hp1, rnd in zip(lost.tick, lost.steamid, lost.health_before, lost.health_after,
                                           lost["round"])]
    out = pd.DataFrame(rows, columns=["tick", "round", "attacker_steamid", "victim_steamid", "weapon", "hitgroup",
                                      "health_before", "health_after", "dmg_health_capped", "is_self",
                                      "is_team_damage", "a_side", "v_side", "source", "reconstructed_ambiguous"])
    for c in ("attacker_steamid", "victim_steamid"):
        out[c] = to_u64(pd.Series([r[c] for r in rows], index=out.index, dtype=object))
    return out


def hit_table_checks(dmg: pd.DataFrame, player_rounds: pd.DataFrame) -> tuple[list[dict], int]:
    """The hit table against the game's per-round damage counter. (checks, unattributed HP)

    Each player-round's enemy hits in the damages table may fall short of its game_damage: the demo lost the
    events, and the rows rebuilt for them name no attacker. That gap is recorded as a warning and as
    match.unattributed_damage_hp, never matched against anything to pass. Hits over game_damage fail the
    map, because lost events cannot cause them: a round boundary read early, or a hit credited to the
    wrong player, does.
    """
    hits = dmg[~dmg.is_team_damage & dmg.attacker_steamid.notna()].groupby(["round", "attacker_steamid"]) \
        .dmg_health_capped.sum()
    over, short = [], 0
    for r, s_, g in zip(player_rounds["round"], player_rounds.steamid, player_rounds.game_damage):
        if pd.isna(g):
            continue
        h = int(hits.get((r, s_), 0))
        if h > int(g):
            over.append((int(r), int(s_), int(g), h))
        else:
            short += int(g) - h
    rebuilt = int(dmg.loc[dmg.reconstructed_ambiguous.astype(bool), "dmg_health_capped"].sum())
    return [dict(check="hit_table_over_game_damage", expected=0, actual=len(over), ok=not over, fatal=True,
                 note=str(over[:5]) if over else ""),
            dict(check="damage_events_incomplete", expected=0, actual=short, ok=short == 0, fatal=False,
                 note=f"damage_events_incomplete: {short} HP ({rebuilt} HP in rebuilt hits that name no attacker)"
                 if short else "")], short


def round_duration_s(rounds: pd.DataFrame, rate: float) -> pd.Series:
    """Freeze end to round end in seconds; a round recorded already live has no freeze end and is timed
    from its start."""
    return (rounds.end_tick - rounds.freeze_end_tick.fillna(rounds.start_tick)) / rate


def buy_type(round_no: int, team_equip: float, max_rounds: int) -> str:
    # Thresholds are a convention chosen here, not fitted to data; the raw team
    # equipment value sits next to this label so analysis can reclassify.
    half = max_rounds // 2 if max_rounds else 12
    if round_no in (1, half + 1):
        return "pistol"
    if team_equip < 5000:
        return "eco"
    if team_equip < 10000:
        return "semi_eco"
    if team_equip < 20000:
        return "semi_buy"
    return "full"


# ---------------------------------------------------------------------------
# demoparser2 stage
# ---------------------------------------------------------------------------

def _events(parser, names, props):
    if not names:
        return {}
    out = parser.parse_events(list(names), player=props, other=["total_rounds_played"])
    return {n: df for n, df in out}


def _state_block(df: pd.DataFrame, src: str, dst: str) -> dict[str, pd.Series]:
    """Copy one participant's event-tick state (demoparser2 reports it pre-event) with a short prefix."""
    g = lambda c: col(df, f"{src}_{c}")
    inv = g("inventory")
    prim = [most_expensive(v if isinstance(v, (list, np.ndarray)) else [], PRIMARY_WEAPONS) for v in inv]
    sec = [most_expensive(v if isinstance(v, (list, np.ndarray)) else [], SECONDARY_WEAPONS) for v in inv]
    invval = [inventory_value(v) if isinstance(v, (list, np.ndarray)) else None for v in inv]
    return {
        f"{dst}_side": g("team_num").map(SIDE),
        f"{dst}_x": g("X"), f"{dst}_y": g("Y"), f"{dst}_z": g("Z"),
        f"{dst}_pitch": g("pitch"), f"{dst}_yaw": g("yaw"),
        f"{dst}_health": g("health"), f"{dst}_armor": g("armor_value"), f"{dst}_helmet": g("has_helmet"),
        f"{dst}_active_weapon": g("active_weapon_name"),
        f"{dst}_best_primary": [p[0] for p in prim], f"{dst}_best_primary_price": [p[1] for p in prim],
        f"{dst}_best_secondary": [s[0] for s in sec], f"{dst}_best_secondary_price": [s[1] for s in sec],
        f"{dst}_inventory_value": invval, f"{dst}_equip_value_game": g("current_equip_value"),
        f"{dst}_money": g("balance"), f"{dst}_place": g("last_place_name"),
        f"{dst}_flash_duration": g("flash_duration"), f"{dst}_scoped": g("is_scoped"),
        f"{dst}_ducking": g("ducking"), f"{dst}_airborne": g("is_airborne"), f"{dst}_walking": g("is_walking"),
    }


def _trade_flags(kills: pd.DataFrame, tick_rate: float, window_s: float):
    """trade_kill: the victim had killed one of the attacker's teammates within the window.
    traded_death: the killer of this victim died to the victim's teammate within the window."""
    w = window_s * tick_rate
    trade_kill = np.zeros(len(kills), dtype=bool)
    traded = np.zeros(len(kills), dtype=bool)
    k = kills.reset_index(drop=True)
    for _, grp in k.groupby("round"):
        rows = list(grp.itertuples())
        for i, cur in enumerate(rows):
            if cur.is_teamkill or cur.is_suicide or pd.isna(cur.attacker_steamid):
                continue
            for prev in rows[:i]:
                if pd.isna(prev.attacker_steamid):  # a world or bomb death has no killer to trade
                    continue
                if (cur.tick - prev.tick <= w and prev.attacker_steamid == cur.victim_steamid
                        and not prev.is_teamkill and prev.victim_side == cur.attacker_side):
                    trade_kill[cur.Index] = True
                    traded[prev.Index] = True
    return trade_kill, traded


# demoparser2 projectile classes, named as awpy names them.
PROJECTILE_TYPES = {"CSmokeGrenadeProjectile": "smoke", "CFlashbangProjectile": "flashbang",
                    "CHEGrenadeProjectile": "he", "CMolotovProjectile": "molotov", "CDecoyProjectile": "decoy"}
THROW_TYPES = {"flashbang": {"flashbang"}, "hegrenade": {"he"}, "smokegrenade": {"smoke"},
               "molotov": {"molotov", "incendiary"}, "incgrenade": {"molotov", "incendiary"},
               "decoy": {"decoy"}}


def link_throws(throws: pd.DataFrame, proj: pd.DataFrame, rate: float):
    """Match each grenade_thrown event to a projectile of the same type that appears within 0.5 s,
    choosing the one whose first position is nearest the thrower's eye. Each projectile is used once."""
    used: set[int] = set()
    ids, dists = [], []
    ps = proj.sort_values("first_tick")
    for t_, w, x, y, z in zip(throws.tick, throws.weapon, throws.x, throws.y, throws.z):
        types = THROW_TYPES.get(str(w), set())
        c = ps[(ps.first_tick >= t_) & (ps.first_tick <= t_ + rate / 2) & ps.type.isin(types)
               & ~ps.projectile.isin(used)]
        if c.empty or pd.isna(x):
            ids.append(None)
            dists.append(None)
            continue
        d = np.sqrt((c.start_x - x) ** 2 + (c.start_y - y) ** 2 + (c.start_z - (z + EYE_STANDING)) ** 2)
        i = int(np.argmin(d.to_numpy()))
        ids.append(int(c.projectile.iloc[i]))
        dists.append(float(d.iloc[i]))
        used.add(ids[-1])
    return pd.array(ids, dtype="Int32"), pd.array(dists, dtype="Float32")


def stage_demoparser2(ctx: Context) -> dict[str, pd.DataFrame]:
    from demoparser2 import DemoParser

    parser = DemoParser(str(ctx.dem))
    T: dict[str, pd.DataFrame] = {}
    with Timer(ctx, "dp_header"):
        header = parser.parse_header()
        present = set(parser.list_game_events())
        ah = ctx.info["awpy_header"]
    rate = ctx.tick_rate

    heavy = ["player_death", "player_hurt", "weapon_fire", "grenade_thrown", "bomb_planted", "bomb_defused",
             "bomb_beginplant", "bomb_begindefuse"]
    with Timer(ctx, "dp_events"):
        E = _events(parser, [e for e in heavy if e in present], STATE_PROPS)
        light = (present | set(SYNTH_EVENTS)) - set(heavy) - NOISE_EVENTS - {"player_blind"}
        E.update(_events(parser, sorted(light), LIGHT_PROPS))
        cvars = {}
        if "server_cvar" in present:
            sc = parser.parse_event("server_cvar")
            for r in sc.itertuples():
                cvars[str(r.name)] = str(r.value)
    empty = pd.DataFrame({"tick": pd.Series([], dtype="int64")})
    ev = lambda n: E.get(n, empty).copy()

    # ----- rounds
    with Timer(ctx, "dp_rounds"):
        bnm, re_all = ev("begin_new_match"), ev("round_end")
        real_ticks = re_all.tick[real_round_ends(re_all)] if len(re_all) else re_all.tick
        match_start = match_start_tick([int(t) for t in bnm.tick], [int(t) for t in real_ticks])
        rounds, voided = build_round_windows(ev("round_start").tick, ev("round_freeze_end").tick, re_all,
                                             match_start)
        if rounds.empty:
            raise RuntimeError("no round_end events after match start")
        if ctx.truncated:
            # Without awpy's playback header, measure the tick rate from game time across the match.
            fe_t = sorted(int(t) for t in ev("round_freeze_end").tick if t >= match_start)
            gt = parser.parse_ticks(["game_time"], ticks=[fe_t[0], fe_t[-1]]).drop_duplicates("tick") \
                .set_index("tick").game_time
            rate = ctx.tick_rate = round((fe_t[-1] - fe_t[0]) / float(gt[fe_t[-1]] - gt[fe_t[0]]), 3)
        # A winnerless round end does not always roll stats back. The game's counters decide: if kills plus
        # deaths are the same just after the restore as at the attempt's start, the attempt was rolled back
        # and stays voided; otherwise its events count, and it becomes a round with aborted = true and no
        # winner (one pro demo: a world suicide at 78957 inside the 78153-97787 attempt raised
        # deaths_total 7 -> 8 and stayed counted, while the 45420-57646 attempt rolled back).
        settle = restore_settle_ticks(rate)
        counters = parser.parse_ticks(["kills_total", "deaths_total"],
                                      ticks=sorted({t for a_, b_ in voided for t in (a_, b_ + settle)}))
        total_at = (counters.kills_total + counters.deaths_total).groupby(counters.tick).sum()
        rolled_back, aborted = split_restores(voided, total_at.to_dict(), rate)
        if aborted:
            fe_all = np.sort(ev("round_freeze_end").tick.to_numpy())
            extra = []
            for a_, b_ in aborted:
                fe_in = fe_all[(fe_all >= a_) & (fe_all <= b_)]
                extra.append(dict(start_tick=a_, freeze_end_tick=int(fe_in.max()) if len(fe_in) else None,
                                  end_tick=b_, started_live=False, winner_side=None, reason="aborted",
                                  voided_attempts=0, aborted=True))
            rounds = pd.concat([rounds.assign(aborted=False), pd.DataFrame(extra)], ignore_index=True) \
                .sort_values("start_tick", kind="stable").reset_index(drop=True)
            rounds["round"] = np.arange(1, len(rounds) + 1)
        else:
            rounds["aborted"] = False
        # The restore tick itself is voided either way: every player dies to "world" on it, and the game
        # never counts those deaths (deaths_total unchanged across 97787 on that demo).
        voided = rolled_back + [(b_, b_) for _, b_ in aborted]
        off = ev("round_officially_ended")
        offt = np.sort(off.tick.to_numpy()) if len(off) else np.array([], dtype=np.int64)
        rounds["official_end_tick"] = [int(offt[offt >= e].min()) if (offt >= e).any() else None
                                       for e in rounds.end_tick]
        max_rounds = int(cvars.get("mp_maxrounds", 24) or 24)
        if ctx.truncated:
            # Keep rounds up to the last complete one: its stats are committed on the next round start,
            # so a last round with no later start in the demo is dropped.
            rs_ticks = ev("round_start").tick
            if not (rs_ticks > rounds.end_tick.iloc[-1]).any():
                rounds = rounds.iloc[:-1].reset_index(drop=True)
            if rounds.empty:
                raise RuntimeError(f"{TRUNCATED}: no complete round before the cut")

    # The final scoreboard is read at game over: the win panel. A demo without one (the first part of a
    # split recording, or a recording that stops) is read at the next round start after its last round,
    # the tick on which the game commits that round's damage (a split recording's first part: 1123 at 133340,
    # 1246 at the 133341 round start); with no later start, the tick after the last round end.
    win = ev("cs_win_panel_match")
    last_end = int(rounds.end_tick.max())
    later = [int(t) for t in ev("round_start").tick if t > last_end]
    final_tick = int(win.tick.max()) if len(win) else (min(later) if later else last_end + 1)

    def stamp(df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            df["round"] = pd.Series([], dtype="int16")
            return df
        df["round"] = assign_rounds(df.tick, rounds, voided, final_tick)
        return df

    # ----- tick samples: positions (4 Hz), freeze ends, final tick
    last_tick = int(ah.get("playback_ticks") or 0)
    with Timer(ctx, "dp_ticks"):
        first = int(rounds.start_tick.min())
        end_tick = max(last_tick, int(rounds.end_tick.max()))
        sample = sample_grid(first, end_tick)
        fe_ticks = [int(t) for t in rounds.freeze_end_tick.dropna()]
        # Side-to-team snapshot per round: freeze end, or one tick before the end for a round without one.
        rounds["team_tick"] = [int(f) if not pd.isna(f) else int(e) - 1
                               for f, e in zip(rounds.freeze_end_tick, rounds.end_tick)]
        pos = parser.parse_ticks(POSITION_PROPS, ticks=sample)
        econ_raw = parser.parse_ticks(ECON_PROPS, ticks=sorted(set(fe_ticks) | set(rounds.team_tick)))
        sb = parser.parse_ticks(SCOREBOARD_PROPS, ticks=[final_tick])
        if sb.empty:
            sb = parser.parse_ticks(SCOREBOARD_PROPS, ticks=[final_tick - 1])
        # Team scores are read one tick after the last round's end, where they already include it. The
        # final tick can be the next round's start, which at halftime swaps team names and scores
        # (seen on a demo cut at round 13).
        score_at = parser.parse_ticks(["team_rounds_total", "team_clan_name", "team_num"], ticks=[last_end + 1])
        # The game's damage counter at each round boundary (see game_damage below).
        starts = [int(t) for t in rounds.start_tick]
        # A round's damage is committed on the next round's start tick (the last round's by the final tick).
        boundary = starts[1:] + [final_tick]
        dmg_counter = parser.parse_ticks(["damage_total"], ticks=sorted(set(boundary)))
        # Counters before the first counted round: zero for a whole match; the earlier parts' totals for a later
        # part of a split recording (one demo's second part starts at 8-8 with kills and damage carried over).
        # Read at round 1's freeze end: no kill happens in freeze time and damage commits between rounds.
        fe1 = rounds.freeze_end_tick.iloc[0]
        base = parser.parse_ticks(BASELINE_PROPS, ticks=[int(fe1)]) if not pd.isna(fe1) else pd.DataFrame(
            columns=["steamid", "name"] + BASELINE_PROPS)
    # Bots have no SteamID (demoparser2 reports 0); they are keyed by bot_id(user_id, name).
    raw_bots = pos[(pos.steamid == 0) & pos.name.notna() & pos.team_num.isin([2, 3])]
    bots = {str(n): bot_id(u, str(n)) for n, u in raw_bots.groupby("name").user_id.first().items()}

    def pid(df: pd.DataFrame, prefix: str) -> pd.Series:
        """Player ids for an event participant (prefix user / attacker / assister, or "" for bare columns)."""
        p_ = f"{prefix}_" if prefix else ""
        return resolve_ids(col(df, f"{p_}steamid"), col(df, f"{p_}name"), bots)

    for df in (pos, econ_raw, sb, dmg_counter, base, score_at):
        df["steamid"] = resolve_ids(df.steamid, df.name, bots)
    # Teams are named by clan name. When the server set no distinct clan names (one pro
    # demo: both empty, so the two teams merged into one with 13 wins), each player is named instead by the
    # side his team started on, read from round 1's side snapshot.
    r1 = econ_raw[(econ_raw.tick == int(rounds.team_tick.iloc[0])) & econ_raw.team_num.isin([2, 3])]
    clan = r1.groupby("team_num").team_clan_name.agg(lambda n: n.mode().iat[0] if len(n.mode()) else "")
    if not (len(clan) == 2 and all(str(n).strip() for n in clan) and clan.iloc[0] != clan.iloc[1]):
        start_side = {int(s_): ("ct_start" if t_ == 3 else "t_start") for s_, t_ in zip(r1.steamid, r1.team_num)
                      if not pd.isna(s_)}
        for df in (econ_raw, sb, score_at):
            df["team_clan_name"] = [start_side.get(int(s_)) if not pd.isna(s_) else None for s_ in df.steamid]
    if ctx.velocity is None:  # truncated demo: demoparser2's position-differenced velocity instead
        v = parser.parse_ticks(["velocity_X", "velocity_Y", "velocity_Z"])
        ctx.velocity = pd.DataFrame({"tick": v.tick.astype("int32"), "steamid": v.steamid, "name": v.name,
                                     "vel_x": v.velocity_X.astype("float32"), "vel_y": v.velocity_Y.astype("float32"),
                                     "vel_z": v.velocity_Z.astype("float32")})
    vel = ctx.velocity
    vel["steamid"] = resolve_ids(vel.steamid, vel.pop("name"), bots)
    ctx.velocity = vel[vel.steamid.notna()]

    # ----- teams per side per round
    team_rows = econ_raw[econ_raw.team_num.isin([2, 3])]
    side_team = (team_rows.groupby(["tick", "team_num"]).team_clan_name
                 .agg(lambda s: s.mode().iat[0] if len(s.mode()) else None).unstack())
    # player_rounds is read at each round's freeze end, or, for a round recorded already live (no freeze end),
    # at the tick before its end. Without that row round 1's game damage vanished from the totals on live
    # recordings (one pro demo: 11 HP short, the player's round 1 hits).
    fe_to_round = {int(t): r for t, r in zip(rounds.team_tick, rounds["round"])}
    rounds["ct_team"] = [side_team.loc[t, 3] if t in side_team.index else None for t in rounds.team_tick]
    rounds["t_team"] = [side_team.loc[t, 2] if t in side_team.index else None for t in rounds.team_tick]
    rounds = rounds.drop(columns=["team_tick"])
    rounds["winner_team"] = np.where(rounds.winner_side == "CT", rounds.ct_team,
                                     np.where(rounds.winner_side == "T", rounds.t_team, None))
    teams = [t for t in pd.unique(pd.concat([rounds.ct_team, rounds.t_team]).dropna())]
    score = {t: 0 for t in teams}
    ct_after, t_after = [], []
    for r in rounds.itertuples():
        if r.winner_team in score:
            score[r.winner_team] += 1
        ct_after.append(score.get(r.ct_team))
        t_after.append(score.get(r.t_team))
    rounds["ct_team_score_after"] = ct_after
    rounds["t_team_score_after"] = t_after
    rounds["duration_s"] = round_duration_s(rounds, rate)

    # ----- scoreboard (final tick)
    sb = sb[sb.team_num.isin([2, 3]) & sb.steamid.notna()].copy()
    sb["side"] = sb.team_num.map(SIDE)
    at_start = base.dropna(subset=["steamid"]).drop_duplicates("steamid").set_index("steamid")
    for c in BASELINE_PROPS:
        sb[f"{c}_at_start"] = [int(at_start[c].get(s_, 0)) if s_ in at_start.index and not pd.isna(at_start[c].get(s_))
                               else 0 for s_ in sb.steamid]
    # What this recording itself contains: the final counters minus those at its start.
    sb_part = sb.copy()
    for c in BASELINE_PROPS:
        sb_part[c] = sb[c] - sb[f"{c}_at_start"]
    score_at = score_at[score_at.team_num.isin([2, 3])]
    at_start_score = {str(t): int(g.team_rounds_total_at_start.max()) for t, g in sb.groupby("team_clan_name")}
    final_score = {str(t): int(g.team_rounds_total.max()) - at_start_score.get(str(t), 0)
                   for t, g in score_at.groupby("team_clan_name")}
    T["scoreboard"] = sb.drop(columns=["team_num"])

    # ----- economy at freeze end
    econ = econ_raw[econ_raw.team_num.isin([2, 3]) & econ_raw.steamid.notna()
                    & econ_raw.tick.isin(fe_to_round)].copy()
    econ["round"] = econ.tick.map(fe_to_round).astype("int16")
    econ["side"] = econ.team_num.map(SIDE)
    econ["inventory_value"] = [inventory_value(v) for v in econ.inventory]
    bp = [most_expensive(v, PRIMARY_WEAPONS) for v in econ.inventory]
    bs = [most_expensive(v, SECONDARY_WEAPONS) for v in econ.inventory]
    econ["best_primary"], econ["best_primary_price"] = [x[0] for x in bp], [x[1] for x in bp]
    econ["best_secondary"], econ["best_secondary_price"] = [x[0] for x in bs], [x[1] for x in bs]
    econ["money_start"] = econ.balance + econ.cash_spent_this_round
    econ = econ.rename(columns={"balance": "money", "cash_spent_this_round": "cash_spent",
                                "current_equip_value": "equip_value_game", "armor_value": "armor",
                                "has_helmet": "helmet", "has_defuser": "defuser"})
    player_rounds = econ.drop(columns=["team_num", "team_clan_name"])
    team_eq = econ.groupby(["round", "side"]).equip_value_game.sum().unstack()
    for s in ("CT", "T"):
        rounds[f"{s.lower()}_equip_value"] = rounds["round"].map(team_eq[s] if s in team_eq else {})
        rounds[f"{s.lower()}_buy_type"] = [buy_type(int(r), v, max_rounds) if not pd.isna(v) else None
                                           for r, v in zip(rounds["round"], rounds[f"{s.lower()}_equip_value"])]
    teams_money = econ.groupby(["round", "side"]).money_start.sum().unstack()
    for s in ("CT", "T"):
        rounds[f"{s.lower()}_money_start"] = rounds["round"].map(teams_money[s] if s in teams_money else {})

    # ----- purchases
    ip = stamp(ev("item_purchase"))
    purchases = pd.DataFrame({
        "tick": ip.tick, "round": ip["round"], "steamid": pid(ip, ""),
        "item": col(ip, "item_name"), "cost": col(ip, "cost"), "was_sold": col(ip, "was_sold"),
        "inventory_slot": col(ip, "inventory_slot"), "side": col(ip, "user_team_num").map(SIDE),
        "x": col(ip, "user_X"), "y": col(ip, "user_Y"), "z": col(ip, "user_Z"),
    })
    purchases = purchases[purchases["round"] > 0]
    price_errors = sorted({e for e in (check_purchase_cost(i, int(c)) for i, c in zip(purchases.item, purchases.cost))
                           if e})
    if price_errors:
        raise UnknownItemPrice("; ".join(price_errors))
    T["purchases"] = purchases

    # ----- bomb
    bomb_parts = []
    for name in ("bomb_planted", "bomb_defused", "bomb_exploded", "bomb_dropped", "bomb_pickup",
                 "bomb_beginplant", "bomb_begindefuse", "bomb_abortplant", "bomb_abortdefuse"):
        b = ev(name)
        if b.empty:
            continue
        bomb_parts.append(pd.DataFrame({
            "tick": b.tick, "event": name.removeprefix("bomb_"), "steamid": pid(b, "user"),
            "site_entity": col(b, "site"), "zone": col(b, "user_which_bomb_zone"),
            "place": col(b, "user_last_place_name"),
            "x": col(b, "user_X"), "y": col(b, "user_Y"), "z": col(b, "user_Z"),
        }))
    bomb = stamp(pd.concat(bomb_parts, ignore_index=True).sort_values("tick")) if bomb_parts else stamp(
        pd.DataFrame(columns=["tick", "event", "steamid", "site_entity", "zone", "place", "x", "y", "z"]))
    bomb = bomb[bomb["round"] > 0]
    # Plant site letter from the planter's m_nWhichBombZone (1=A, 2=B); on the Nuke test demo it
    # agrees with the planter's place name (BombsiteA/BombsiteB) for all 15 plants.
    bomb["site"] = bomb.zone.map({1: "A", 2: "B"})
    T["bomb"] = bomb

    def first_per_round(evname, colname):
        b = bomb[bomb.event == evname].groupby("round").first()
        return rounds["round"].map(b[colname]) if colname in b else pd.Series(None, index=rounds.index)

    rounds["plant_tick"] = first_per_round("planted", "tick")
    rounds["plant_site"] = first_per_round("planted", "site")
    rounds["planter_steamid"] = first_per_round("planted", "steamid")
    rounds["defuse_tick"] = first_per_round("defused", "tick")
    rounds["defuser_steamid"] = first_per_round("defused", "steamid")
    rounds["explode_tick"] = first_per_round("exploded", "tick")
    T["rounds"] = rounds

    r_fe = dict(zip(rounds["round"], rounds.freeze_end_tick))
    r_plant = dict(zip(rounds["round"], rounds.plant_tick))

    def since(df):
        fe_ = df["round"].map(r_fe).astype("float64")
        pl_ = df["round"].map(r_plant).astype("float64")
        s_plant = (df.tick - pl_) / rate
        return (df.tick - fe_) / rate, s_plant.where(df.tick >= pl_)

    # ----- kills
    with Timer(ctx, "dp_kills"):
        k = stamp(ev("player_death"))
        k = k[k["round"] > 0].reset_index(drop=True)
        kills = pd.DataFrame({"tick": k.tick, "round": k["round"]})
        kills["s_since_freeze_end"], kills["s_since_plant"] = since(kills)
        kills["attacker_steamid"] = pid(k, "attacker")
        kills["victim_steamid"] = pid(k, "user")
        kills["assister_steamid"] = pid(k, "assister")
        kills["assister_side"] = col(k, "assister_team_num").map(SIDE)
        for c in ("assistedflash", "weapon", "headshot", "penetrated", "thrusmoke", "attackerblind", "noscope",
                  "attackerinair", "distance", "dmg_health", "dmg_armor", "hitgroup"):
            kills[c] = col(k, c)
        kills = pd.concat([kills, pd.DataFrame(_state_block(k, "attacker", "a")),
                           pd.DataFrame(_state_block(k, "user", "v"))], axis=1)
        kills["is_suicide"] = (kills.attacker_steamid == kills.victim_steamid).fillna(False).astype(bool)
        kills["is_teamkill"] = ((kills.a_side == kills.v_side) & ~kills.is_suicide
                                & kills.attacker_steamid.notna()).astype(bool)
        tk_, td_ = _trade_flags(kills.rename(columns={"v_side": "victim_side", "a_side": "attacker_side"}),
                                rate, TRADE_WINDOW_S)
        kills["trade_kill_5s"], kills["traded_death_5s"] = tk_, td_
        T["kills"] = kills
        died = set(zip(kills["round"].astype(int), kills.victim_steamid.astype("Int64")))
        player_rounds["survived"] = [(int(r), int(s)) not in died
                                     for r, s in zip(player_rounds["round"], player_rounds.steamid)]
        rise = game_damage_by_round(dmg_counter, list(rounds["round"]), boundary,
                                    dict(zip(sb.steamid, sb.damage_total_at_start)))
        player_rounds["game_damage"] = pd.array([rise.get((int(r), int(s_))) for r, s_ in
                                                 zip(player_rounds["round"], player_rounds.steamid)], dtype="Int32")
        T["player_rounds"] = player_rounds

    # ----- damages
    with Timer(ctx, "dp_damages"):
        h = stamp(ev("player_hurt"))
        h = h[h["round"] > 0].reset_index(drop=True)
        dmg = pd.DataFrame({"tick": h.tick, "round": h["round"],
                            "attacker_steamid": pid(h, "attacker"),
                            "victim_steamid": pid(h, "user"),
                            "weapon": col(h, "weapon"), "dmg_health": col(h, "dmg_health"),
                            "dmg_armor": col(h, "dmg_armor"), "hitgroup": col(h, "hitgroup"),
                            "health_after": col(h, "health"), "armor_after": col(h, "armor")})
        # Pre-event health is the victim's state at the event tick; hits in the same tick chain.
        hp_b, ar_b, prev = [], [], {}
        for i, (vic, t, hp0, ar0, hp1, ar1) in enumerate(zip(dmg.victim_steamid, dmg.tick, col(h, "user_health"),
                                                              col(h, "user_armor_value"), dmg.health_after,
                                                              dmg.armor_after)):
            key = (vic, t)
            b_hp, b_ar = prev.get(key, (hp0, ar0))
            hp_b.append(b_hp)
            ar_b.append(b_ar)
            prev[key] = (hp1, ar1)
        dmg["health_before"] = pd.to_numeric(pd.Series(hp_b, index=dmg.index)).astype("Int32")
        dmg["armor_before"] = pd.to_numeric(pd.Series(ar_b, index=dmg.index)).astype("Int32")
        dmg["dmg_health_capped"] = (dmg.health_before - dmg.health_after).clip(lower=0)
        dmg["dmg_armor_capped"] = (dmg.armor_before - dmg.armor_after).clip(lower=0)
        a_side, v_side = col(h, "attacker_team_num"), col(h, "user_team_num")
        dmg["is_self"] = (dmg.attacker_steamid == dmg.victim_steamid).fillna(False).astype(bool)
        dmg["is_team_damage"] = ((a_side == v_side) & dmg.attacker_steamid.notna()).astype(bool)
        for p_, src in (("a", "attacker"), ("v", "user")):
            dmg[f"{p_}_side"] = col(h, f"{src}_team_num").map(SIDE)
            for c, s in (("x", "X"), ("y", "Y"), ("z", "Z")):
                dmg[f"{p_}_{c}"] = col(h, f"{src}_{s}")
            dmg[f"{p_}_place"] = col(h, f"{src}_last_place_name")
        dmg["distance"] = np.sqrt((dmg.a_x - dmg.v_x) ** 2 + (dmg.a_y - dmg.v_y) ** 2 + (dmg.a_z - dmg.v_z) ** 2)
        dmg["source"] = "event"

    # ----- grenades
    with Timer(ctx, "dp_grenades"):
        # Trajectories come from awpy: demoparser2's parse_grenades() also returns every grenade held in an
        # inventory (5.6M rows, 2.5 GB peak on the Dust2 test demo). awpy's table is thrown projectiles only,
        # and its endpoints match demoparser2's detonation positions within 0.03 units on the Nuke test
        # demo, but its thrower columns are null, so throws are linked to projectiles below.
        if ctx.truncated:  # no awpy: demoparser2's projectile rows (it also returns held grenades)
            gr = parser.parse_grenades()
            gr = gr[gr.grenade_type.isin(PROJECTILE_TYPES)].dropna(subset=["x"])
            g = pd.DataFrame({"tick": gr.tick, "entity_id": gr.grenade_entity_id, "entity_serial": 0,
                              "type": gr.grenade_type.map(PROJECTILE_TYPES), "x": gr.x, "y": gr.y, "z": gr.z}) \
                .sort_values(["entity_id", "entity_serial", "tick"]).reset_index(drop=True)
            del gr
        else:
            g = (ctx.tables["awpy"]["grenades"].select(["tick", "entity_id", "entity_serial", "type", "x", "y", "z"])
                 .sort(["entity_id", "entity_serial", "tick"]).to_pandas())
        key = ["entity_id", "entity_serial"]
        newp = ((g[key] != g[key].shift()).any(axis=1)) | (g.tick - g.tick.shift() > 1)
        g["projectile"] = newp.cumsum().astype("int32")
        proj = g.groupby("projectile").agg(entity_id=("entity_id", "first"), type=("type", "first"),
                                           first_tick=("tick", "min"), last_tick=("tick", "max"),
                                           start_x=("x", "first"), start_y=("y", "first"), start_z=("z", "first"),
                                           end_x=("x", "last"), end_y=("y", "last"),
                                           end_z=("z", "last")).reset_index()

        thr = stamp(ev("grenade_thrown"))
        thr = thr[thr["round"] > 0].reset_index(drop=True)
        throws = pd.DataFrame({"tick": thr.tick, "round": thr["round"],
                               "steamid": pid(thr, "user"), "weapon": col(thr, "weapon"),
                               "side": col(thr, "user_team_num").map(SIDE), "place": col(thr, "user_last_place_name"),
                               "x": col(thr, "user_X"), "y": col(thr, "user_Y"), "z": col(thr, "user_Z"),
                               "pitch": col(thr, "user_pitch"), "yaw": col(thr, "user_yaw")})
        throws["projectile"], throws["link_distance"] = link_throws(throws, proj, rate)
        pmap = proj.set_index("projectile")
        lk = throws.projectile.dropna().astype(int)
        for cname, src in (("entity_id", "entity_id"), ("land_tick", "last_tick"), ("land_x", "end_x"),
                           ("land_y", "end_y"), ("land_z", "end_z")):
            throws[cname] = lk.map(pmap[src]).reindex(throws.index)
        thrower = dict(zip(lk, throws.loc[lk.index, "steamid"]))
        # Plain lookup: Series.map would turn missing keys into NaN and the u64 steamids into float64.
        thrower_of = lambda ps: to_u64(pd.Series([thrower.get(int(x)) for x in ps], index=ps.index, dtype=object))
        proj["steamid"] = thrower_of(proj.projectile)
        moved = (g[["x", "y", "z"]].diff().abs().sum(axis=1) > 0) | newp
        paths = g[moved | (g.projectile != g.projectile.shift(-1))]
        T["grenade_paths"] = stamp(pd.DataFrame({
            "projectile": paths.projectile, "entity_id": paths.entity_id, "type": paths.type,
            "steamid": thrower_of(paths.projectile),
            "tick": paths.tick, "x": paths.x, "y": paths.y, "z": paths.z}))
        ctx.info["grenade_link"] = dict(throws=len(throws), linked=int(throws.projectile.notna().sum()),
                                        projectiles=len(proj))
        throws["flight_s"] = (throws.land_tick.astype("float64") - throws.tick) / rate
        T["grenade_throws"] = throws

        gev = []
        for name, label in (("hegrenade_detonate", "he_detonate"), ("flashbang_detonate", "flash_detonate"),
                            ("smokegrenade_detonate", "smoke_detonate"), ("smokegrenade_expired", "smoke_expired"),
                            ("inferno_startburn", "inferno_start"), ("inferno_expire", "inferno_expire"),
                            ("inferno_extinguish", "inferno_extinguish"), ("decoy_started", "decoy_start"),
                            ("decoy_detonate", "decoy_detonate"), ("molotov_detonate", "molotov_detonate")):
            d_ = ev(name)
            if d_.empty:
                continue
            gev.append(pd.DataFrame({"tick": d_.tick, "event": label, "entity_id": col(d_, "entityid"),
                                     "steamid": pid(d_, "user"),
                                     "x": col(d_, "x"), "y": col(d_, "y"), "z": col(d_, "z")}))
        gev = stamp(pd.concat(gev, ignore_index=True).sort_values("tick")) if gev else stamp(
            pd.DataFrame(columns=["tick", "event", "entity_id", "steamid", "x", "y", "z"]))
        gev = gev[gev["round"] > 0]
        T["grenade_events"] = gev

        def lifetimes(start_ev, end_evs):
            s = gev[gev.event == start_ev].sort_values("tick")
            e = gev[gev.event.isin(end_evs)].sort_values("tick")
            out = []
            for r in s.itertuples():
                m = e[(e.entity_id == r.entity_id) & (e.tick >= r.tick)]
                end = int(m.tick.iloc[0]) if len(m) else None
                out.append(dict(entity_id=r.entity_id, steamid=r.steamid, round=r.round, start_tick=r.tick,
                                end_tick=end, duration_s=None if end is None else (end - r.tick) / rate,
                                x=r.x, y=r.y, z=r.z))
            return pd.DataFrame(out, columns=["entity_id", "steamid", "round", "start_tick", "end_tick",
                                              "duration_s", "x", "y", "z"])

        T["smokes"] = lifetimes("smoke_detonate", ["smoke_expired"])
        infernos = lifetimes("inferno_start", ["inferno_expire", "inferno_extinguish"])
        T["infernos"] = infernos

        # Link utility damage to its grenade: HE to the attacker's detonation on that tick,
        # fire to the attacker's inferno burning at that tick, impacts to the projectile in flight.
        he = gev[gev.event == "he_detonate"]
        link_ent, link_kind = [], []
        for t_, sid, w in zip(dmg.tick, dmg.attacker_steamid, dmg.weapon):
            ent, kind = None, None
            if w == "hegrenade":
                m = he[(he.steamid == sid) & (he.tick <= t_) & (he.tick >= t_ - 2)]
                if len(m):
                    ent, kind = m.entity_id.iloc[-1], "he"
            elif w == "inferno":
                m = infernos[(infernos.steamid == sid) & (infernos.start_tick <= t_)
                             & ((infernos.end_tick.isna()) | (infernos.end_tick >= t_))]
                if len(m):
                    ent, kind = m.entity_id.iloc[-1], "inferno"
            elif w in ("molotov", "incgrenade", "smokegrenade", "flashbang", "decoy", "hegrenade_impact"):
                m = proj[(proj.steamid == sid) & (proj.first_tick <= t_) & (proj.last_tick >= t_ - 1)]
                if len(m):
                    ent, kind = m.entity_id.iloc[-1], "impact"
            link_ent.append(ent)
            link_kind.append(kind)
        dmg["grenade_entity_id"] = pd.array(link_ent, dtype="Int32")
        dmg["grenade_link"] = link_kind
        T["damages"] = dmg

    # ----- every-tick pass: blinds, spotted changes, and every player's state for the engagements
    with Timer(ctx, "dp_all_ticks"):
        fd = gev[gev.event == "flash_detonate"]
        # Spotted-by sets become bitmasks (one bit per steamid) so change detection is vectorized.
        steam_bit: dict[int, int] = {}
        blind_parts, spot_parts, state_parts, drop_parts = [], [], [], []
        carry = None  # last row per player from the previous chunk
        for c0 in range(first, end_tick + 1, ALL_TICK_CHUNK):
            tl = list(range(c0, min(c0 + ALL_TICK_CHUNK, end_tick + 1)))
            at = parser.parse_ticks(["flash_duration", "approximate_spotted_by", "team_num", "X", "Y", "Z",
                                     "pitch", "yaw", "duck_amount", "is_alive", "health"], ticks=tl)
            at = at.assign(steamid=resolve_ids(at.steamid, at.name, bots))
            at = at[at.team_num.isin([2, 3]) & at.steamid.notna()]
            at = at.assign(steamid=at.steamid.astype("uint64")).reset_index(drop=True)
            ex = at.approximate_spotted_by.explode().dropna()
            bit = np.fromiter((1 << steam_bit.setdefault(int(v), len(steam_bit)) for v in ex),
                              dtype=np.int64, count=len(ex))
            at["mask"] = pd.Series(bit, index=ex.index).groupby(level=0).sum().reindex(at.index, fill_value=0)
            state_parts.append(at[["tick", "steamid", "team_num", "is_alive", "X", "Y", "Z", "pitch", "yaw",
                                   "duck_amount", "mask"]].astype({"tick": "int32", "team_num": "int8"}))
            at = at.drop(columns=["approximate_spotted_by", "team_num", "name", "is_alive", "pitch", "yaw",
                                  "duck_amount"], errors="ignore")
            cur = pd.concat([carry, at], ignore_index=True) if carry is not None else at
            cur = cur.sort_values(["steamid", "tick"], kind="stable")
            grp = cur.groupby("steamid", sort=False)
            prev_f, prev_m, prev_h = grp.flash_duration.shift(), grp["mask"].shift(), grp.health.shift()
            fresh = ~cur.index.isin(range(len(carry))) if carry is not None else np.ones(len(cur), bool)
            # A blind is a new nonzero m_flFlashDuration; a player's first sample is not a blind.
            is_blind = fresh & (cur.flash_duration > 0) & prev_f.notna() & (cur.flash_duration != prev_f)
            is_spot = fresh & (prev_m.isna() | (cur["mask"] != prev_m))
            blind_parts.append(cur.loc[is_blind, ["tick", "steamid", "flash_duration", "X", "Y", "Z"]])
            hurt = fresh & prev_h.notna() & (cur.health < prev_h)
            drop_parts.append(pd.DataFrame({"tick": cur.tick[hurt], "steamid": cur.steamid[hurt],
                                            "health_before": prev_h[hurt], "health_after": cur.health[hurt]}))
            spot_parts.append(cur.loc[is_spot, ["tick", "steamid", "mask"]])
            carry = cur.groupby("steamid", sort=False).tail(1).reset_index(drop=True)
            del at, ex, cur, grp

        bit_owner = {b: sid for sid, b in steam_bit.items()}

        # Spotted as change events: one row each time a spotter starts or stops seeing a target.
        sp = pd.concat(spot_parts, ignore_index=True).sort_values(["steamid", "tick"], kind="stable")
        prev = sp.groupby("steamid", sort=False)["mask"].shift().fillna(0).astype("int64")
        rows = []
        for t_, target, m_, p_m in zip(sp.tick, sp.steamid, sp["mask"].astype("int64"), prev):
            changed = int(m_) ^ int(p_m)
            for b_ in range(changed.bit_length()):
                if changed >> b_ & 1:
                    rows.append((int(t_), int(target), bit_owner[b_], bool(int(m_) >> b_ & 1)))
        # demoparser2 names spotters by SteamID, so a bot spotter (SteamID 0) cannot be identified.
        sp = pd.DataFrame([r for r in rows if r[2]], columns=["tick", "target_steamid", "spotter_steamid", "spotted"])
        sp = sp.sort_values(["tick", "target_steamid", "spotter_steamid"], kind="stable").reset_index(drop=True)
        sp["target_steamid"] = to_u64(sp.target_steamid.astype("uint64"))
        sp["spotter_steamid"] = to_u64(sp.spotter_steamid.astype("uint64"))
        sp = stamp(sp)
        T["spotted"] = sp[sp["round"] > 0]
        bl_raw = pd.concat(blind_parts, ignore_index=True).sort_values(["tick", "steamid"], kind="stable")
        blinds = list(zip(bl_raw.tick, bl_raw.steamid.astype("int64").astype(object), bl_raw.flash_duration.astype(float),
                          bl_raw.X, bl_raw.Y, bl_raw.Z))

        side_of = {}
        for r in econ.itertuples():
            side_of[(int(r.round), int(r.steamid))] = r.side
        brow = []
        for t_, sid, dur, vx, vy, vz in blinds:
            c = fd[fd.tick == t_]
            amb = len(c) > 1
            if len(c) == 0:
                att, ent = None, None
            else:
                dist = np.sqrt((c.x - vx) ** 2 + (c.y - vy) ** 2 + (c.z - vz) ** 2)
                i = int(np.argmin(dist.to_numpy()))
                # Column access keeps the UInt64 steamid exact; a mixed-dtype row could upcast it to float.
                att, ent = c.steamid.iloc[i], c.entity_id.iloc[i]
                att = None if pd.isna(att) else int(att)
            brow.append(dict(tick=t_, attacker_steamid=att, victim_steamid=sid, duration=dur,
                             flash_entity_id=ent, ambiguous=amb, v_x=vx, v_y=vy, v_z=vz))
        bl = stamp(pd.DataFrame(brow, columns=["tick", "attacker_steamid", "victim_steamid", "duration",
                                               "flash_entity_id", "ambiguous", "v_x", "v_y", "v_z"]))
        # From the Python values, not the frame columns: a None attacker (no detonation on that tick)
        # would have made the frame column float64.
        bl["attacker_steamid"] = to_u64(pd.Series([r["attacker_steamid"] for r in brow], index=bl.index, dtype=object))
        bl["victim_steamid"] = to_u64(pd.Series([r["victim_steamid"] for r in brow], index=bl.index, dtype=object))
        a_s = [side_of.get((int(r), int(a))) if not pd.isna(a) else None for r, a in zip(bl["round"], bl.attacker_steamid)]
        v_s = [side_of.get((int(r), int(v))) for r, v in zip(bl["round"], bl.victim_steamid)]
        bl["is_self"] = (bl.attacker_steamid == bl.victim_steamid).fillna(False).astype(bool)
        bl["is_team_flash"] = pd.Series([a is not None and a == v for a, v in zip(a_s, v_s)], index=bl.index,
                                        dtype=bool) & ~bl.is_self
        T["blinds"] = bl[bl["round"] > 0]

    # ----- every player's state at every tick, and the map mesh checked against the kills
    S = player_state(pd.concat(state_parts, ignore_index=True))
    del state_parts
    checker, vis = checked_mesh(S, kills, ctx.mapdata, header.get("map_name"))

    # ----- hits the demo's event stream lost, rebuilt from networked health
    drops = stamp(pd.concat(drop_parts, ignore_index=True))
    dmg["reconstructed_ambiguous"] = False
    dmg = pd.concat([dmg, rebuild_lost_hits(drops, dmg, side_of)], ignore_index=True)
    # The concat can leave these as object columns of Python bools, where ~ is integer inversion (-2/-1),
    # not negation; every filter below relies on real booleans.
    dmg = dmg.astype({"is_self": bool, "is_team_damage": bool, "reconstructed_ambiguous": bool}) \
        .sort_values("tick", kind="stable").reset_index(drop=True)
    T["damages"] = dmg
    ctx.info["rebuilt_hits"] = int((dmg.source == "health").sum())

    # ----- shots
    with Timer(ctx, "dp_shots"):
        wf = stamp(ev("weapon_fire"))
        wf = wf[wf["round"] > 0].reset_index(drop=True)
        shots = pd.DataFrame({"tick": wf.tick, "round": wf["round"],
                              "steamid": pid(wf, "user"),
                              "weapon": col(wf, "weapon").str.removeprefix("weapon_"), "silenced": col(wf, "silenced")})
        for c, s in (("side", None), ("x", "X"), ("y", "Y"), ("z", "Z"), ("pitch", "pitch"), ("yaw", "yaw"),
                     ("ducking", "ducking"), ("ducked", "ducked"), ("duck_amount", "duck_amount"),
                     ("scoped", "is_scoped"), ("zoom_lvl", "zoom_lvl"), ("walking", "is_walking"),
                     ("airborne", "is_airborne"), ("shots_fired", "shots_fired"),
                     ("accuracy_penalty", "accuracy_penalty"),
                     ("velocity_modifier", "CCSPlayerPawn.m_flVelocityModifier"),
                     ("ammo_clip", "active_weapon_ammo"), ("flash_duration", "flash_duration"),
                     ("health", "health"), ("place", "last_place_name"), ("active_weapon", "active_weapon_name")):
            shots[c] = col(wf, "user_team_num").map(SIDE) if s is None else col(wf, f"user_{s}")
        fb = ev("fire_bullets")
        if not fb.empty:
            fb = fb.copy()
            fb["steamid"] = pid(fb, "user")
            fb["seq"] = fb.groupby(["steamid", "tick"]).cumcount()
            shots["seq"] = shots.groupby(["steamid", "tick"]).cumcount()
            bullets = fb[["tick", "steamid", "seq", "inaccuracy", "spread", "recoil_index", "origin_x", "origin_y",
                          "origin_z", "angles_x", "angles_y", "item_def_index", "num_bullets_remaining", "seed",
                          "player_inair"]].rename(columns={"origin_x": "eye_x", "origin_y": "eye_y",
                                                           "origin_z": "eye_z", "angles_x": "bullet_pitch",
                                                           "angles_y": "bullet_yaw", "player_inair": "bullet_inair"})
            # weapon_fire also fires for knives and grenades; only gun shots have a fire_bullets row.
            shots = shots.merge(bullets, on=["tick", "steamid", "seq"], how="left").drop(columns=["seq"])
            # The merge made these float64 (NaN for knife/grenade rows); restore exact integers, seeds included.
            for c in ("item_def_index", "num_bullets_remaining", "seed"):
                shots[c] = shots[c].astype("UInt32")
            shots["has_bullet_info"] = shots.inaccuracy.notna()

        # Networked velocity (m_vecVelocity), read by the awpy stage for every tick.
        sn = ctx.velocity
        shots = shots.merge(sn, on=["tick", "steamid"], how="left")
        shots["speed_2d"] = np.hypot(shots.vel_x, shots.vel_y)
        T["shots"] = shots

    # ----- engagement tables
    with Timer(ctx, "dp_engagements"):
        T["engagements"], T["engagement_ticks"] = engagement_tables(
            S, rounds, shots, dmg, kills, T["smokes"], steam_bit, ctx.velocity, checker, rate)
        del S
        ctx.info["visibility"] = vis

    # ----- positions (4 Hz)
    with Timer(ctx, "dp_positions"):
        p_ = pos[pos.team_num.isin([2, 3]) & pos.steamid.notna()].copy()
        p_["side"] = p_.team_num.map(SIDE)
        p_["spotted_by"] = [sorted(int(x) for x in v) if isinstance(v, (list, np.ndarray)) else [] for v in
                            p_.approximate_spotted_by]
        p_ = p_.drop(columns=["approximate_spotted_by", "team_num", "name"]).rename(columns={
            "X": "x", "Y": "y", "Z": "z", "armor_value": "armor", "has_helmet": "helmet",
            "active_weapon_name": "active_weapon", "last_place_name": "place", "balance": "money",
            "CCSPlayerPawn.m_flVelocityModifier": "velocity_modifier"})
        p_ = p_.merge(sn, on=["tick", "steamid"], how="left")
        p_ = stamp(p_)
        T["positions"] = p_[p_["round"] > 0]

    # ----- players
    names = pos.dropna(subset=["steamid"]).groupby("steamid").name.last()
    side_by_round = econ.pivot_table(index="steamid", columns="round", values="side", aggfunc="first")
    half = max_rounds // 2
    prows = []
    for sid, row in side_by_round.iterrows():
        def side_in(rng):
            v = [row.get(r) for r in rng if isinstance(row.get(r), str)]
            return max(set(v), key=v.count) if v else None
        n = len(rounds)
        ot = [side_in(range(a, min(a + 3, n + 1))) for a in range(max_rounds + 1, n + 1, 3)]
        clan = econ_raw[econ_raw.steamid == sid].team_clan_name.mode()
        prows.append(dict(steamid=sid, name=names.get(sid), is_bot=int(sid) < 2 ** 40,
                          team=clan.iat[0] if len(clan) else None,
                          side_h1=side_in(range(1, half + 1)), side_h2=side_in(range(half + 1, max_rounds + 1)),
                          side_ot=ot, rounds_present=int(row.notna().sum())))
    T["players"] = pd.DataFrame(prows)

    # ----- other events
    handled = set(heavy) | {"item_purchase", "round_start", "round_end", "round_freeze_end", "round_officially_ended",
                            "begin_new_match", "cs_win_panel_match", "fire_bullets", "bomb_exploded", "bomb_dropped",
                            "bomb_pickup", "bomb_abortplant", "bomb_abortdefuse", "hegrenade_detonate",
                            "flashbang_detonate", "smokegrenade_detonate", "smokegrenade_expired",
                            "inferno_startburn", "inferno_expire", "inferno_extinguish", "decoy_started",
                            "decoy_detonate", "molotov_detonate"}
    misc = []
    for name, df in sorted(E.items()):
        if name in handled or df.empty:
            continue
        sid = pid(df, "user")
        data_cols = [c for c in df.columns if c not in ("tick", "user_steamid", "user_name", "total_rounds_played")]
        payload = df[data_cols].to_dict(orient="records")
        misc.append(pd.DataFrame({"tick": df.tick, "event": name, "steamid": sid,
                                  "data": [json.dumps(p, default=_json_default) for p in payload]}))
    # parse_events returns same-tick events in a varying order; sort so the table is reproducible.
    em = stamp(pd.concat(misc, ignore_index=True).sort_values(["tick", "event"], kind="stable")) if misc else pd.DataFrame(
        columns=["tick", "event", "steamid", "data", "round"])
    T["events_misc"] = em

    # ----- validation
    # Damage passes on the game's own counter; the hit table is checked against it per round, where a
    # round boundary read one tick early credits some round more than the game counted and fails the map.
    gd = player_rounds.groupby("steamid").game_damage.sum()
    checks = validate_scoreboard(kills, {int(s_): int(v) for s_, v in gd.items()}, sb_part) \
        + validate_rounds(rounds, final_score)
    hit_checks, unattributed_hp = hit_table_checks(dmg, player_rounds)
    checks += hit_checks
    gl = ctx.info["grenade_link"]
    checks.append(dict(check="grenade_throws_linked", expected=gl["throws"], actual=gl["linked"],
                       ok=gl["throws"] == gl["linked"], fatal=False, note=f"projectiles={gl['projectiles']}"))
    # Rows where the game's m_unCurrentEquipmentValue differs from inventory + armor + kit priced
    # from PRICE_FILE. Both columns are stored.
    ctx.info.update(dict(header=header, convars=cvars, final_score=final_score, teams=teams,
                         rounds=len(rounds), match_start_tick=match_start, final_tick=final_tick,
                         voided_windows=voided, checks=checks, unattributed_damage_hp=unattributed_hp,
                         equip_value_mismatch_rows=int((econ.equip_value_game != econ.inventory_value
                                                        + np.where(econ.armor > 0, VEST_PRICE, 0)
                                                        + np.where(econ.helmet, HELMET_UPGRADE_COST, 0)
                                                        + np.where(econ.defuser, DEFUSER_PRICE, 0)).sum()),
                         economy_rows=len(econ)))
    return T


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


# ---------------------------------------------------------------------------
# awpy stage (independent parser; cross-check)
# ---------------------------------------------------------------------------

def stage_awpy(ctx: Context) -> dict[str, pl.DataFrame]:
    """awpy's tables, or none for a truncated demo, which demoparser2 then reads alone."""
    from awpy import InvalidDemoError
    try:
        return _awpy_tables(ctx)
    except InvalidDemoError as e:
        if not any(m in str(e) for m in TRUNCATION_MESSAGES):
            raise
        ctx.truncated, ctx._awpy_demo = True, None
        ctx.info.update(awpy_error=str(e)[:300], awpy_header={})
        gc.collect()
        return {}


def _awpy_tables(ctx: Context) -> dict[str, pl.DataFrame]:
    d = ctx.awpy_demo()
    ctx.tick_rate = float(d.tick_rate)
    ctx.info["awpy_header"] = d.header
    # Grenade trajectories feed grenade_paths; rounds, kills, blinds and stats feed the cross-checks.
    names = ["rounds", "kills", "blinds", "stats", "grenades"]
    d.load(*names)
    out = {n: getattr(d, n) for n in names}
    ctx.info["awpy_convars"] = d.convars
    # Networked velocity for every player at every tick (0.4 s and 70 MB on the Ancient fixture).
    # Drop null/0 steamids in polars first: to_pandas() turns a nullable u64 column into float64.
    sn = (d.ticks(["velocity_x", "velocity_y", "velocity_z", "name"], players_only=True)
          .filter(pl.col("steamid").is_not_null() & ((pl.col("steamid") > 0) | pl.col("name").is_not_null()))
          .with_columns(pl.col("tick").cast(pl.Int32), pl.col("velocity_x", "velocity_y", "velocity_z")
                        .cast(pl.Float32)).to_pandas())
    ctx.velocity = sn.rename(columns={"velocity_x": "vel_x", "velocity_y": "vel_y", "velocity_z": "vel_z"})
    ctx._awpy_demo = None
    del d
    gc.collect()
    return out


def cross_check_awpy(ours: dict, theirs: dict) -> list[dict]:
    """Compare the primary tables with awpy's (informational: two parsers, two rule sets).

    Expected gaps on the test demos: awpy keeps warmup kills, and its blinds
    include unassigned observers but miss some re-flashes on players who are
    already blind; durations agree wherever both have the row.
    """
    ac = [dict(check="awpy_round_count", expected=len(ours["rounds"]), actual=theirs["rounds"].height,
               ok=len(ours["rounds"]) == theirs["rounds"].height, fatal=False, note="")]
    n_match_kills = theirs["kills"].filter(pl.col("tick") >= int(ours["rounds"].start_tick.min())).height
    ac.append(dict(check="awpy_kill_count_after_match_start", expected=len(ours["kills"]), actual=n_match_kills,
                   ok=len(ours["kills"]) == n_match_kills, fatal=False, note=""))
    players = theirs["blinds"].filter(pl.col("victim_side").is_in(["terrorist", "counter-terrorist"]))
    mine = pl.from_pandas(ours["blinds"][["tick", "victim_steamid", "duration"]].reset_index(drop=True))
    joined = mine.join(players.select(["tick", "victim_steamid", pl.col("duration").alias("d2")]),
                       on=["tick", "victim_steamid"], how="inner")
    max_diff = float((joined["duration"] - joined["d2"]).abs().max() or 0.0)
    ac.append(dict(check="awpy_blinds_subset_and_durations", expected=players.height, actual=joined.height,
                   ok=joined.height == players.height and max_diff < 1e-3, fatal=False,
                   note=f"ours={len(ours['blinds'])} max_duration_diff={max_diff:.4f}"))
    sb = ours["scoreboard"].set_index("steamid")
    st = theirs["stats"].to_pandas()
    bad = [int(r.steamid) for r in st.itertuples() if r.steamid in sb.index and
           (int(sb.loc[r.steamid].kills_total) != r.kills or int(sb.loc[r.steamid].deaths_total) != r.deaths)]
    ac.append(dict(check="awpy_stats_kd_vs_scoreboard", expected=0, actual=len(bad), ok=not bad, fatal=False,
                   note=f"mismatched steamids {bad}" if bad else ""))
    return ac


STAGES = [("awpy", stage_awpy), ("demoparser2", stage_demoparser2)]


def recover_output(out: Path) -> None:
    """Finish or undo a folder swap that a crash interrupted, so out is a whole map again. Only extractors
    before 1.5.0 swapped folders (out renamed to out.old, the new folder renamed in); this cleans up after
    them."""
    aside = out.with_name(out.name + ".old")
    if aside.exists():
        if out.exists():
            shutil.rmtree(aside)  # the swap finished; only deleting the old copy was interrupted
        else:
            aside.rename(out)  # the crash came between the two renames: put the old map back


# A map folder holds one folder per extraction, v-<extractor version>-<random nonce>, and a file CURRENT
# naming the one to read. Publishing writes the tables, then COMPLETE (the list of files and their sizes)
# last, renames that new folder into place, then replaces CURRENT with os.replace, which is atomic for a
# file on Windows too. Every extraction gets a folder of its own: reusing one with the same tables could
# pick up a folder a prune had half deleted. Nothing renames a folder a reader may have open:
# Windows refuses that ([WinError 5] with any file inside it open). Old versions are deleted once nothing
# holds them open; prune_map() leaves locked ones for the next try.
CURRENT = "CURRENT"
COMPLETE = "COMPLETE"  # JSON {file name: bytes} of a version folder, written after every table
RETIRED = "RETIRED"  # a map replaced by its re-extraction in another folder; delete it all
_VERSION_DIR = re.compile(r"v-[0-9A-Za-z.+_]+-[0-9a-f]{8}")


def resolve_map_dir(map_dir: Path) -> Path | None:
    """The folder holding a map's tables, or None when map_dir holds no complete map.

    That is the version folder CURRENT names, if its COMPLETE list names files that are all there at their
    listed sizes; for a map written before 1.5.0 (no CURRENT), map_dir itself. A reader resolves, then
    opens; if a file has gone by then, the map was republished: resolve again.
    """
    map_dir = Path(map_dir)
    if (map_dir / RETIRED).exists():
        return None
    ptr = map_dir / CURRENT
    if ptr.exists():
        name = ptr.read_text(encoding="utf-8").strip()
        if not _VERSION_DIR.fullmatch(name):
            raise ValueError(f"{ptr} is not a version folder name: {name!r}")
        d = map_dir / name
        return d if _complete(d) else None
    return map_dir if (map_dir / "match.parquet").exists() else None


def _complete(d: Path) -> bool:
    try:
        files = json.loads((d / COMPLETE).read_text(encoding="utf-8"))
        return "match.parquet" in files and all((d / f).stat().st_size == n for f, n in files.items())
    except (OSError, ValueError):
        return False


def _write_pointer(map_dir: Path, name: str) -> None:
    staged = map_dir / f"{CURRENT}.{os.getpid()}.tmp"
    with open(staged, "w", encoding="utf-8") as f:
        f.write(name + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(staged, map_dir / CURRENT)


def publish_version(tmp: Path, map_dir: Path, version: str) -> Path:
    """Make the finished tables in tmp (a new folder inside map_dir) the map's current version, in a
    version folder of its own."""
    listing = {f.name: f.stat().st_size for f in sorted(tmp.glob("*.parquet"))}
    with open(tmp / COMPLETE, "w", encoding="utf-8") as f:
        json.dump(listing, f)
        f.flush()
        os.fsync(f.fileno())
    while (target := map_dir / f"v-{version}-{secrets.token_hex(4)}").exists():
        pass
    tmp.rename(target)  # tmp is new: no reader has it open
    _write_pointer(map_dir, target.name)
    return target


def _ours(entry: Path) -> bool:
    """Written by this extractor's publishing: a version folder, a partial write or a staged pointer."""
    n = entry.name
    return bool(_VERSION_DIR.fullmatch(n)) or n.startswith(".tmp-") or (n.startswith(f"{CURRENT}.") and n.endswith(".tmp"))


def _delete(entry: Path, locked: list[Path]) -> None:
    try:
        shutil.rmtree(entry) if entry.is_dir() and not entry.is_symlink() else entry.unlink()
    except OSError:  # open in a reader (Windows), or partly deleted; the next prune tries again
        locked.append(entry)


def prune_map(map_dir: Path) -> list[Path]:
    """Delete what map_dir no longer needs; return what could not be deleted yet (open in a reader).

    - a retired map: everything, then the folder;
    - beside a CURRENT: other version folders, partial writes, and the tables of a map written before 1.5.0
      (match.parquet first, so a reader looking for it stops treating the folder as a map);
    - with no map: only version folders, partial writes and staged pointers, never files this extractor
      did not write (a pre-v1 folder holds meta.parquet).
    """
    map_dir = Path(map_dir)
    if not map_dir.is_dir():
        return []
    locked: list[Path] = []
    if (map_dir / RETIRED).exists():
        for e in sorted(map_dir.iterdir(), key=lambda e: (e.name == RETIRED, e.name != "match.parquet")):
            if e.name != RETIRED:
                _delete(e, locked)
        if not locked:
            _delete(map_dir / RETIRED, locked)
            try:
                map_dir.rmdir()
            except OSError:
                locked.append(map_dir)
        return locked
    current = resolve_map_dir(map_dir) if (map_dir / CURRENT).exists() else None
    if current is None and (map_dir / CURRENT).exists():
        # Every version folder would look stale; publishing never leaves this, so stop and say so.
        raise RuntimeError(f"{map_dir}: CURRENT names an incomplete version folder; not pruning")
    for e in sorted(map_dir.iterdir(), key=lambda e: e.name != "match.parquet"):
        if e == current or e.name == CURRENT:
            continue
        if _ours(e) or (current is not None and e.is_file() and e.suffix == ".parquet"):
            _delete(e, locked)
    return locked


def retire_map(map_dir: Path) -> list[Path]:
    """Withdraw a map at once (resolve_map_dir returns None) and delete it as far as nothing holds it open."""
    marker = Path(map_dir) / RETIRED
    marker.touch()
    return prune_map(map_dir)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def load_mesh(mapdata: Path | None, map_name: str | None):
    """(VisibilityChecker or None, info dict with status and the release it came from)."""
    if mapdata is None:
        return None, dict(status="no_mapdata")
    manifest = json.loads((mapdata / "manifest.json").read_text(encoding="utf-8"))
    info = dict(release=manifest["client_version"], patch_version=manifest["patch_version"],
                buildid=manifest["buildid"])
    mesh = mapdata / "geometry" / f"{map_name}.mesh"
    if not map_name or not mesh.exists():
        return None, dict(info, status="no_mesh")
    from awpy import VisibilityChecker
    return VisibilityChecker(mesh), dict(info, status="ok", mesh_sha256=file_sha256(mesh))


def player_state(S: pd.DataFrame) -> pd.DataFrame:
    """Every player's state at every tick (tick, steamid, team_num, is_alive, X, Y, Z, pitch, yaw, duck_amount,
    spotted-by mask), with eye height and exact steamids."""
    return S.assign(eye_z=eye_z(S.Z, S.duck_amount).astype("float32"), steamid=to_u64(S.steamid))


def _eyes(df: pd.DataFrame) -> np.ndarray:
    return df[["X", "Y", "eye_z"]].to_numpy(dtype=float)


def checked_mesh(S: pd.DataFrame, kills: pd.DataFrame, mapdata: Path | None, map_name: str | None):
    """(VisibilityChecker or None, visibility info). The mesh is dropped (status mesh_mismatch) when it shows
    fewer than MESH_MIN_KILL_AGREEMENT of the clean kills as visible: it does not match the demo's map version.
    S: player_state() rows."""
    checker, vis = load_mesh(mapdata, map_name)
    if checker is not None:
        key = ["tick", "steamid"]
        clean = kills[(kills.penetrated == 0) & kills.attacker_steamid.notna() & ~kills.is_teamkill
                      & ~kills.is_suicide]
        a, v = (clean[["tick", who]].rename(columns={who: "steamid"}).merge(S, on=key, how="left")
                for who in ("attacker_steamid", "victim_steamid"))
        ok = a.X.notna().to_numpy() & v.X.notna().to_numpy()
        seen = mesh_visible(checker, _eyes(a)[ok], _eyes(v)[ok])
        vis["kills_checked"] = int(ok.sum())
        vis["kill_agreement"] = round(float(seen.mean()), 4) if ok.any() else None
        if vis["kill_agreement"] is not None and vis["kill_agreement"] < MESH_MIN_KILL_AGREEMENT:
            vis["status"], checker = "mesh_mismatch", None
    return checker, vis


ENGAGEMENT_PAIR = ["round", "attacker_steamid", "victim_steamid", "tick"]


def engagement_triggers(dmg: pd.DataFrame, kills: pd.DataFrame) -> pd.DataFrame:
    """Trigger (c): every damage and every kill by a player on an enemy. A kill triggers on its own, since a
    demo can lose the player_hurt of a killing hit but still has the player_death."""
    d = dmg[dmg.attacker_steamid.notna() & dmg.victim_steamid.notna() & ~dmg.is_team_damage & ~dmg.is_self]
    k = kills[kills.attacker_steamid.notna() & kills.victim_steamid.notna()
              & ~kills.is_teamkill.astype(bool) & ~kills.is_suicide.astype(bool)]
    return pd.concat([x[ENGAGEMENT_PAIR].astype({"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})
                      for x in (d, k)], ignore_index=True)


def engagement_tables(S, rounds, shots, dmg, kills, smokes, steam_bit, velocity, checker, rate):
    """Build engagements and engagement_ticks (definitions in engagements.py and SCHEMA-v1.md).

    S: player_state() rows; steam_bit maps a steamid to its bit in the spotted-by mask; checker: the
    checked_mesh() checker, or None when visibility is unavailable.
    """
    key = ["tick", "steamid"]
    eyes = _eyes

    bounds = {int(r.round): (int(r.freeze_end_tick) if not pd.isna(r.freeze_end_tick) else int(r.start_tick),
                             int(r.end_tick)) for r in rounds.itertuples()}
    pair = ENGAGEMENT_PAIR
    d = dmg[dmg.attacker_steamid.notna() & dmg.victim_steamid.notna() & ~dmg.is_team_damage & ~dmg.is_self]
    triggers = [engagement_triggers(dmg, kills)]
    if checker is not None:
        onset_rows = []  # (a) mesh-visibility onsets, both directions
        for rnd, (lo, hi) in bounds.items():
            sub = S[(S.tick >= lo) & (S.tick <= hi)]
            ids = np.sort(sub.steamid.dropna().unique().astype("uint64"))
            if len(ids) < 2:
                continue
            idx = {int(x): i for i, x in enumerate(ids)}
            team = sub.groupby("steamid").team_num.agg(lambda t: t.mode().iat[0])
            eye = np.full((hi - lo + 1, len(ids), 3), np.nan)
            alive = np.zeros((hi - lo + 1, len(ids)), dtype=bool)
            ti, pi = (sub.tick - lo).to_numpy(), np.array([idx[int(x)] for x in sub.steamid])
            eye[ti, pi] = eyes(sub)
            alive[ti, pi] = sub.is_alive.to_numpy(dtype=bool) & np.isfinite(eye[ti, pi]).all(axis=1)
            pairs = [(i, j) for i in range(len(ids)) for j in range(i + 1, len(ids))
                     if team[ids[i]] != team[ids[j]]]
            for t, i, j in visibility_onsets(checker, eye, alive, pairs):
                onset_rows += [(rnd, int(ids[i]), int(ids[j]), lo + t), (rnd, int(ids[j]), int(ids[i]), lo + t)]
        triggers.append(pd.DataFrame(onset_rows, columns=pair))
        # (b) shots at a mesh-visible enemy inside the shooter's view cone
        sh = shots[shots["round"] > 0][["round", "tick", "steamid"]].drop_duplicates()
        sa = sh.merge(S, on=key)
        sa = sa[sa.is_alive]
        cand = sa.merge(S[S.is_alive], on="tick", suffixes=("", "_v"))
        cand = cand[cand.team_num != cand.team_num_v]
        a_eye = cand[["X", "Y", "eye_z"]].to_numpy(dtype=float)
        v_eye = cand[["X_v", "Y_v", "eye_z_v"]].to_numpy(dtype=float)
        cone = in_view_cone(a_eye, cand.pitch.to_numpy(float), cand.yaw.to_numpy(float), v_eye)
        hit = np.zeros(len(cand), dtype=bool)
        hit[cone] = mesh_visible(checker, a_eye[cone], v_eye[cone])
        triggers.append(cand.loc[hit, ["round", "steamid", "steamid_v", "tick"]].set_axis(pair, axis=1))
    # Cast each frame first: concatenating nullable UInt64 with int64 ids would fall back to float64.
    trig = pd.concat([t.astype({"attacker_steamid": "UInt64", "victim_steamid": "UInt64"}) for t in triggers],
                     ignore_index=True)
    eng = group_triggers(trig, bounds, rate)

    # Per-tick rows
    rows = window_ticks(eng).merge(eng[["engagement_id", "attacker_steamid", "victim_steamid"]], on="engagement_id")
    shot_keys = set(zip(shots.tick.astype(int), shots.steamid.astype("Int64")))
    for p_, who in (("a", "attacker_steamid"), ("v", "victim_steamid")):
        st = S.drop(columns=["team_num", "is_alive"]).rename(columns={
            "steamid": who, "X": f"{p_}_x", "Y": f"{p_}_y", "Z": f"{p_}_z", "eye_z": f"{p_}_eye_z",
            "pitch": f"{p_}_pitch", "yaw": f"{p_}_yaw", "duck_amount": f"{p_}_duck", "mask": f"{p_}_mask"})
        rows = rows.merge(st, on=["tick", who], how="left")
        vel = velocity.rename(columns={"steamid": who, "vel_x": f"{p_}_vel_x", "vel_y": f"{p_}_vel_y",
                                       "vel_z": f"{p_}_vel_z"})
        rows = rows.merge(vel, on=["tick", who], how="left")
        rows[f"{p_}_shot_fired"] = [(int(t), int(x)) in shot_keys for t, x in zip(rows.tick, rows[who])]
    # Spotted flags from the mask: v_spotted_by_a means the attacker has the victim spotted.
    for p_, other, flag in (("v", "attacker_steamid", "v_spotted_by_a"), ("a", "victim_steamid", "a_spotted_by_v")):
        bits = rows[other].map(lambda x: steam_bit.get(int(x))).astype("Int64")
        mask = rows[f"{p_}_mask"].astype("Int64")
        rows[flag] = ((mask // (2 ** bits)) % 2 == 1).astype("boolean")
    have = rows[["a_x", "a_y", "v_x", "v_y"]].notna().all(axis=1).to_numpy()
    a_eye = rows[["a_x", "a_y", "a_eye_z"]].to_numpy(dtype=float)
    v_eye = rows[["v_x", "v_y", "v_eye_z"]].to_numpy(dtype=float)
    rows["smoke_blocked"] = pd.array(smoke_blocked(rows.tick.to_numpy(), a_eye, v_eye, smokes), dtype="boolean")
    rows.loc[~have, "smoke_blocked"] = pd.NA
    rows["mesh_visible"] = pd.array([pd.NA] * len(rows), dtype="boolean")
    if checker is not None:
        rows.loc[have, "mesh_visible"] = mesh_visible(checker, a_eye[have], v_eye[have])

    # Per-engagement summary
    def in_window(events, who="attacker_steamid", cols=()):
        m = events.merge(eng[["engagement_id", "attacker_steamid", "victim_steamid", "start_tick", "end_tick"]],
                         on=["attacker_steamid", "victim_steamid"] if who is None else [who])
        return m[(m.tick >= m.start_tick) & (m.tick <= m.end_tick)]

    dm = in_window(d[["attacker_steamid", "victim_steamid", "tick", "dmg_health_capped", "weapon"]], who=None)
    dm = dm.sort_values(["engagement_id", "tick"], kind="stable")
    hits = dm.groupby("engagement_id").agg(hits=("tick", "size"), damage=("dmg_health_capped", "sum"),
                                            first_damage_tick=("tick", "min"), weapon=("weapon", "first"))
    kk = in_window(kills[kills.attacker_steamid.notna()][["attacker_steamid", "victim_steamid", "tick"]], who=None)
    killed = set(kk.engagement_id)
    sh = in_window(shots[["steamid", "tick"]].rename(columns={"steamid": "attacker_steamid"}))
    first_shot = sh.groupby("engagement_id").tick.min()
    first_vis = rows[rows.mesh_visible.fillna(False)].groupby("engagement_id").tick.min()
    eng = eng.join(hits, on="engagement_id")
    eng["hits"] = eng.hits.fillna(0).astype("int16")
    eng["damage"] = eng.damage.fillna(0).astype("int32")
    eng["first_shot_tick"] = eng.engagement_id.map(first_shot)
    eng["first_visible_tick"] = eng.engagement_id.map(first_vis)
    eng["outcome"] = np.select([eng.engagement_id.isin(killed), eng.hits > 0, eng.first_shot_tick.notna()],
                               ["kill", "damage-only", "shots-only"], "sight-only")
    eng = eng[["engagement_id", "round", "attacker_steamid", "victim_steamid", "start_tick", "end_tick", "truncated",
               "outcome", "first_visible_tick", "first_shot_tick", "first_damage_tick", "hits", "damage", "weapon"]]
    order = ["engagement_id", "tick"] + [f"{p_}_{c}" for p_ in ("a", "v") for c in
                                         ("x", "y", "z", "eye_z", "pitch", "yaw", "vel_x", "vel_y", "vel_z",
                                          "duck", "shot_fired")] + ["a_spotted_by_v", "v_spotted_by_a",
                                                                    "mesh_visible", "smoke_blocked"]
    return eng, rows[order]


# ---------------------------------------------------------------------------
# Writing and the top-level entry point
# ---------------------------------------------------------------------------

_DTYPES = {"Boolean": pl.Boolean, "Float32": pl.Float32, "Int8": pl.Int8, "Int16": pl.Int16, "Int32": pl.Int32,
           "Int64": pl.Int64, "UInt32": pl.UInt32, "UInt64": pl.UInt64, "String": pl.String,
           "List(String)": pl.List(pl.String), "List(UInt64)": pl.List(pl.UInt64)}


def _to_polars(df, table: str) -> pl.DataFrame:
    """Convert a table to its declared schema v1 types (schema_v1.TYPES), in declared column order."""
    declared = TYPES[table]
    df = df.reset_index(drop=True)
    for c in df.columns:
        if df[c].dtype == object:
            sample = next((v for v in df[c] if v is not None and not (isinstance(v, float) and math.isnan(v))), None)
            if isinstance(sample, np.ndarray):
                df[c] = [list(v) if isinstance(v, np.ndarray) else v for v in df[c]]
    out = pl.from_pandas(df)
    extra, missing = set(out.columns) - set(declared), set(declared) - set(out.columns)
    if extra or missing:
        raise ValueError(f"table {table}: columns not in schema v1 {sorted(extra)}, missing {sorted(missing)}")
    # strict: a fractional value in an integer column, or an out-of-range value, raises.
    out = out.select([pl.col(c).cast(_DTYPES[t], strict=True) for c, t in declared.items()])
    nulls = {c: n for c in declared if c not in NULLABLE[table]
             and (n := out[c].null_count() + (int(out[c].is_nan().sum()) if out[c].dtype == pl.Float32 else 0))}
    if nulls:
        raise ValueError(f"table {table}: nulls in non-nullable columns {nulls}")
    if table in KEYS and (dup := int(out.select(KEYS[table]).is_duplicated().sum())):
        raise ValueError(f"table {table}: {dup} rows share a key {KEYS[table]}")
    return out


def map_key_for(dem: Path, map_name: str) -> str:
    m = FILE_RE.match(dem.stem)
    if not m:
        return re.sub(r"[^a-z0-9_-]+", "-", map_name.lower())
    key = f"m{m['n']}-{m['map']}" if m["n"] else m["map"]
    return key + (f"-p{m['part']}" if m["part"] else "")


def teams_from_filename(dem: Path) -> tuple[str | None, str | None]:
    m = FILE_RE.match(dem.stem)
    return (m["team1"], m["team2"]) if m else (None, None)


def extract_demo(dem: Path, out_dir: Path, source: str, mapdata: Path | None = None, archive: str = "",
                 meta_extra: dict | None = None) -> dict:
    """Parse one demo into out_dir. Returns a result dict; result['ok'] is the verdict."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}, got {source!r}")
    t0 = time.perf_counter()
    dem, out_dir = Path(dem), Path(out_dir)
    ctx = Context(dem=dem, out=out_dir, archive=archive, meta_extra=meta_extra or {},
                  mapdata=Path(mapdata) if mapdata else None)
    team1, team2 = teams_from_filename(dem)
    result = dict(archive=archive, extractor_version=EXTRACTOR_VERSION, dem_file=dem.name,
                  dem_bytes=dem.stat().st_size, map=None, team1_file=team1,
                  team2_file=team2, ok=False,
                  errors=[], timings=ctx.timings, rss_gb=ctx.rss_gb, rows={}, bytes={}, validation={})
    tmp = out_dir / f".tmp-{os.getpid()}"
    try:
        for name, fn in STAGES:
            with Timer(ctx, f"stage_{name}"):
                ctx.tables[name] = fn(ctx)
        info = ctx.info
        info["awpy_checks"] = cross_check_awpy(ctx.tables["demoparser2"], ctx.tables["awpy"]) if not ctx.truncated \
            else [dict(check="truncated", expected=None, actual=info["rounds"], ok=True, fatal=False,
                       note=f"awpy: {info['awpy_error']}; validated through round {info['rounds']}")]
        header = info["header"]
        result["map"] = map_key_for(dem, header.get("map_name", "unknown"))
        result["map_name"] = header.get("map_name")
        result["tick_rate"] = ctx.tick_rate
        result["rounds"] = info["rounds"]
        result["final_score"] = info["final_score"]

        rounds = ctx.tables["demoparser2"]["rounds"]
        start_ct = rounds.ct_team.iloc[0] if len(rounds) else None
        start_t = rounds.t_team.iloc[0] if len(rounds) else None
        vis = info["visibility"]
        result["visibility"] = vis
        demo_sha256 = file_sha256(dem)
        match = dict(match_id=demo_sha256[:16], source=source, map=header.get("map_name"), tick_rate=ctx.tick_rate,
                    demo_sha256=demo_sha256, extractor_version=EXTRACTOR_VERSION, schema_version=SCHEMA_VERSION,
                    visibility_status=vis["status"], mesh_release=vis.get("release"),
                    mesh_patch_version=vis.get("patch_version"), mesh_buildid=vis.get("buildid"),
                    mesh_sha256=vis.get("mesh_sha256"), mesh_kill_agreement=vis.get("kill_agreement"),
                    smoke_model=f"sphere r={SMOKE_RADIUS:g} at +{SMOKE_HEIGHT:g} (approximation)",
                    truncated=ctx.truncated,
                    velocity_source="position_diff" if ctx.truncated else "networked",
                    map_key=result["map"],
                    dem_file=dem.name, dem_bytes=dem.stat().st_size, archive=archive,
                    team1_file=team1, team2_file=team2, team_ct_start=start_ct, team_t_start=start_t,
                    score_ct_start=info["final_score"].get(start_ct), score_t_start=info["final_score"].get(start_t),
                    n_rounds=info["rounds"], match_start_tick=info["match_start_tick"],
                    unattributed_damage_hp=info["unattributed_damage_hp"],
                    final_tick=info["final_tick"], playback_ticks=info["awpy_header"].get("playback_ticks"),
                    patch_version=header.get("patch_version"), build_num=info["awpy_header"].get("build_num"),
                    server_name=header.get("server_name"), demo_version_guid=header.get("demo_version_guid"),
                    demoparser2_version=pkg_version("demoparser2"), awpy_version=pkg_version("awpy"),
                    polars_version=pl.__version__, pandas_version=pd.__version__,
                    python_version=platform.python_version(),
                    parsed_at_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    price_file=PRICE_FILE.name, price_source=PRICE_SOURCE, trade_window_s=TRADE_WINDOW_S, position_stride_ticks=POSITION_STRIDE_TICKS,
                    voided_windows=json.dumps(info["voided_windows"]),
                    convars=json.dumps(info["convars"]), awpy_convars=json.dumps(info.get("awpy_convars", {})),
                    unavailable_fields=json.dumps(UNAVAILABLE),
                    extra=json.dumps(ctx.meta_extra, default=str))
        ctx.tables["demoparser2"]["match"] = pd.DataFrame([match])

        checks = info["checks"] + info.get("awpy_checks", [])
        failed = [c for c in checks if c["fatal"] and not c["ok"]]
        result["validation"] = dict(passed=not failed, n_checks=len(checks),
                                    n_fatal_failed=len(failed), failed=failed,
                                    nonfatal_failed=[c for c in checks if not c["fatal"] and not c["ok"]],
                                    notes=[c for c in checks if c.get("note") and c["ok"]],
                                    equip_value_mismatch_rows=info["equip_value_mismatch_rows"],
                                    economy_rows=info["economy_rows"])
        if failed:
            raise ValidationFailed(f"{len(failed)} fatal validation checks failed: {failed[:5]}")

        with Timer(ctx, "write"):
            if tmp.exists():
                shutil.rmtree(tmp)
            # A folder retired earlier and now extracted into again holds a live map once more.
            (out_dir / RETIRED).unlink(missing_ok=True)
            tmp.mkdir(parents=True)
            # Only the schema v1 tables are written; awpy's own tables were inputs and cross-checks.
            for tname, df in ctx.tables["demoparser2"].items():
                p = tmp / f"{tname}.parquet"
                pdf = _to_polars(df, tname)
                pdf.write_parquet(p, compression="zstd", compression_level=ZSTD_LEVEL)
                result["rows"][tname] = pdf.height
                result["bytes"][tname] = p.stat().st_size
            # Read back every file so a truncated write cannot pass.
            for p in tmp.rglob("*.parquet"):
                pl.read_parquet_schema(p)
            result["version_dir"] = publish_version(tmp, out_dir, EXTRACTOR_VERSION).name
            # An old version a reader still has open stays until a later prune; it never fails the map.
            result["old_versions_locked"] = [str(x) for x in prune_map(out_dir)]
        result["output_bytes"] = sum(result["bytes"].values())
        result["ok"] = True
    except Exception as e:  # noqa: BLE001 - every failure is reported, the RAR is kept
        msg = f"{type(e).__name__}: {e}"
        result["errors"].append(msg if not ctx.truncated or msg.startswith(f"RuntimeError: {TRUNCATED}")
                                else f"{TRUNCATED}: {msg}")
        result["traceback"] = traceback.format_exc(limit=8)
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
    result["seconds"] = round(time.perf_counter() - t0, 2)
    try:
        import psutil
        mi = psutil.Process().memory_info()
        result["peak_rss_gb"] = round(getattr(mi, "peak_wset", mi.rss) / 1e9, 2)
    except Exception:  # noqa: BLE001 - memory telemetry is best-effort
        pass
    return result


class ValidationFailed(RuntimeError):
    pass


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dem", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--source", required=True, choices=SOURCES)
    ap.add_argument("--mapdata", type=Path, help="awpy-data release folder with geometry/<map>.mesh")
    ap.add_argument("--archive", default="")
    ap.add_argument("--meta", default="{}", help="JSON object stored in match.extra")
    ap.add_argument("--result", type=Path, help="write the result JSON here")
    a = ap.parse_args(argv)
    res = extract_demo(a.dem, a.out_dir, a.source, a.mapdata, a.archive, json.loads(a.meta))
    txt = json.dumps(res, default=_json_default, indent=1)
    if a.result:
        a.result.write_text(txt, encoding="utf-8")
    else:
        print(txt)
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
