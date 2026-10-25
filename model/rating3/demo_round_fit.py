"""Fit Rating 3 research features from strict schema-v1 demo joins."""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo_paths import column, demo_layout

import numpy as np
import pyarrow.parquet as pq
from scipy.optimize import least_squares

GROUPS = ("sniper", "rifle1", "rifle2", "smg", "pistolPlus", "pistol")
GROUP_INDEX = {name: index for index, name in enumerate(GROUPS)}

FEATURES = (
    "eco_kills",
    "eco_deaths",
    "damage_game",
    "damage_raw100",
    "damage_capped100",
    "kills_count",
    "deaths_count",
    "assists_count",
    "flash_assists_count",
    "trade_kills_count",
    "traded_deaths_count",
    "kill",
    "assist",
    "flash_assist",
    "survival",
    "team_win",
    "team_loss",
    "trade_kill",
    "traded_death",
    "mk2",
    "mk3",
    "mk4",
    "mk5",
    "swing",
    "equip_diff",
    "kill_x_equip",
    "survival_x_win",
    "damage_x_equip",
    "eco_kills_x_equip",
    "eco_deaths_x_equip",
    "kill_x_win",
    "death_x_loss",
    "damage_x_survival",
    "swing_x_kill",
    "swing_x_survival",
)

STAGES = {
    "fractional_eco": ("eco_kills", "eco_deaths"),
    "damage_game": ("eco_kills", "eco_deaths", "damage_game"),
    "damage_raw_and_capped": (
        "eco_kills", "eco_deaths", "damage_game", "damage_raw100", "damage_capped100"
    ),
    "kast_components": (
        "eco_kills", "eco_deaths", "damage_game", "damage_raw100", "damage_capped100",
        "kill", "assist", "survival", "traded_death",
    ),
    "trade_flash_multikill_swing": (
        "eco_kills", "eco_deaths", "damage_game", "damage_raw100", "damage_capped100",
        "kill", "assist", "survival", "traded_death", "flash_assist", "trade_kill",
        "mk2", "mk3", "mk4", "mk5", "swing",
    ),
    "action_counts_and_outcomes": (
        "eco_kills", "eco_deaths", "damage_game", "damage_capped100",
        "kills_count", "deaths_count", "assists_count", "flash_assists_count",
        "trade_kills_count", "traded_deaths_count", "survival", "team_win", "team_loss",
        "mk2", "mk3", "mk4", "mk5", "swing",
    ),
    "expanded_interactions": FEATURES,
}


def normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def number(value: object) -> float:
    text = str(value).replace("%", "").replace("+", "").strip()
    return float("nan") if text in {"", "-", "N/A", "None"} else float(text)


def kd(value: object) -> tuple[float, float]:
    left = str(value).split("(", 1)[0].replace(":", " ").split()
    return float(left[0]), float(left[1]) if len(left) > 1 else 0.0


def cell(row: dict, prefix: str, eco: bool = False) -> str:
    for classes, value in row["cells"]:
        if prefix in classes and ("eco-adjusted-data" in classes) == eco:
            return value
    raise KeyError((prefix, eco))


def weapon_group(value: object) -> str | None:
    weapon = normalize(value)
    if any(name in weapon for name in ("awp", "g3sg1", "scar20")):
        return "sniper"
    if any(name in weapon for name in ("ak47", "m4a1", "aug", "sg556")):
        return "rifle1"
    if any(name in weapon for name in ("galilar", "famas", "ssg08")):
        return "rifle2"
    if any(name in weapon for name in (
        "mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon", "nova",
        "xm1014", "sawedoff", "mag7", "m249", "negev",
    )):
        return "smg"
    if any(name in weapon for name in (
        "deagle", "revolver", "p250", "fiveseven", "tec9", "cz75", "dualberetta",
    )):
        return "pistolPlus"
    if any(name in weapon for name in ("glock", "hkp2000", "usps", "usp")):
        return "pistol"
    return None


def fallback_group(row: dict | None) -> str:
    if row:
        group = weapon_group(row.get("best_primary")) or weapon_group(row.get("best_secondary"))
        if group:
            return group
        return "pistolPlus" if row.get("armor") else "pistol"
    return "pistol"


def sigmoid(value: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.clip(value, -40, 40)))


def parse_targets(data: dict) -> dict[str, dict]:
    total = [b for b in data["scoreboards"] if "totalstats" in b["cls"].split()]
    if len(total) != 2:
        raise ValueError("expected two total scoreboards")
    ct = [b for b in data["scoreboards"] if "ctstats" in b["cls"].split()]
    tt = [b for b in data["scoreboards"] if "tstats" in b["cls"].split()]
    if len(ct) != 2 or len(tt) != 2:
        raise ValueError("expected two side scoreboards")
    targets: dict[str, dict] = {}
    for board in total:
        for row in board["rows"]:
            name = normalize(row["player"])
            ek, _ = kd(cell(row, "st-kills", True))
            ed, _ = kd(cell(row, "st-deaths", True))
            targets[name] = {
                "pid": str(row["pid"]),
                "player": row["player"],
                "total": number(cell(row, "st-rating")),
                "eco_kills_display": ek,
                "eco_deaths_display": ed,
            }
    for side, boards in (("ct", ct), ("t", tt)):
        for board in boards:
            for row in board["rows"]:
                name = normalize(row["player"])
                if name not in targets:
                    continue
                eco_kills, _ = kd(cell(row, "st-kills", True))
                eco_deaths, _ = kd(cell(row, "st-deaths", True))
                targets[name][side] = number(cell(row, "st-rating"))
                targets[name][f"{side}_eco_kills_display"] = eco_kills
                targets[name][f"{side}_eco_deaths_display"] = eco_deaths
    return {name: row for name, row in targets.items() if {"total", "ct", "t"} <= row.keys()}


def fit_duels(events: list[dict], targets: list[dict], include_side_targets: bool = False) -> dict:
    if not include_side_targets:
        targets = [target for target in targets if target["side"] is None]

    def unpack(params: np.ndarray) -> tuple[np.ndarray, float, float]:
        strengths = np.r_[params[:5], 0.0]
        return strengths, float(params[5]), float(params[6])

    def predict_event(params: np.ndarray, event: dict) -> float:
        strengths, scale, edge = unpack(params)
        side_edge = edge if event["side"] == "CT" else -edge
        probability = sigmoid(
            strengths[GROUP_INDEX[event["attacker_group"]]]
            - strengths[GROUP_INDEX[event["victim_group"]]]
            + side_edge
        )
        return scale * (1.0 - probability)

    def residual(params: np.ndarray) -> list[float]:
        predicted: dict[tuple[str, str, str], dict[str, float]] = defaultdict(
            lambda: {"kills": 0.0, "deaths": 0.0}
        )
        for event in events:
            points = predict_event(params, event)
            predicted[(event["map"], event["attacker"], "total")]["kills"] += points
            predicted[(event["map"], event["victim"], "total")]["deaths"] += points
            attacker_side = event["side"].lower()
            victim_side = "t" if attacker_side == "ct" else "ct"
            predicted[(event["map"], event["attacker"], attacker_side)]["kills"] += points
            predicted[(event["map"], event["victim"], victim_side)]["deaths"] += points
        output = []
        for target in targets:
            side = target["side"] or "total"
            value = predicted[(target["map"], target["player"], side)]
            output.extend([
                (value["kills"] - target["eco_kills_display"]) * 0.2,
                (value["deaths"] - target["eco_deaths_display"]) * 0.2,
            ])
        return output

    initial = np.array([1.5, 1.18, 0.83, 0.56, 0.29, 2.14, -np.log(0.48 / 0.52)])
    fit = least_squares(
        residual,
        initial,
        bounds=([-4.0] * 5 + [0.1, -2.0], [4.0] * 5 + [8.0, 2.0]),
        max_nfev=2000,
    )
    strengths, scale, edge = unpack(fit.x)
    return {
        "strength": dict(zip(GROUPS, strengths.tolist())),
        "kill_scale": scale,
        "ct_edge": edge,
        "events": len(events),
        "targets": len(targets),
        "objective_mae": float(np.mean(np.abs(residual(fit.x)))),
    }


def duel_points(model: dict, attacker_group: str, victim_group: str, side: str) -> float:
    strength = model["strength"]
    edge = model["ct_edge"] if side == "CT" else -model["ct_edge"]
    probability = float(sigmoid(
        strength[attacker_group] - strength[victim_group] + edge
    ))
    return model["kill_scale"] * (1.0 - probability)


def load_hltv_round_swing(data: dict) -> dict[tuple[str, int], float]:
    result = {}
    for player in data["performance"].get("players", []):
        name = normalize(player.get("nick", player.get("name", "")))
        for round_number, value in player.get("perRound", []):
            result[(name, int(round_number))] = number(value)
    return result


def load_player_rounds(directory: Path) -> tuple[list[dict], bool]:
    path = directory / "player_rounds.parquet"
    if path.exists():
        return pq.read_table(path).to_pylist(), True
    path = directory / "economy.parquet"
    if path.exists():
        return pq.read_table(path).to_pylist(), False
    return [], False


def build_duel_events(root: Path, joins: list[dict]) -> tuple[list[dict], list[dict]]:
    events = []
    targets = []
    for join in joins:
        directory = demo_layout(root, join["demo"]).directory
        if not (directory / "kills.parquet").exists():
            continue
        hltv = json.loads((root / "hltv" / join["hltv"]).read_text(encoding="utf-8"))
        target_by_name = parse_targets(hltv)
        player_rounds, _ = load_player_rounds(directory)
        if not player_rounds:
            continue
        kills = pq.read_table(directory / "kills.parquet").to_pylist()
        names = {str(row["steamid"]): normalize(row["name"]) for row in player_rounds}
        round_players = {(int(row["round"]), str(row["steamid"])): row for row in player_rounds}
        for name, target in target_by_name.items():
            for side in (None, "ct", "t"):
                prefix = "" if side is None else f"{side}_"
                targets.append({
                    "map": join["hltv"],
                    "player": name,
                    "side": side,
                    "eco_kills_display": target[f"{prefix}eco_kills_display"],
                    "eco_deaths_display": target[f"{prefix}eco_deaths_display"],
                })
        for kill in kills:
            if kill["is_suicide"] or kill["is_teamkill"]:
                continue
            attacker = names.get(str(kill.get("attacker_steamid")))
            victim = names.get(str(kill.get("victim_steamid")))
            if attacker not in target_by_name or victim not in target_by_name:
                continue
            attacker_row = round_players.get((int(kill["round"]), str(kill["attacker_steamid"])))
            victim_row = round_players.get((int(kill["round"]), str(kill["victim_steamid"])))
            attacker_group = (
                weapon_group(kill.get("a_active_weapon"))
                or weapon_group(kill.get("a_best_primary"))
                or fallback_group(attacker_row)
            )
            victim_group = (
                weapon_group(kill.get("v_active_weapon"))
                or weapon_group(kill.get("v_best_primary"))
                or fallback_group(victim_row)
            )
            if not attacker_group or not victim_group:
                continue
            events.append({
                "map": join["hltv"],
                "round": int(kill["round"]),
                "attacker": attacker,
                "victim": victim,
                "attacker_group": attacker_group,
                "victim_group": victim_group,
                "side": str(kill.get("a_side") or (attacker_row or {}).get("side", "CT")),
            })
    return events, targets


def build_round_rows(root: Path, joins: list[dict], duel_model: dict) -> list[dict]:
    output = []
    for join in joins:
        directory = demo_layout(root, join["demo"]).directory
        required = ("rounds.parquet", "kills.parquet", "damages.parquet", "players.parquet")
        if not all((directory / name).exists() for name in required):
            continue
        player_rounds, exact_game_damage = load_player_rounds(directory)
        if not player_rounds:
            continue
        hltv = json.loads((root / "hltv" / join["hltv"]).read_text(encoding="utf-8"))
        targets = parse_targets(hltv)
        swing = load_hltv_round_swing(hltv)
        rounds = {int(row["round"]): row for row in pq.read_table(directory / "rounds.parquet").to_pylist()}
        players = pq.read_table(directory / "players.parquet").to_pylist()
        kills = pq.read_table(directory / "kills.parquet").to_pylist()
        damages = pq.read_table(directory / "damages.parquet").to_pylist()
        names = {str(row["steamid"]): normalize(row["name"]) for row in players}
        round_player = {(int(row["round"]), str(row["steamid"])): row for row in player_rounds}
        valid_players = {
            (round_number, steamid): target
            for (round_number, steamid), row in round_player.items()
            if (target := targets.get(names.get(steamid, ""))) is not None
        }
        kill_count = defaultdict(int)
        death_count = defaultdict(int)
        assist_count = defaultdict(int)
        flash_assist_count = defaultdict(int)
        trade_kill_count = defaultdict(int)
        traded_death_count = defaultdict(int)
        fractional_kills = defaultdict(float)
        fractional_deaths = defaultdict(float)
        raw_damage = defaultdict(lambda: defaultdict(float))
        capped_damage = defaultdict(lambda: defaultdict(float))
        for kill in kills:
            round_number = int(kill["round"])
            attacker_id = str(kill.get("attacker_steamid"))
            victim_id = str(kill.get("victim_steamid"))
            attacker = names.get(attacker_id)
            victim = names.get(victim_id)
            if kill["is_suicide"] or kill["is_teamkill"] or attacker not in targets or victim not in targets:
                continue
            kill_count[(round_number, attacker_id)] += 1
            death_count[(round_number, victim_id)] += 1
            if kill.get("assister_steamid"):
                assister_id = str(kill["assister_steamid"])
                if assister_id in names:
                    assist_count[(round_number, assister_id)] += 1
                    if kill.get("assistedflash"):
                        flash_assist_count[(round_number, assister_id)] += 1
            if column(kill, "extractor_trade_kill_5s"):
                trade_kill_count[(round_number, attacker_id)] += 1
            if column(kill, "extractor_traded_death_5s"):
                traded_death_count[(round_number, victim_id)] += 1
            attacker_row = round_player.get((round_number, attacker_id))
            victim_row = round_player.get((round_number, victim_id))
            ag = weapon_group(kill.get("a_active_weapon")) or weapon_group(kill.get("a_best_primary")) or fallback_group(attacker_row)
            vg = weapon_group(kill.get("v_active_weapon")) or weapon_group(kill.get("v_best_primary")) or fallback_group(victim_row)
            if ag and vg:
                points = duel_points(duel_model, ag, vg, str(kill.get("a_side") or (attacker_row or {}).get("side", "CT")))
                fractional_kills[(round_number, attacker_id)] += points
                fractional_deaths[(round_number, victim_id)] += points
        damage_by_victim_raw = defaultdict(lambda: defaultdict(float))
        damage_by_victim_capped = defaultdict(lambda: defaultdict(float))
        for damage in damages:
            if damage["is_self"] or damage["is_team_damage"]:
                continue
            attacker_id = str(damage.get("attacker_steamid"))
            victim_id = str(damage.get("victim_steamid"))
            if names.get(attacker_id) not in targets or names.get(victim_id) not in targets:
                continue
            round_number = int(damage["round"])
            key = (round_number, attacker_id)
            victim_key = (round_number, attacker_id, victim_id)
            raw_damage[key][victim_id] += float(damage.get("dmg_health") or 0)
            damage_by_victim_raw[victim_key]["value"] += float(damage.get("dmg_health") or 0)
            damage_by_victim_capped[victim_key]["value"] += float(damage.get("dmg_health_capped") or 0)
        for (round_number, attacker_id, victim_id), value in damage_by_victim_raw.items():
            raw_damage[(round_number, attacker_id)][victim_id] = min(100.0, value["value"])
        for (round_number, attacker_id, victim_id), value in damage_by_victim_capped.items():
            capped_damage[(round_number, attacker_id)][victim_id] = min(100.0, value["value"])
        for (round_number, attacker_id), victims in raw_damage.items():
            raw_damage[(round_number, attacker_id)]["__sum__"] = sum(v for k, v in victims.items() if k != "__sum__")
        for (round_number, attacker_id), victims in capped_damage.items():
            capped_damage[(round_number, attacker_id)]["__sum__"] = sum(v for k, v in victims.items() if k != "__sum__")
        equip_by_round_side = defaultdict(int)
        for row in player_rounds:
            equip_by_round_side[(int(row["round"]), row["side"])] += int(row.get("equip_value_game") or 0)
        game_damage_by_player = {}
        for row in player_rounds:
            key = (int(row["round"]), str(row["steamid"]))
            if exact_game_damage:
                game_damage_by_player[key] = float(row.get("game_damage") or 0)
            else:
                game_damage_by_player[key] = capped_damage[key].get("__sum__", 0.0)
        death_keys = set(death_count)
        for (round_number, steamid), player in valid_players.items():
            row = round_player[(round_number, steamid)]
            side = str(row["side"])
            round_data = rounds.get(round_number, {})
            winner_side = str(round_data.get("winner_side", ""))
            kills_this_round = kill_count[(round_number, steamid)]
            opponent_side = "T" if side == "CT" else "CT"
            equip_diff = (equip_by_round_side[(round_number, side)] - equip_by_round_side[(round_number, opponent_side)]) / 1000.0
            survived = bool(row["survived"]) if "survived" in row else (round_number, steamid) not in death_keys
            deaths_this_round = death_count[(round_number, steamid)]
            assists_this_round = assist_count[(round_number, steamid)]
            flash_assists_this_round = flash_assist_count[(round_number, steamid)]
            trade_kills_this_round = trade_kill_count[(round_number, steamid)]
            traded_deaths_this_round = traded_death_count[(round_number, steamid)]
            team_won = float(side == winner_side)
            damage_game = game_damage_by_player[(round_number, steamid)]
            damage_raw = raw_damage[(round_number, steamid)].get("__sum__", 0.0)
            damage_capped = capped_damage[(round_number, steamid)].get("__sum__", 0.0)
            eco_kills = fractional_kills[(round_number, steamid)]
            eco_deaths = fractional_deaths[(round_number, steamid)]
            swing_value = swing.get((names[steamid], round_number), 0.0)
            values = {
                "eco_kills": eco_kills,
                "eco_deaths": eco_deaths,
                "damage_game": damage_game,
                "damage_raw100": damage_raw,
                "damage_capped100": damage_capped,
                "kills_count": float(kills_this_round),
                "deaths_count": float(deaths_this_round),
                "assists_count": float(assists_this_round),
                "flash_assists_count": float(flash_assists_this_round),
                "trade_kills_count": float(trade_kills_this_round),
                "traded_deaths_count": float(traded_deaths_this_round),
                "kill": float(kills_this_round > 0),
                "assist": float(assists_this_round > 0),
                "flash_assist": float(flash_assists_this_round > 0),
                "survival": float(survived),
                "team_win": team_won,
                "team_loss": 1.0 - team_won,
                "trade_kill": float(trade_kills_this_round > 0),
                "traded_death": float(traded_deaths_this_round > 0),
                "mk2": float(kills_this_round >= 2),
                "mk3": float(kills_this_round >= 3),
                "mk4": float(kills_this_round >= 4),
                "mk5": float(kills_this_round >= 5),
                "swing": swing_value,
                "equip_diff": equip_diff,
                "kill_x_equip": float(kills_this_round) * equip_diff,
                "survival_x_win": float(survived) * team_won,
                "damage_x_equip": damage_game * equip_diff,
                "eco_kills_x_equip": eco_kills * equip_diff,
                "eco_deaths_x_equip": eco_deaths * equip_diff,
                "kill_x_win": float(kills_this_round) * team_won,
                "death_x_loss": float(deaths_this_round) * (1.0 - team_won),
                "damage_x_survival": damage_game * float(survived),
                "swing_x_kill": swing_value * float(kills_this_round),
                "swing_x_survival": swing_value * float(survived),
            }
            values["map"] = join["hltv"]
            values["player"] = names[steamid]
            values["side"] = side.lower()
            values["round"] = round_number
            output.append(values)
    return output


def aggregate(rows: list[dict]) -> tuple[np.ndarray, np.ndarray, list[dict], list[str]]:
    by_player = defaultdict(list)
    for row in rows:
        by_player[(row["map"], row["player"])].append(row)
    designs = []
    targets = []
    metadata = []
    for (map_name, player), player_rows in by_player.items():
        # Targets are attached to the round rows by the caller.
        target = player_rows[0]["target"]
        for side_name in ("total", "ct", "t"):
            selected = player_rows if side_name == "total" else [r for r in player_rows if r["side"] == side_name]
            if not selected:
                continue
            metadata.append({"map": map_name, "player": player, "side": side_name, "rounds": len(selected), "target": target[side_name]})
            designs.append([float(np.mean([r[feature] for r in selected])) for feature in FEATURES])
            targets.append(target[side_name])
    return np.asarray(designs, dtype=float), np.asarray(targets, dtype=float), metadata, list(FEATURES)


def aggregate_identity(rows: list[dict]) -> list[dict]:
    by_player = defaultdict(list)
    for row in rows:
        by_player[(row["map"], row["player"])].append(row)
    records = []
    for (map_name, player), player_rows in by_player.items():
        target = player_rows[0]["target"]
        by_side = {
            side: [row for row in player_rows if row["side"] == side]
            for side in ("ct", "t")
        }
        if not by_side["ct"] or not by_side["t"]:
            continue
        records.append({
            "map": map_name,
            "player": player,
            "ct": np.asarray([np.mean([row[feature] for row in by_side["ct"]]) for feature in FEATURES]),
            "t": np.asarray([np.mean([row[feature] for row in by_side["t"]]) for feature in FEATURES]),
            "ct_rounds": len(by_side["ct"]),
            "t_rounds": len(by_side["t"]),
            "target": target,
        })
    return records


def attach_targets(rows: list[dict], root: Path) -> list[dict]:
    cache = {}
    output = []
    for row in rows:
        if row["map"] not in cache:
            data = json.loads((root / "hltv" / row["map"]).read_text(encoding="utf-8"))
            cache[row["map"]] = parse_targets(data)
        target = cache[row["map"]].get(row["player"])
        if target is None:
            continue
        row = dict(row)
        row["target"] = {side: target[side] for side in ("total", "ct", "t")}
        output.append(row)
    return output


def score(actual: np.ndarray, predicted: np.ndarray) -> dict:
    error = np.abs(actual - predicted)
    return {
        "n": int(len(error)),
        "mae": float(error.mean()),
        "p95": float(np.quantile(error, 0.95)),
        "max": float(error.max()),
        "r": float(np.corrcoef(actual, predicted)[0, 1]),
    }


def fit_stage(X: np.ndarray, y: np.ndarray, metadata: list[dict], features: tuple[str, ...]) -> dict:
    indexes = [FEATURES.index(feature) for feature in features]
    raw = X[:, indexes]
    means = raw.mean(axis=0)
    scales = raw.std(axis=0)
    scales[scales == 0] = 1.0
    z = (raw - means) / scales
    design = np.column_stack([np.ones(len(z)), z])
    coefficients = np.linalg.lstsq(design, y, rcond=None)[0]
    predicted = design @ coefficients
    groups = {}
    for side in ("total", "ct", "t"):
        mask = np.array([row["side"] == side for row in metadata])
        groups[side] = score(y[mask], predicted[mask])
    return {
        "features": list(features),
        "coefficients": coefficients.tolist(),
        "means": means.tolist(),
        "scales": scales.tolist(),
        "fit": score(y, predicted),
        "groups": groups,
        "predicted": predicted,
        "design": design,
    }


def fit_identity_stage(records: list[dict], features: tuple[str, ...]) -> dict:
    indexes = [FEATURES.index(feature) for feature in features]
    raw = np.vstack([np.vstack([record["ct"][indexes], record["t"][indexes]]) for record in records])
    means = raw.mean(axis=0)
    scales = raw.std(axis=0)
    scales[scales == 0] = 1.0
    coefficients_size = len(features) + 1
    design = []
    targets = []
    labels = []
    for record in records:
        ct = np.r_[1.0, (record["ct"][indexes] - means) / scales]
        tt = np.r_[1.0, (record["t"][indexes] - means) / scales]
        total_weight = record["ct_rounds"] + record["t_rounds"]
        ct_weight = record["ct_rounds"] / total_weight
        t_weight = record["t_rounds"] / total_weight
        design.extend([
            np.r_[ct, np.zeros(coefficients_size)],
            np.r_[np.zeros(coefficients_size), tt],
            np.r_[ct_weight * ct, t_weight * tt],
        ])
        targets.extend([record["target"]["ct"], record["target"]["t"], record["target"]["total"]])
        labels.extend(["ct", "t", "total"])
    design_array = np.asarray(design)
    target_array = np.asarray(targets)
    coefficients = np.linalg.lstsq(design_array, target_array, rcond=None)[0]
    predicted = design_array @ coefficients
    groups = {}
    for label in ("total", "ct", "t"):
        mask = np.asarray(labels) == label
        groups[label] = score(target_array[mask], predicted[mask])
    return {
        "features": list(features),
        "means": means.tolist(),
        "scales": scales.tolist(),
        "coefficients": coefficients.tolist(),
        "fit": score(target_array, predicted),
        "groups": groups,
    }


def identity_quantization_floor(result: dict, records: list[dict], features: tuple[str, ...]) -> dict:
    indexes = [FEATURES.index(feature) for feature in features]
    means = np.asarray(result["means"])
    scales = np.asarray(result["scales"])
    coefficients = np.asarray(result["coefficients"])
    width = len(features) + 1
    rng = np.random.default_rng(0)
    base_predictions = []
    perturbations = []
    for record in records:
        ct = np.r_[1.0, (record["ct"][indexes] - means) / scales]
        tt = np.r_[1.0, (record["t"][indexes] - means) / scales]
        ct_weight = record["ct_rounds"] / (record["ct_rounds"] + record["t_rounds"])
        t_weight = 1.0 - ct_weight
        base_predictions.extend([
            np.r_[ct, np.zeros(width)] @ coefficients,
            np.r_[np.zeros(width), tt] @ coefficients,
            np.r_[ct_weight * ct, t_weight * tt] @ coefficients,
        ])
    for _ in range(200):
        predictions = []
        for record in records:
            noisy_ct = record["ct"][indexes].copy()
            noisy_t = record["t"][indexes].copy()
            for j, feature in enumerate(features):
                if feature not in {"eco_kills", "eco_deaths", "swing"}:
                    continue
                noisy_ct[j] += rng.uniform(-0.5, 0.5) * (1.0 / record["ct_rounds"] if feature != "swing" else 0.01)
                noisy_t[j] += rng.uniform(-0.5, 0.5) * (1.0 / record["t_rounds"] if feature != "swing" else 0.01)
            ct = np.r_[1.0, (noisy_ct - means) / scales]
            tt = np.r_[1.0, (noisy_t - means) / scales]
            ct_weight = record["ct_rounds"] / (record["ct_rounds"] + record["t_rounds"])
            t_weight = 1.0 - ct_weight
            predictions.extend([
                np.r_[ct, np.zeros(width)] @ coefficients,
                np.r_[np.zeros(width), tt] @ coefficients,
                np.r_[ct_weight * ct, t_weight * tt] @ coefficients,
            ])
        perturbations.append(predictions)
    perturbed = np.asarray(perturbations)
    base = np.asarray(base_predictions)
    half_width = (perturbed.max(axis=0) - perturbed.min(axis=0)) / 2.0
    return {
        "rating_display": {"mae": 0.0025, "max": 0.005},
        "input_quantization": {
            "mae": float(np.mean(np.abs(perturbed.mean(axis=0) - base))),
            "max_half_width": float(half_width.max()),
            "p95_half_width": float(np.quantile(half_width, 0.95)),
        },
    }


def quantization_floor(result: dict, X: np.ndarray, metadata: list[dict], features: tuple[str, ...]) -> dict:
    indexes = [FEATURES.index(feature) for feature in features]
    raw = X[:, indexes]
    means = np.asarray(result["means"])
    scales = np.asarray(result["scales"])
    coefficients = np.asarray(result["coefficients"])
    base = np.column_stack([np.ones(len(raw)), (raw - means) / scales]) @ coefficients
    rng = np.random.default_rng(0)
    perturbations = []
    for _ in range(200):
        noisy = raw.copy()
        for j, feature in enumerate(features):
            if feature not in {"eco_kills", "eco_deaths", "swing"}:
                continue
            for i, row in enumerate(metadata):
                if feature in {"eco_kills", "eco_deaths"}:
                    half_step = 0.5 / row["rounds"]
                else:
                    half_step = 0.005
                noisy[i, j] += rng.uniform(-half_step, half_step)
        perturbations.append(np.column_stack([np.ones(len(noisy)), (noisy - means) / scales]) @ coefficients)
    perturbed = np.asarray(perturbations)
    half_width = (perturbed.max(axis=0) - perturbed.min(axis=0)) / 2.0
    return {
        "rating_display": {"mae": 0.0025, "max": 0.005},
        "input_quantization": {
            "mae": float(np.mean(np.abs(perturbed.mean(axis=0) - base))),
            "max_half_width": float(half_width.max()),
            "p95_half_width": float(np.quantile(half_width, 0.95)),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--joins", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    joins_result = json.loads(args.joins.read_text(encoding="utf-8"))
    joins = joins_result["accepted"]
    duel_events, duel_targets = build_duel_events(args.data, joins)
    duel_model = fit_duels(duel_events, duel_targets, include_side_targets=False)
    duel_model_with_sides = fit_duels(duel_events, duel_targets, include_side_targets=True)
    rows = attach_targets(build_round_rows(args.data, joins, duel_model), args.data)
    X, y, metadata, _ = aggregate(rows)
    results = {}
    for name, feature_names in STAGES.items():
        result = fit_stage(X, y, metadata, feature_names)
        floor = quantization_floor(result, X, metadata, feature_names)
        results[name] = {
            "features": result["features"],
            "fit": result["fit"],
            "groups": result["groups"],
            "rounding_floor": floor,
        }
    identity_records = aggregate_identity(rows)
    identity_features = tuple(STAGES["expanded_interactions"])
    identity_result = fit_identity_stage(identity_records, identity_features)
    results["side_identity_expanded_interactions"] = {
        "features": identity_result["features"],
        "fit": identity_result["fit"],
        "groups": identity_result["groups"],
        "rounding_floor": identity_quantization_floor(identity_result, identity_records, identity_features),
    }
    exact_game_damage_maps = sum(
        int(demo_layout(args.data, join["demo"]).format == "schema_v1") for join in joins
    )
    payload = {
        "joins": joins_result["counts"],
        "table_availability": {
            "accepted_join_folders": len(joins),
            "exact_game_damage_maps": exact_game_damage_maps,
            "capped_damage_fallback_maps": len(joins) - exact_game_damage_maps,
        },
        "duel_model": duel_model,
        "duel_model_with_side_targets": duel_model_with_sides,
        "round_rows": len(rows),
        "equations": len(y),
        "stages": results,
        "note": "Research-only fits. Fractional eco values are inferred from displayed eK/eD targets; no production constants are accepted.",
    }
    args.out.write_text(json.dumps(payload, indent=2, default=lambda value: value.tolist() if isinstance(value, np.ndarray) else value) + "\n", encoding="utf-8")
    print(json.dumps({"joins": joins_result["counts"], "duel_model": duel_model, "round_rows": len(rows), "equations": len(y), "stages": {name: value["fit"] for name, value in results.items()}}, indent=2))


if __name__ == "__main__":
    main()
