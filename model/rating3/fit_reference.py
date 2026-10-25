"""Fit the reference Rating 3.02 linear model from HLTV scoreboard outputs."""
from __future__ import annotations
import argparse, csv, json, math, re
from pathlib import Path
import numpy as np
from sklearn.preprocessing import PolynomialFeatures

FEATURES = ("kpr", "adr", "dpr", "kast", "mk", "swing")

def num(value: str) -> float:
    value = value.replace("%", "").replace("+", "").strip()
    return float("nan") if value in {"", "-", "N/A"} else float(value)

def rounds_in(data: dict) -> int:
    outcomes = [r["outcomes"] for r in data["roundHistory"]]
    return sum(any(i < len(outcome) and not outcome[i].startswith("emptyHistory")
                   for outcome in outcomes) for i in range(max(map(len, outcomes))))

def parse_kd(value: str) -> tuple[float, float]:
    left = value.split("(", 1)[0].strip().replace(":", " ").split()
    return float(left[0]), float(left[1]) if len(left) > 1 else float(left[0])

def map_rows(root: Path) -> list[dict]:
    rows = []
    for path in sorted(root.glob("map_*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("v") != 3: continue
        nrounds = rounds_in(data)
        for board in data["scoreboards"]:
            if "totalstats" not in board["cls"].split(): continue
            for row in board["rows"]:
                def get(prefix: str, eco=False):
                    for cell in row["cells"]:
                        classes, value = cell
                        if prefix in classes and ("eco-adjusted-data" in classes) == eco:
                            return value
                    raise KeyError(prefix)
                k, _ = parse_kd(get("st-kills", False)); ek, _ = parse_kd(get("st-kills", True))
                d, _ = parse_kd(get("st-deaths", False)); ed, _ = parse_kd(get("st-deaths", True))
                rows.append({"map": path.stem, "player": row["player"], "rounds": nrounds,
                             "rating": num(get("st-rating")), "kpr": k/nrounds, "adr": num(get("st-adr", False)),
                             "dpr": d/nrounds, "kast": num(get("st-kast", False)), "mk": 100*num(get("st-mks"))/nrounds,
                             "swing": num(get("st-roundSwing")), "kpr_eco": ek/nrounds, "adr_eco": num(get("st-adr", True)),
                             "dpr_eco": ed/nrounds, "kast_eco": num(get("st-kast", True)),
                             "mk_eco": num(get("st-mks"))/nrounds})
    return rows

def fit(rows: list[dict], features: tuple[str, ...]) -> dict:
    x = np.array([[r[f] for f in features] for r in rows], float); y = np.array([r["rating"] for r in rows])
    ok = np.isfinite(x).all(1) & np.isfinite(y); x, y = x[ok], y[ok]
    mean, sd = x.mean(0), x.std(0, ddof=0); z = (x-mean)/sd
    poly = PolynomialFeatures(2, include_bias=True)
    design = poly.fit_transform(z); coef = np.linalg.lstsq(design, y, rcond=None)[0]; pred=design@coef; res=y-pred
    ss=float(res@res); total=float(((y-y.mean())**2).sum())
    return {"n": len(y), "features": list(features), "means": dict(zip(features,mean.tolist())), "sds": dict(zip(features,sd.tolist())),
            "intercept": float(coef[0]), "terms": dict(zip(poly.get_feature_names_out(features).tolist(),coef.tolist())),
            "mae": float(np.abs(res).mean()), "rmse": float(np.sqrt(np.mean(res**2))),
            "r2": float(1-ss/total), "r": float(np.corrcoef(y,pred)[0,1]), "max": float(np.abs(res).max()), "predictions": pred.tolist(), "indices": np.flatnonzero(ok).tolist()}

def predict_fit(rows: list[dict], result: dict) -> np.ndarray:
    features=tuple(result["features"]); z=np.array([[(r[f]-result["means"][f])/result["sds"][f] for f in features] for r in rows],float)
    poly=PolynomialFeatures(2,include_bias=True); design=poly.fit_transform(z)
    return design@np.array([result["terms"][n] for n in poly.get_feature_names_out(features)])

def career_rows(path: Path) -> list[dict]:
    out=[]
    for card in json.loads(path.read_text(encoding="utf-8")):
        if "cells" not in card: continue
        c=card["cells"];out.append({"player":card["name"],"rating":float(card["rating3"]),"kpr":num(c["KPR"]["trad"]),"adr":num(c["ADR"]["trad"]),"dpr":num(c["DPR"]["trad"]),"kast":num(c["KAST"]["trad"]),"mk":num(c["Multi-kill"]["trad"]),"swing":num(c["Round swing"]["trad"]),"kpr_eco":num(c["KPR"]["eco"]),"adr_eco":num(c["ADR"]["eco"]),"dpr_eco":num(c["DPR"]["eco"]),"kast_eco":num(c["KAST"]["eco"]),"mk_eco":num(c["Multi-kill"]["eco"])})
    return out

def main() -> None:
    ap=argparse.ArgumentParser();ap.add_argument("--hltv",type=Path,required=True);ap.add_argument("--career",type=Path,required=True);ap.add_argument("--params",type=Path,required=True);ap.add_argument("--golden",type=Path,required=True);ap.add_argument("--out",type=Path,required=True);a=ap.parse_args()
    rows=map_rows(a.hltv); eco=("kpr_eco","adr_eco","dpr_eco","kast_eco","mk","swing"); fit_result=fit(rows,eco); raw=fit(rows,FEATURES); career=career_rows(a.career); career_for_model=[{**r,"mk":r["mk"]} for r in career]; career_pred=predict_fit(career_for_model,fit_result); career_y=np.array([r["rating"] for r in career]); career_result={"n":len(career),"mae":float(np.abs(career_y-career_pred).mean()),"rmse":float(np.sqrt(np.mean((career_y-career_pred)**2))),"r2":float(1-((career_y-career_pred)@(career_y-career_pred))/((career_y-career_y.mean())@(career_y-career_y.mean()))),"r":float(np.corrcoef(career_y,career_pred)[0,1]),"max":float(np.abs(career_y-career_pred).max())}
    payload=json.loads(a.params.read_text(encoding="utf8")) if a.params.exists() else {"version":1};payload["rating"]= {"version":"3.02","features":"eco_zscore","basis":"degree_2_polynomial_with_interactions","standardisation":{"means":fit_result["means"],"sds":fit_result["sds"]},"terms":fit_result["terms"],"intercept":fit_result["intercept"],"fit":{"map_player_rows":fit_result["n"],"mae":fit_result["mae"],"rmse":fit_result["rmse"],"r2":fit_result["r2"]},"career_fit":{"rows":career_result["n"],"mae":career_result["mae"],"rmse":career_result["rmse"],"r2":career_result["r2"]},"raw_fit":{"features":raw["features"],"means":raw["means"],"sds":raw["sds"],"terms":raw["terms"],"intercept":raw["intercept"],"mae":raw["mae"],"r2":raw["r2"]}}
    a.params.write_text(json.dumps(payload,separators=(",",":"))+"\n",encoding="utf8")
    golden=[]
    for i in np.linspace(0,len(rows)-1,30,dtype=int):
        r=rows[i];z={f:(r[f+"_eco"] if f in {"kpr","adr","dpr","kast"} else r[f]) for f in FEATURES}; names=tuple(f+"_eco" if f in {"kpr","adr","dpr","kast"} else f for f in FEATURES); zv=np.array([(z[f]-fit_result["means"][n])/fit_result["sds"][n] for f,n in zip(FEATURES,names)]); design=PolynomialFeatures(2,include_bias=True).fit_transform(zv[None,:])[0];pred=float(design@np.array([fit_result["terms"][n] for n in PolynomialFeatures(2,include_bias=True).fit(np.zeros((1,6))).get_feature_names_out(names)]));golden.append({"map":r["map"],"player":r["player"],"inputs":z,"hltv":r["rating"],"reference":float(max(0,pred))})
    a.golden.write_text(json.dumps(golden,indent=2)+"\n",encoding="utf8");a.out.write_text(json.dumps({"maps":len(rows),"eco":fit_result,"raw":raw,"career":career_result},indent=2)+"\n",encoding="utf8")
    print(json.dumps({"maps":len(rows),"eco":{k:fit_result[k] for k in ['n','mae','rmse','r2','max']},"raw":{k:raw[k] for k in ['n','mae','rmse','r2','max']},"career":{k:career_result[k] for k in ['n','mae','rmse','r2','max']}},indent=2))
if __name__=="__main__":main()
