"""Fit the Rating 3.0 (approx.) combination weights to HLTV's published player values.

    python -I fit_rating3.py players.csv                 # report only
    python -I fit_rating3.py players.csv --write          # also write app/src/stats/rating3-params.ts
    python -I fit_rating3.py --self-test                  # recover known weights from synthetic rows

Input: one row per player, with a header. Column names are case-insensitive; values may carry "%"
or "+" as HLTV prints them.

    player       name (optional, used in the residual list)
    rating       HLTV Rating 3.0
    kpr adr dpr  per round, unadjusted
    kast mk      percent, 0-100 (mk = rounds with a multi-kill)
    swing        round swing in percentage points per round (HLTV "+2.50%" is 2.5)
    kpr_eco adr_eco dpr_eco kast_eco mk_eco   the same, eco-adjusted (optional)

The model is ordinary least squares, rating = intercept + sum(w * feature), on the raw set and,
when the eco columns are present, on the eco set (eco KPR/ADR/DPR/KAST/MK plus swing). The report
gives R^2, adjusted R^2, MAE, RMSE and the largest error in sample, a k-fold cross-validated MAE,
and each weight with its standard error. --write keeps the set with the lower cross-validated MAE
(or --features) and writes it where rating3.ts reads it. Needs numpy only.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

FEATURES = ["kpr", "adr", "dpr", "kast", "mk", "swing"]
ECO = {"kpr": "kpr_eco", "adr": "adr_eco", "dpr": "dpr_eco", "kast": "kast_eco", "mk": "mk_eco", "swing": "swing"}
OUT = Path(__file__).resolve().parent.parent / "app" / "src" / "stats" / "rating3-params.ts"


def number(text: str) -> float:
    t = text.strip().replace("%", "").replace("+", "")
    if t in ("", "-", "N/A", "n/a"):
        return float("nan")
    return float(t)


def read_rows(path: Path) -> tuple[list[str], dict[str, np.ndarray]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            sys.exit(f"{path}: empty file")
        names = {n.strip().lower(): n for n in reader.fieldnames}
        need = ["rating", *FEATURES]
        missing = [c for c in need if c not in names]
        if missing:
            sys.exit(f"{path}: missing column(s) {', '.join(missing)}; have {', '.join(reader.fieldnames)}")
        rows = list(reader)
    cols: dict[str, np.ndarray] = {}
    for key, raw in names.items():
        if key == "player":
            continue
        try:
            cols[key] = np.array([number(r[raw]) for r in rows], dtype=float)
        except ValueError as e:
            sys.exit(f"{path}: column {raw!r} is not numeric ({e})")
    players = [r[names["player"]] if "player" in names else f"row {i + 2}" for i, r in enumerate(rows)]
    return players, cols


def design(cols: dict[str, np.ndarray], names: list[str]) -> np.ndarray:
    return np.column_stack([np.ones(len(cols[names[0]]))] + [cols[n] for n in names])


def ols(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.linalg.lstsq(x, y, rcond=None)[0]


def kfold_mae(x: np.ndarray, y: np.ndarray, k: int) -> float:
    n = len(y)
    order = np.random.default_rng(0).permutation(n)
    errs = np.empty(n)
    for fold in range(k):
        test = order[fold::k]
        train = np.setdiff1d(order, test)
        errs[test] = np.abs(x[test] @ ols(x[train], y[train]) - y[test])
    return float(errs.mean())


def fit(players: list[str], cols: dict[str, np.ndarray], names: list[str], folds: int) -> dict:
    x_all = design(cols, names)
    y_all = cols["rating"]
    ok = np.isfinite(x_all).all(axis=1) & np.isfinite(y_all)
    x, y = x_all[ok], y_all[ok]
    n, p = x.shape
    if n <= p + 1:
        sys.exit(f"{n} complete rows for {p} parameters; need more players")
    w = ols(x, y)
    pred = x @ w
    res = y - pred
    ss_res = float(res @ res)
    ss_tot = float(((y - y.mean()) ** 2).sum())
    sigma2 = ss_res / (n - p)
    se = np.sqrt(np.diag(sigma2 * np.linalg.pinv(x.T @ x)))
    worst = np.argsort(-np.abs(res))[:5]
    kept = [pl for pl, k in zip(players, ok) if k]
    return {
        "names": names, "n": n, "dropped": int((~ok).sum()), "w": w, "se": se,
        "r2": 1 - ss_res / ss_tot, "adj_r2": 1 - (ss_res / (n - p)) / (ss_tot / (n - 1)),
        "mae": float(np.abs(res).mean()), "rmse": float(np.sqrt(ss_res / n)), "max": float(np.abs(res).max()),
        "cv_mae": kfold_mae(x, y, min(folds, n)), "cond": float(np.linalg.cond(x)),
        "worst": [(kept[i], float(y[i]), float(pred[i])) for i in worst],
    }


def report(label: str, r: dict) -> None:
    print(f"\n== {label}: {r['n']} players" + (f" ({r['dropped']} rows with blanks dropped)" if r["dropped"] else ""))
    print(f"   R^2 {r['r2']:.4f}  adj R^2 {r['adj_r2']:.4f}  MAE {r['mae']:.4f}  RMSE {r['rmse']:.4f}  max {r['max']:.4f}")
    print(f"   {min(10, r['n'])}-fold CV MAE {r['cv_mae']:.4f}   condition number {r['cond']:.0f}")
    print(f"   {'term':<10}{'weight':>12}{'std err':>12}")
    for name, w, se in zip(["intercept", *r["names"]], r["w"], r["se"]):
        print(f"   {name:<10}{w:>12.6f}{se:>12.6f}")
    print("   largest errors: " + "; ".join(f"{p} {y:.2f} vs {f:.2f}" for p, y, f in r["worst"]))


def write_ts(r: dict, features: str, source_csv: str, path: Path) -> None:
    w = dict(zip(FEATURES, r["w"][1:]))
    today = dt.date.today().isoformat()
    source = (f"fit_rating3.py on {r['n']} HLTV players ({source_csv}, {today}): {features} features, "
              f"R² {r['r2']:.3f}, CV MAE {r['cv_mae']:.3f}")
    body = ",\n".join(f"    {k}: {v:.9g}" for k, v in w.items())
    path.write_text(
        f"// Written by model/fit_rating3.py on {today} from {source_csv}. Rerun the script instead of editing.\n"
        'import type { R3Params } from "./rating3";\n\n'
        "export const FITTED_R3: R3Params | null = {\n"
        "  calibrated: true,\n"
        f'  features: "{features}",\n'
        f"  intercept: {r['w'][0]:.9g},\n"
        f"  w: {{\n{body},\n  }},\n"
        f"  source: {json.dumps(source, ensure_ascii=False)},\n"
        "};\n",
        encoding="utf-8",
    )
    print(f"\nwrote {path}")


def self_test() -> None:
    """Synthetic players with known weights: the fit must recover them."""
    rng = np.random.default_rng(1)
    n = 280
    cols = {
        "kpr": rng.normal(0.68, 0.08, n), "adr": rng.normal(76, 8, n), "dpr": rng.normal(0.66, 0.05, n),
        "kast": rng.normal(71, 3.5, n), "mk": rng.normal(16, 3, n), "swing": rng.normal(0, 1.5, n),
    }
    truth = np.array([0.12, 0.55, 0.004, -0.45, 0.006, 0.01, 0.03])
    cols["rating"] = design(cols, FEATURES) @ truth + rng.normal(0, 0.005, n)
    r = fit([f"p{i}" for i in range(n)], cols, FEATURES, 10)
    report("self-test (raw)", r)
    err = np.abs(r["w"] - truth)
    tol = 4 * r["se"] + 1e-9
    if (err > tol).any() or r["r2"] < 0.99:
        sys.exit(f"self-test failed: |w - truth| {err} exceeds 4 standard errors {tol}")
    print("\nself-test passed: every weight within 4 standard errors of the truth")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", type=Path)
    ap.add_argument("--features", choices=["auto", "raw", "eco"], default="auto")
    ap.add_argument("--folds", type=int, default=10)
    ap.add_argument("--write", action="store_true", help=f"write the chosen fit to {OUT}")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        self_test()
        return
    if a.csv is None:
        ap.error("give the HLTV players CSV, or --self-test")
    players, cols = read_rows(a.csv)
    fits = {"raw": fit(players, cols, FEATURES, a.folds)}
    report("raw features", fits["raw"])
    if all(ECO[f] in cols for f in FEATURES):
        eco_cols = {"rating": cols["rating"], **{f: cols[ECO[f]] for f in FEATURES}}
        fits["eco"] = fit(players, eco_cols, FEATURES, a.folds)
        report("eco-adjusted features", fits["eco"])
    elif a.features == "eco":
        sys.exit("--features eco needs kpr_eco, adr_eco, dpr_eco, kast_eco and mk_eco columns")
    pick = min(fits, key=lambda k: fits[k]["cv_mae"]) if a.features == "auto" else a.features
    print(f"\nchosen: {pick} (lower cross-validated MAE)" if a.features == "auto" else f"\nchosen: {pick}")
    if a.write:
        write_ts(fits[pick], pick, a.csv.name, a.out)


if __name__ == "__main__":
    main()
