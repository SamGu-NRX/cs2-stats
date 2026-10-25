"""Compact logistic win-probability model: feature terms, fitting and a reference evaluator.

The exported model is a list of terms. Each term is a coefficient times a product of
factors, and P(CT wins) = sigmoid(sum of terms). A factor is a short string:

    name          the variable's value
    name=k        1 if the variable equals k, else 0
    name>k        max(0, variable - k), a hinge for piecewise-linear time effects
    map=de_x      1 on that map, else 0 (on an unknown map: that map's training share)

`export/winprob.ts` implements the same variables and factor grammar, and
`predict_from_json` below is the Python twin used to produce the parity rows.
"""
from __future__ import annotations

import math
import re

import numpy as np

MAPS = ["de_dust2", "de_mirage", "de_inferno", "de_ancient", "de_nuke", "de_anubis", "de_overpass"]

# Variables a factor can reference. The TypeScript evaluator derives the same set.
VARIABLES = {
    "ctAlive": "living CT players, 1-5",
    "tAlive": "living T players, 0-5",
    "planted": "1 if the bomb is planted, else 0",
    "ctHpLost": "ctAlive - ctHp/100: health missing from living CTs, in full-health players",
    "tHpLost": "tAlive - tHp/100",
    "ctEquipLog": "ln(1 + ctEquip/1000)",
    "tEquipLog": "ln(1 + tEquip/1000)",
    "elapsed": "secondsSinceFreezeEnd",
    "sincePlant": "secondsSincePlant when planted, else 0",
}

FACTOR_RE = re.compile(r"^(map)=(de_[a-z0-9_]+)$|^([A-Za-z]+)(?:([=>])(-?\d+(?:\.\d+)?))?$")


def parse_factor(s):
    m = FACTOR_RE.match(s)
    if not m:
        raise ValueError(f"malformed factor {s!r}")
    if m.group(1):
        return ("map", m.group(2), None)
    name, op, k = m.group(3), m.group(4), m.group(5)
    if name not in VARIABLES:
        raise ValueError(f"unknown variable {name!r} in factor {s!r}")
    return (name, op, float(k) if k is not None else None)


def variables(ct_alive, t_alive, ct_hp, t_hp, ct_equip, t_equip, planted, since_plant, elapsed):
    """Column arrays (float64) for every variable in VARIABLES."""
    f = lambda a: np.asarray(a, dtype=np.float64)
    ct_alive, t_alive, planted = f(ct_alive), f(t_alive), f(planted)
    return {
        "ctAlive": ct_alive,
        "tAlive": t_alive,
        "planted": planted,
        "ctHpLost": ct_alive - f(ct_hp) / 100.0,
        "tHpLost": t_alive - f(t_hp) / 100.0,
        "ctEquipLog": np.log1p(f(ct_equip) / 1000.0),
        "tEquipLog": np.log1p(f(t_equip) / 1000.0),
        "elapsed": f(elapsed),
        "sincePlant": np.where(planted == 1, f(since_plant), 0.0),
    }


def design(terms, v, map_names, map_share=None):
    """Design matrix (rows x terms). With `map_share`, every row is scored as an unknown map."""
    n = len(v["ctAlive"])
    X = np.empty((n, len(terms)), dtype=np.float64)
    for j, factors in enumerate(terms):
        col = np.ones(n)
        for s in factors:
            name, op, k = parse_factor(s)
            if name == "map":
                col = col * (map_share[op] if map_share is not None else (map_names == op))
            elif op == "=":
                col = col * (v[name] == k)
            elif op == ">":
                col = col * np.maximum(v[name] - k, 0.0)
            else:
                col = col * v[name]
        X[:, j] = col
    return X


# ---- candidate feature sets, smallest first -------------------------------------------

ELAPSED_KNOTS = [15, 30, 45, 60, 75, 90, 105]
PLANT_KNOTS = [10, 20, 25, 30, 35]
MAP_TERMS = [[f"map={m}"] for m in MAPS[1:]]  # Dust2 is the reference map


def terms_wpa_linear():
    """WPA's logistic regression: the raw state attributes plus a map indicator."""
    return [[]] + [[n] for n in ["ctAlive", "tAlive", "ctHpLost", "tHpLost", "ctEquipLog",
                                 "tEquipLog", "planted", "sincePlant", "elapsed"]] + MAP_TERMS


def alive_cells():
    """(ctAlive, tAlive, planted) cells of live states: T can be wiped only after a plant."""
    return [(c, t, p) for p in (0, 1) for c in range(1, 6) for t in range(0 if p else 1, 6)]


def cell(c, t, p):
    return [f"ctAlive={c}", f"tAlive={t}", f"planted={p}"]


def terms_cells_linear():
    """One intercept per alive/plant cell, then linear health, equipment and clock effects."""
    ts = [cell(*k) for k in alive_cells()]
    for n in ["ctHpLost", "tHpLost", "ctEquipLog", "tEquipLog"]:
        ts += [[n, f"planted={p}"] for p in (0, 1)]
    ts += [["elapsed", "planted=0"], ["sincePlant"]]
    return ts + MAP_TERMS


def terms_cells():
    """terms_cells_linear with piecewise-linear clocks (round clock before the plant, bomb
    clock after it), which captures the end-of-round time pressure."""
    ts = terms_cells_linear()
    ts += [[f"elapsed>{k}", "planted=0"] for k in ELAPSED_KNOTS]
    ts += [[f"sincePlant>{k}"] for k in PLANT_KNOTS]
    return ts


def terms_interactions():
    """terms_cells plus equipment and health effects that scale with the players alive,
    clock pressure that depends on each side's numbers, and map-specific post-plant play."""
    ts = terms_cells()
    for n in ["ctEquipLog", "tEquipLog"]:
        ts += [[n, a, f"planted={p}"] for a in ["ctAlive", "tAlive"] for p in (0, 1)]
    ts.append(["ctEquipLog", "tEquipLog"])
    ts += [[n, a, f"planted={p}"] for n, a in [("ctHpLost", "tAlive"), ("tHpLost", "ctAlive")] for p in (0, 1)]
    for a in ["ctAlive", "tAlive"]:
        ts.append(["elapsed", a, "planted=0"])
        ts += [[f"elapsed>{k}", a, "planted=0"] for k in ELAPSED_KNOTS]
        ts.append(["sincePlant", a])
        ts += [[f"sincePlant>{k}", a] for k in PLANT_KNOTS]
    ts += [[f"map={m}", "planted=1"] for m in MAPS[1:]]
    return ts


CANDIDATES = {
    "lr_wpa_linear": terms_wpa_linear,
    "lr_cells_linear": terms_cells_linear,
    "lr_cells": terms_cells,
    "lr_interactions": terms_interactions,
}


# ---- fitting --------------------------------------------------------------------------

def fit_newton(design_chunks, n_terms, l2=1.0, max_iter=30, tol=1e-9, log=print):
    """Maximum-likelihood logistic regression with a tiny ridge penalty (l2 * ||w||^2 / 2;
    with millions of rows it only keeps rare cells finite), solved by Newton's method.
    `design_chunks` is a callable yielding (X, y) chunks, so the full design matrix is never
    held in memory."""
    w = np.zeros(n_terms)
    prev = np.inf
    for it in range(max_iter):
        g = l2 * w
        H = l2 * np.eye(n_terms)
        nll = 0.5 * l2 * w @ w
        n = 0
        for X, y in design_chunks():
            z = X @ w
            p = 1.0 / (1.0 + np.exp(-z))
            g += X.T @ (p - y)
            H += (X * (p * (1 - p))[:, None]).T @ X
            nll += float(np.sum(np.logaddexp(0, z) - y * z))
            n += len(y)
        w -= np.linalg.solve(H, g)
        log(f"    newton {it + 1}: train mean nll {nll / n:.6f}")
        if prev - nll < tol * n:
            break
        prev = nll
    return w


# ---- reference evaluator over the exported JSON ---------------------------------------

def predict_from_json(model, state, map_name):
    """Scalar float64 evaluation of one app-side state from the exported JSON, with the same
    terminal rules and order of operations as export/winprob.ts."""
    ct_alive, t_alive, planted = state["ctAlive"], state["tAlive"], state["planted"]
    since, elapsed = state["secondsSincePlant"], state["secondsSinceFreezeEnd"]
    rules = model["terminal"]
    if ct_alive == 0:
        return 0.0
    if t_alive == 0 and planted == 0:
        return 1.0
    if planted == 1 and since >= rules["bombSeconds"]:
        return 0.0
    if planted == 0 and elapsed >= rules["roundSeconds"]:
        return 1.0
    v = {
        "ctAlive": float(ct_alive),
        "tAlive": float(t_alive),
        "planted": float(planted),
        "ctHpLost": ct_alive - state["ctHp"] / 100.0,
        "tHpLost": t_alive - state["tHp"] / 100.0,
        "ctEquipLog": math.log1p(state["ctEquip"] / 1000.0),
        "tEquipLog": math.log1p(state["tEquip"] / 1000.0),
        "elapsed": float(elapsed),
        "sincePlant": float(since) if planted == 1 else 0.0,
    }
    known = map_name in model["maps"]
    z = 0.0
    for t in model["terms"]:
        val = t["w"]
        for s in t["f"]:
            name, op, k = parse_factor(s)
            if name == "map":
                val *= (1.0 if map_name == op else 0.0) if known else model["mapShare"][op]
            elif op == "=":
                val *= 1.0 if v[name] == k else 0.0
            elif op == ">":
                val *= max(v[name] - k, 0.0)
            else:
                val *= v[name]
        z += val
    return 1.0 / (1.0 + math.exp(-z))
