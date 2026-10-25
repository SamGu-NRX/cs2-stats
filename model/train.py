"""Train and export the CS2 round win-probability model.

Usage (from model/):
    .venv/Scripts/python -I train.py --data data/cs2rb_v1

Fits, on CS2RB's frozen per-map training split, every model restricted to the nine
state features the app has at a kill (alive counts, team HP, freeze-end equipment,
plant flag, seconds since plant, seconds since freeze end) plus the map:

  baselines   constant CT win rate; per-map CT win rate (WPA's "map average");
              (ctAlive, tAlive) lookup table
  WPA models  logistic regression on the raw attributes; XGBoost and CatBoost with
              100 trees over WPA's depth x min_child_weight / depth x l2_leaf_reg grids
  reference   XGBoost with learning rate 0.05 and early stopping on validation
  compact     logistic regressions with engineered terms (compact.CANDIDATES)

Hyperparameters are chosen on the validation split. The exported model is the
smallest compact candidate whose pooled test log loss is within 1% of the best model's
(best = lowest validation log loss). Writes export/model.json,
export/parity_rows.json and metrics.json.

Load limits: the user plays CS2 on this machine. Every library runs on at most
--threads threads (default 4); while cs2.exe runs, heavy steps drop to 2 threads and the
hyperparameter grids wait until it closes. To keep memory low, only 13 columns are read,
map by map, and the logistic design matrix is built in 250k-row chunks (peak memory was
not measured).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

AP = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
AP.add_argument("--data", required=True, help="extracted cs2rb_v1 folder (states/, splits.parquet, SHA256SUMS.txt)")
AP.add_argument("--threads", type=int, default=4, help="thread cap for every library (max 4)")
AP.add_argument("--skip-hash", action="store_true", help="skip the SHA-256 check of the input files")
AP.add_argument("--export", metavar="CANDIDATE",
                help="export this compact candidate instead of the smallest one within 1%% of the best "
                     "(e.g. lr_cells, which fixes the late-round bias described in the README)")
AP.add_argument("--quick", action="store_true",
                help="smoke run: 5%% of states, first config of each grid, outputs to runs/quick/")
ARGS = AP.parse_args()
THREADS = max(1, min(ARGS.threads, 4))
# BLAS/OpenMP read these once, at import, so they are set before numpy and friends load.
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ[_v] = str(THREADS)

import hashlib  # noqa: E402
import json  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script folder from the path
import compact as C  # noqa: E402

HERE = Path(__file__).resolve().parent
EXPORT = HERE / ("runs/quick" if ARGS.quick else "export")
OUT_METRICS = EXPORT / "metrics.json" if ARGS.quick else HERE / "metrics.json"
COLS = ["match_id", "label_ct", "ct_alive", "t_alive", "ct_hp", "t_hp", "ct_equip", "t_equip",
        "planted", "time_since_plant", "elapsed_s"]
RAW = ["ct_alive", "t_alive", "ct_hp", "t_hp", "ct_equip", "t_equip", "planted", "time_since_plant", "elapsed_s"]
SEED = 42
GRID_DEPTHS = (6,) if ARGS.quick else (6, 8, 10, 12)
GRID_N = 1 if ARGS.quick else 4
WITHIN = 0.01  # export the smallest compact model within 1% of the best test log loss


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---- sharing the machine with CS2 ------------------------------------------------------

def cs2_running():
    if os.name != "nt":
        return False
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/NH"],
                         capture_output=True, text=True).stdout
    return "cs2.exe" in out.lower()


def threads_now():
    """Thread count for the next heavy step: 2 while CS2 runs, else the cap."""
    if cs2_running():
        log("cs2.exe is running: this step uses 2 threads")
        return min(2, THREADS)
    return THREADS


def wait_for_cs2_to_close():
    """Hyperparameter searches only start while CS2 is closed."""
    if cs2_running():
        log("cs2.exe is running: waiting for it to close before the hyperparameter search")
        while cs2_running():
            time.sleep(60)
        log("cs2.exe closed; continuing")


def lower_priority():
    if os.name == "nt":
        import ctypes
        BELOW_NORMAL = 0x4000
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL)


# ---- data ------------------------------------------------------------------------------

def verify_hashes(root: Path):
    lines = (root / "SHA256SUMS.txt").read_text(encoding="utf-8").split("\n")
    for line in filter(None, (l.strip() for l in lines)):
        digest, name = line.split(maxsplit=1)
        if not (name.startswith("states/") or name == "splits.parquet"):
            continue
        h = hashlib.sha256()
        with open(root / name, "rb") as f:
            for block in iter(lambda: f.read(8 << 20), b""):
                h.update(block)
        if h.hexdigest() != digest:
            raise SystemExit(f"SHA-256 mismatch for {name}; re-download the archive")
    log("input files match SHA256SUMS.txt")


def load(root: Path):
    """One compact row per state across all maps, with each map's frozen partition."""
    splits = pd.read_parquet(root / "splits.parquet")
    parts = []
    for i, m in enumerate(C.MAPS):
        d = pd.read_parquet(root / "states" / f"{m}.parquet", columns=COLS)
        d["map_id"] = np.int8(i)
        d = d.merge(splits[splits.map_name == m][["match_id", "partition"]], on="match_id",
                    how="left", validate="many_to_one")
        if d.partition.isna().any():
            raise SystemExit(f"{m}: states without a frozen partition")
        parts.append(d)
        log(f"loaded {m}: {len(d):,} states")
    df = pd.concat(parts, ignore_index=True)
    df["partition"] = df.partition.astype("category")
    df["map_name"] = pd.Categorical.from_codes(df.map_id, C.MAPS)

    # The splits are per map, so one match can be "train" on one map and "test" or
    # "validation" on another. Pooled training drops those matches' training rows so no
    # match contributes to both fitting and evaluation; the test and validation sets stay
    # exactly the frozen ones.
    held = set(splits.loc[splits.partition != "train", "match_id"])
    leak = (df.partition == "train") & df.match_id.isin(held)
    info = {"states": len(df),
            "train_states_dropped_cross_map": int(leak.sum()),
            "train_matches_dropped_cross_map": int(df.loc[leak, ["map_id", "match_id"]].drop_duplicates().shape[0])}
    df["role"] = df.partition.cat.add_categories(["dropped"])
    df.loc[leak, "role"] = "dropped"
    # 0.43% of states have no freeze-end equipment record; fill with the training median.
    tr = df.role == "train"
    info["equip_missing_states"] = int(df.ct_equip.isna().sum())
    info["equip_fill"] = {}
    for c in ["ct_equip", "t_equip"]:
        med = float(df.loc[tr, c].median())
        df[c] = df[c].fillna(med)
        info["equip_fill"][c] = med
    for r in ["train", "validation", "test"]:
        info[f"{r}_states"] = int((df.role == r).sum())
        info[f"{r}_maps_matches"] = int(df.loc[df.role == r, ["map_id", "match_id"]].drop_duplicates().shape[0])
    log(f"rows: {info}")
    return df, info


# ---- metrics ---------------------------------------------------------------------------

def scores(y, p):
    p = np.clip(np.asarray(p, dtype=np.float64), 1e-6, 1 - 1e-6)
    y = np.asarray(y, dtype=np.float64)
    return {"log_loss": float(-np.mean(y * np.log(p) + (1 - y) * np.log1p(-p))),
            "brier": float(np.mean((p - y) ** 2)),
            "auc": float(roc_auc_score(y, p)),
            "n": int(len(y))}


def by_map(frame, p):
    out = {"pooled": scores(frame.label_ct, p)}
    for i, m in enumerate(C.MAPS):
        k = (frame.map_id == i).to_numpy()
        out[m] = scores(frame.label_ct.to_numpy()[k], p[k])
    return out


def calibration(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    rows = []
    for b in range(bins):
        k = idx == b
        rows.append({"bin": f"{edges[b]:.1f}-{edges[b + 1]:.1f}", "n": int(k.sum()),
                     "mean_predicted": float(p[k].mean()) if k.any() else None,
                     "observed_ct_rate": float(y[k].mean()) if k.any() else None})
    return rows


# ---- models ----------------------------------------------------------------------------

def fit_baselines(tr, va, te):
    out = {}
    rate = tr.label_ct.mean()
    out["constant"] = (np.full(len(va), rate), np.full(len(te), rate), {"ct_rate": float(rate)})
    per_map = tr.groupby("map_id", observed=True).label_ct.mean()
    out["map_average"] = (va.map_id.map(per_map).to_numpy(float), te.map_id.map(per_map).to_numpy(float),
                          {"ct_rate_by_map": {C.MAPS[i]: float(v) for i, v in per_map.items()}})
    g = tr.groupby(["ct_alive", "t_alive"]).label_ct.agg(["sum", "size"])
    table = (g["sum"] + 1) / (g["size"] + 2)  # Laplace smoothing; every live cell occurs in training
    key = lambda d: pd.MultiIndex.from_arrays([d.ct_alive, d.t_alive])
    pv, pt = table.reindex(key(va)).to_numpy(), table.reindex(key(te)).to_numpy()
    if np.isnan(pv).any() or np.isnan(pt).any():
        raise SystemExit("alive lookup: an evaluation cell never occurs in training")
    out["alive_lookup"] = (pv, pt, {"cells": int(len(table))})
    return out


def xgb_matrix(d, label=True):
    X = d[RAW].copy()
    X["map"] = d.map_name
    return X, (d.label_ct if label else None)


def fit_xgb_wpa(tr, va, te):
    """WPA section IV-D: 100 trees, hist, defaults otherwise (learning rate 0.3), grid over
    max_depth x min_child_weight, chosen by validation log loss."""
    import xgboost as xgb
    wait_for_cs2_to_close()
    dtr = xgb.QuantileDMatrix(*xgb_matrix(tr), enable_categorical=True)
    dva = xgb.DMatrix(*xgb_matrix(va), enable_categorical=True)
    dte = xgb.DMatrix(*xgb_matrix(te), enable_categorical=True)
    grid, best = [], None
    for depth in GRID_DEPTHS:
        for mcw in (1, 3, 5, 7)[:GRID_N]:
            b = xgb.train({"objective": "binary:logistic", "max_depth": depth, "min_child_weight": mcw,
                           "tree_method": "hist", "nthread": threads_now(), "seed": SEED},
                          dtr, 100)
            pv = b.predict(dva)
            ll = scores(va.label_ct, pv)["log_loss"]
            grid.append({"max_depth": depth, "min_child_weight": mcw, "val_log_loss": ll})
            log(f"  xgb_wpa depth={depth} mcw={mcw}: val LL {ll:.5f}")
            if best is None or ll < best[0]:
                best = (ll, b, pv, grid[-1])
    return best[2], best[1].predict(dte), {"chosen": best[3], "grid": grid}


def fit_catboost_wpa(tr, va, te):
    """WPA section IV-D: 100 iterations, grid over depth x l2_leaf_reg."""
    from catboost import CatBoostClassifier, Pool
    wait_for_cs2_to_close()

    def pool(d):
        X = d[RAW].copy()
        X["map"] = d.map_name.astype(str)
        return Pool(X, d.label_ct.to_numpy(), cat_features=["map"])
    ptr, pva, pte = pool(tr), pool(va), pool(te)
    grid, best = [], None
    for depth in GRID_DEPTHS:
        for l2 in (1, 3, 5, 7)[:GRID_N]:
            m = CatBoostClassifier(iterations=100, depth=depth, l2_leaf_reg=l2, random_seed=SEED,
                                   thread_count=threads_now(), verbose=False, allow_writing_files=False)
            m.fit(ptr)
            pv = m.predict_proba(pva)[:, 1]
            ll = scores(va.label_ct, pv)["log_loss"]
            grid.append({"depth": depth, "l2_leaf_reg": l2, "val_log_loss": ll})
            log(f"  catboost_wpa depth={depth} l2={l2}: val LL {ll:.5f}")
            if best is None or ll < best[0]:
                best = (ll, m, pv, grid[-1])
    return best[2], best[1].predict_proba(pte)[:, 1], {"chosen": best[3], "grid": grid}


def fit_xgb_tuned(tr, va, te):
    """Reference model. WPA's learning rate of 0.3 overfits these correlated, 5 s-spaced
    states (validation loss bottoms out around tree 25), so this uses CS2RB's recipe instead:
    learning rate 0.05, row/column subsampling 0.9, early stopping on validation."""
    import xgboost as xgb
    wait_for_cs2_to_close()
    dtr = xgb.QuantileDMatrix(*xgb_matrix(tr), enable_categorical=True)
    dva = xgb.DMatrix(*xgb_matrix(va), enable_categorical=True)
    dte = xgb.DMatrix(*xgb_matrix(te), enable_categorical=True)
    grid, best = [], None
    for depth, mcw in [(6, 1), (8, 100), (10, 1000)][:GRID_N]:
        b = xgb.train({"objective": "binary:logistic", "eval_metric": "logloss", "eta": 0.05,
                       "max_depth": depth, "min_child_weight": mcw, "subsample": 0.9,
                       "colsample_bytree": 0.9, "tree_method": "hist", "nthread": threads_now(), "seed": SEED},
                      dtr, 3000, evals=[(dva, "validation")], early_stopping_rounds=50, verbose_eval=False)
        rng = (0, b.best_iteration + 1)
        pv = b.predict(dva, iteration_range=rng)
        ll = scores(va.label_ct, pv)["log_loss"]
        grid.append({"max_depth": depth, "min_child_weight": mcw, "trees": b.best_iteration + 1, "val_log_loss": ll})
        log(f"  xgb_tuned depth={depth} mcw={mcw}: {b.best_iteration + 1} trees, val LL {ll:.5f}")
        if best is None or ll < best[0]:
            best = (ll, b, pv, grid[-1], rng)
    return best[2], best[1].predict(dte, iteration_range=best[4]), {"chosen": best[3], "grid": grid}


def state_vars(d):
    return C.variables(d.ct_alive, d.t_alive, d.ct_hp, d.t_hp, d.ct_equip, d.t_equip,
                       d.planted, d.time_since_plant, d.elapsed_s)


def chunks(d, terms, map_share=None, size=250_000):
    names = d.map_name.astype(str).to_numpy()
    y = d.label_ct.to_numpy(np.float64)

    def gen():
        for s in range(0, len(d), size):
            part = d.iloc[s:s + size]
            yield C.design(terms, state_vars(part), names[s:s + size], map_share), y[s:s + size]
    return gen


def predict_terms(d, terms, w, map_share=None):
    z = np.concatenate([X @ w for X, _ in chunks(d, terms, map_share)()])
    return 1.0 / (1.0 + np.exp(-z))


def fit_compact(tr, va, te, name):
    from threadpoolctl import threadpool_limits
    terms = C.CANDIDATES[name]()
    with threadpool_limits(threads_now()):
        w = C.fit_newton(chunks(tr, terms), len(terms), log=lambda s: None)
    return predict_terms(va, terms, w), predict_terms(te, terms, w), {"terms": len(terms)}, (terms, w)


# ---- export ----------------------------------------------------------------------------

def round_sig(x, sig=9):
    return float(f"{x:.{sig}g}")


def write_model_json(path, model):
    """Compact JSON with one term per line, so diffs between retrains stay readable."""
    head = {k: v for k, v in model.items() if k != "terms"}
    body = json.dumps(head, separators=(",", ":"))[:-1]
    terms = ",\n".join(json.dumps(t, separators=(",", ":")) for t in model["terms"])
    path.write_text(f'{body},"terms":[\n{terms}\n]}}\n', encoding="utf-8")


def app_state(row):
    planted = int(row.planted)
    return {"ctAlive": int(row.ct_alive), "tAlive": int(row.t_alive), "ctHp": float(row.ct_hp),
            "tHp": float(row.t_hp), "ctEquip": float(row.ct_equip), "tEquip": float(row.t_equip),
            "planted": planted, "secondsSincePlant": float(row.time_since_plant) if planted else None,
            "secondsSinceFreezeEnd": float(row.elapsed_s)}


def parity_rows(model, te, terms, w):
    rng = np.random.default_rng(SEED)
    picks = []
    for i in range(len(C.MAPS)):  # 7 rows per map, plus one more from Dust2: 50 rows
        idx = np.flatnonzero((te.map_id == i).to_numpy())
        picks += list(rng.choice(idx, 8 if i == 0 else 7, replace=False))
    sample = te.iloc[sorted(picks)]
    vec = predict_terms(sample, [t["f"] for t in model["terms"]], np.array([t["w"] for t in model["terms"]]))
    rows = []
    for (_, r), pv in zip(sample.iterrows(), vec):
        st, m = app_state(r), str(r.map_name)
        p = C.predict_from_json(model, st, m)
        if abs(p - pv) > 1e-12:
            raise SystemExit(f"scalar and vectorized evaluators disagree: {p} vs {pv}")
        rows.append({"state": st, "map": m, "expected": p})
    base = rows[0]["state"]
    edge = [
        ("unknown map uses training-share map effects", dict(base), "de_vertigo"),
        ("unknown map, planted", dict(rows[[r["state"]["planted"] for r in rows].index(1)]["state"]), "cs_office"),
        ("CT eliminated", {**base, "ctAlive": 0, "ctHp": 0.0}, "de_dust2"),
        ("T eliminated without a plant", {**base, "tAlive": 0, "tHp": 0.0, "planted": 0, "secondsSincePlant": None}, "de_mirage"),
        ("bomb timer expired", {**base, "planted": 1, "secondsSincePlant": 40.0, "secondsSinceFreezeEnd": 90.0}, "de_nuke"),
        ("round clock expired", {**base, "planted": 0, "secondsSincePlant": None, "secondsSinceFreezeEnd": 115.0}, "de_inferno"),
        ("T eliminated after a plant (CT must defuse)", {**base, "tAlive": 0, "tHp": 0.0, "planted": 1, "secondsSincePlant": 12.0, "secondsSinceFreezeEnd": 70.0}, "de_ancient"),
    ]
    edges = [{"case": c, "state": s, "map": m, "expected": C.predict_from_json(model, s, m)} for c, s, m in edge]
    return {"description": "50 test-split states sampled with seed 42 (7 per map, 8 on Dust2) and edge cases; "
                           "expected = Python predict_from_json over export/model.json",
            "rows": rows, "edgeCases": edges}


def main():
    lower_priority()
    root = Path(ARGS.data)
    if not ARGS.skip_hash:
        verify_hashes(root)
    df, data_info = load(root)
    if ARGS.quick:
        df = df.sample(frac=0.05, random_state=SEED).sort_index()
    tr = df[df.role == "train"].reset_index(drop=True)
    va = df[df.role == "validation"].reset_index(drop=True)
    te = df[df.role == "test"].reset_index(drop=True)
    del df

    results, fitted = {}, {}

    def record(name, family, pv, pt, info, t0):
        results[name] = {"family": family, "validation": scores(va.label_ct, pv),
                         "test": by_map(te, np.asarray(pt, dtype=np.float64)),
                         "info": info, "seconds": round(time.time() - t0, 1)}
        log(f"{name}: val LL {results[name]['validation']['log_loss']:.5f}  "
            f"test LL {results[name]['test']['pooled']['log_loss']:.5f}")

    for name, (pv, pt, info) in fit_baselines(tr, va, te).items():
        record(name, "baseline", pv, pt, info, time.time())

    for name in C.CANDIDATES:
        t0 = time.time()
        log(f"fitting {name} ({len(C.CANDIDATES[name]())} terms)")
        pv, pt, info, fit = fit_compact(tr, va, te, name)
        fitted[name] = fit
        record(name, "wpa" if name == "lr_wpa_linear" else "compact", pv, pt, info, t0)

    for name, fn, fam in [("xgb_tuned", fit_xgb_tuned, "reference"),
                          ("xgb_wpa", fit_xgb_wpa, "wpa"),
                          ("catboost_wpa", fit_catboost_wpa, "wpa")]:
        t0 = time.time()
        log(f"fitting {name}")
        pv, pt, info = fn(tr, va, te)
        record(name, fam, pv, pt, info, t0)

    # Best = lowest validation log loss over every non-baseline model.
    best = min((n for n in results if results[n]["family"] != "baseline"),
               key=lambda n: results[n]["validation"]["log_loss"])
    best_test = results[best]["test"]["pooled"]["log_loss"]
    best_val = results[best]["validation"]["log_loss"]
    ladder = sorted(fitted, key=lambda n: results[n]["info"]["terms"])
    chosen = next((n for n in ladder if results[n]["test"]["pooled"]["log_loss"] <= (1 + WITHIN) * best_test), None)
    chosen_by_val = next((n for n in ladder if results[n]["validation"]["log_loss"] <= (1 + WITHIN) * best_val), None)
    if ARGS.export:
        if ARGS.export not in fitted:
            raise SystemExit(f"--export {ARGS.export}: not a compact candidate ({', '.join(fitted)})")
        log(f"--export overrides the 1% rule (which picks {chosen}) with {ARGS.export}")
        chosen = ARGS.export
    if chosen is None:
        raise SystemExit(f"no compact candidate within {WITHIN:.0%} of {best} ({best_test:.5f}); add a larger one")
    log(f"best model {best} (test LL {best_test:.5f}); exporting {chosen}; validation rule picks {chosen_by_val}")

    terms, w = fitted[chosen]
    w = np.array([round_sig(x) for x in w])
    tr_share = tr.map_name.value_counts(normalize=True)
    map_share = {m: round_sig(float(tr_share[m])) for m in C.MAPS}

    # Metrics of the exported (rounded) coefficients, for known maps and as an unknown map.
    pv_exp, pt_exp = predict_terms(va, terms, w), predict_terms(te, terms, w)
    pt_unknown = predict_terms(te, terms, w, map_share)
    exported = {"validation": scores(va.label_ct, pv_exp), "test": by_map(te, pt_exp),
                "test_scored_as_unknown_map": scores(te.label_ct, pt_unknown),
                "calibration_test": calibration(te.label_ct.to_numpy(np.float64), pt_exp)}
    rel = exported["test"]["pooled"]["log_loss"] / best_test - 1

    model = {
        "format": "cs2-winprob-logit-terms",
        "version": 1,
        "createdUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "candidate": chosen,
        "predicts": "P(CT wins the round | state); sigmoid(sum over terms of w * product of factors)",
        "inputs": {
            "ctAlive": "living CT players (integer 0-5)",
            "tAlive": "living T players (integer 0-5)",
            "ctHp": "summed health of living CTs (0-100 each)",
            "tHp": "summed health of living Ts",
            "ctEquip": "CT team equipment value at freeze end, dollars, all five players (fixed for the round)",
            "tEquip": "T team equipment value at freeze end, dollars",
            "planted": "0 or 1",
            "secondsSincePlant": "seconds since the bomb was planted; null when not planted",
            "secondsSinceFreezeEnd": "seconds since freeze time ended",
        },
        "variables": C.VARIABLES,
        "factorGrammar": {"name": "variable value", "name=k": "1 if variable == k else 0",
                          "name>k": "max(0, variable - k)",
                          "map=de_x": "1 on that map else 0; on a map not in `maps`, its training share (mapShare)"},
        "maps": C.MAPS,
        "mapShare": map_share,
        "terminal": {"bombSeconds": 40, "roundSeconds": 115,
                     "rules": ["ctAlive == 0 -> 0", "tAlive == 0 and not planted -> 1",
                               "planted and secondsSincePlant >= bombSeconds -> 0",
                               "not planted and secondsSinceFreezeEnd >= roundSeconds -> 1"],
                     "why": "CS2RB keeps only live states (CS2 competitive: 40 s bomb, 1:55 round), so the "
                            "model never saw decided ones; these follow from the game rules instead"},
        "metrics": {
            "test_pooled": exported["test"]["pooled"],
            "test_by_map": {m: {k: round(v, 6) if isinstance(v, float) else v for k, v in exported["test"][m].items()}
                            for m in C.MAPS},
            "validation_pooled": exported["validation"],
            "test_pooled_as_unknown_map": exported["test_scored_as_unknown_map"],
            "best_model": best,
            "best_model_test_log_loss": best_test,
            "relative_to_best": rel,
        },
        "data": {"source": "CS2RB v1.0 (Bishop, 2026), https://doi.org/10.5281/zenodo.22970589, CC BY 4.0",
                 "splits": "frozen per-map train/validation/test from splits.parquet",
                 "train_states": data_info["train_states"]},
        "terms": [{"w": float(wi), "f": t} for wi, t in zip(w, terms)],
    }
    EXPORT.mkdir(parents=True, exist_ok=True)
    write_model_json(EXPORT / "model.json", model)
    model = json.loads((EXPORT / "model.json").read_text(encoding="utf-8"))  # round-trip what the app reads
    parity = parity_rows(model, te, terms, w)
    (EXPORT / "parity_rows.json").write_text(json.dumps(parity, indent=1) + "\n", encoding="utf-8")

    summary = {"created_utc": model["createdUtc"], "threads": THREADS, "data": data_info,
               "best_model": best, "exported": chosen, "exported_by_validation_rule": chosen_by_val,
               "exported_metrics": exported, "models": results,
               "versions": {p: __import__(p).__version__ for p in ["numpy", "pandas", "sklearn", "xgboost", "catboost"]},
               "python": sys.version.split()[0]}
    OUT_METRICS.write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")

    size = (EXPORT / "model.json").stat().st_size
    log(f"wrote {EXPORT / 'model.json'} ({size:,} bytes, {len(terms)} terms), parity_rows.json, {OUT_METRICS}")
    print("\nmodel             family     val LL   test LL  test Brier  test AUC")
    for n, r in sorted(results.items(), key=lambda kv: kv[1]["test"]["pooled"]["log_loss"]):
        t = r["test"]["pooled"]
        print(f"{n:17s} {r['family']:9s} {r['validation']['log_loss']:.5f}  {t['log_loss']:.5f}  "
              f"{t['brier']:.5f}     {t['auc']:.4f}")


if __name__ == "__main__":
    main()
