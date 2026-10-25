"""Fit the provisional duel table to HLTV eco K/D/ADR cells on strict demo joins."""
from __future__ import annotations
import argparse,json,re
from collections import defaultdict
from pathlib import Path
import numpy as np
from scipy.optimize import least_squares, minimize
import pyarrow.parquet as pq

groups=('sniper','rifle1','rifle2','smg','pistolPlus','pistol');index={g:i for i,g in enumerate(groups)}
def norm(s):return re.sub(r'[^a-z0-9]','',str(s).lower())
def weapon_group(w):
 w=norm(w)
 if any(x in w for x in ('awp','g3sg1','scar20')):return 'sniper'
 if any(x in w for x in ('ak47','m4a1','aug','sg556')):return 'rifle1'
 if any(x in w for x in ('galilar','famas','ssg08','ssg08')):return 'rifle2'
 if any(x in w for x in ('mac10','mp9','mp7','mp5sd','ump45','p90','bizon','nova','xm1014','sawedoff','mag7','m249','negev')):return 'smg'
 if any(x in w for x in ('deagle','revolver','p250','fiveseven','tec9','cz75','dualberetta')):return 'pistolPlus'
 if any(x in w for x in ('glock','hkp2000','usps','usp')):return 'pistol'
 return None
def sigmoid(x):return 1/(1+np.exp(-np.clip(x,-40,40)))
def collect(root,joins):
 rows=[];duels=[]
 for join in joins:
  directory=root/join['demo'];
  if not (directory/'economy.parquet').exists():continue
  h=json.loads((root/'hltv'/join['hltv']).read_text(encoding='utf8'))
  econ=pq.read_table(directory/'economy.parquet').to_pylist(); names={r['steamid']:norm(r['name']) for r in econ}
  by_name={v:k for k,v in names.items()}; round_player={(r['round'],r['steamid']):r for r in econ}
  starts={(r['round'],r['steamid']):weapon_group(r['best_primary'] or r['best_secondary']) or ('pistolPlus' if r['armor'] else 'pistol') for r in econ}
  kills=pq.read_table(directory/'kills.parquet').to_pylist(); damages=pq.read_table(directory/'damages.parquet').to_pylist()
  map_rows={norm(r['player']):r for b in h['scoreboards'] if 'totalstats' in b['cls'].split() for r in b['rows']}
  rounds=max(r['round'] for r in econ)
  totals=defaultdict(lambda: {'k':0.,'d':0.,'adr':0.,'rounds':rounds,'raw_mk':0})
  for k in kills:
   if k['is_suicide'] or k['is_teamkill'] or not k['attacker_steamid'] or k['attacker_steamid'] not in names or k['victim_steamid'] not in names:continue
   ag=weapon_group(k['a_active_weapon']) or starts.get((k['round'],k['attacker_steamid']))
   vg=weapon_group(k['v_active_weapon']) or starts.get((k['round'],k['victim_steamid']))
   if not ag or not vg:continue
   duels.append({'a':ag,'v':vg,'side':k['a_side'],'map':join['hltv']})
  for d in damages:
   if d['is_self'] or d['is_team_damage'] or d['attacker_steamid'] not in names or d['victim_steamid'] not in names:continue
   ag=weapon_group(d['weapon']) or starts.get((d['round'],d['attacker_steamid']));vg=starts.get((d['round'],d['victim_steamid']))
   if not ag or not vg:continue
   rows.append({'map':join['hltv'],'player':names[d['attacker_steamid']],'victim':names[d['victim_steamid']],'a':ag,'v':vg,'side':d['a_side'],'dmg':float(d['dmg_health_capped']),'kill':False})
  for k in kills:
   if k['is_suicide'] or k['is_teamkill'] or k['attacker_steamid'] not in names or k['victim_steamid'] not in names:continue
   ag=weapon_group(k['a_active_weapon']) or starts.get((k['round'],k['attacker_steamid']));vg=weapon_group(k['v_active_weapon']) or starts.get((k['round'],k['victim_steamid']))
   if ag and vg: rows.append({'map':join['hltv'],'player':names[k['attacker_steamid']],'victim':names[k['victim_steamid']],'a':ag,'v':vg,'side':k['a_side'],'dmg':None,'kill':True})
  # Targets are attached at fit time by player name.
  for name,r in map_rows.items():
   def cell(prefix,eco=False):
    for c in r['cells']:
     if prefix in c[0] and ('eco-adjusted-data' in c[0])==eco:return c[1]
   def number(x):return float(x.replace('%','').replace('+',''))
   def kd(x):return float(x.split()[0].split(':')[0])
   rows.append({'target':'player','map':join['hltv'],'player':name,'ek':kd(cell('st-kills',True)),'ed':kd(cell('st-deaths',True)),'eadr':number(cell('st-adr',True)),'rounds':rounds})
 return rows,duels

def fit_model(root: Path, joins: list[dict]) -> dict:
    raw, duels = collect(root, joins)
    targets = [row for row in raw if row.get("target") == "player"]
    events = [row for row in raw if row.get("target") != "player"]

    def unpack(parameters):
        return np.r_[parameters[:5], 0.0], parameters[5]

    def probability(parameters, attacker, victim, side):
        strengths, _ = unpack(parameters)
        edge = -np.log(0.48 / 0.52)
        return sigmoid(strengths[index[attacker]] - strengths[index[victim]] + (edge if side == "CT" else -edge))

    def residual(parameters):
        strengths, scale = unpack(parameters)
        predicted = defaultdict(lambda: {"k": 0.0, "d": 0.0, "adr": 0.0})
        for event in events:
            points = scale * (1 - probability(parameters, event["a"], event["v"], event["side"]))
            if event.get("kill"):
                predicted[(event["map"], event["player"])]["k"] += points
                predicted[(event["map"], event["victim"])]["d"] += points
            if event.get("dmg") is not None:
                predicted[(event["map"], event["player"])]["adr"] += event["dmg"] * points
        output = []
        for target in targets:
            values = predicted[(target["map"], target["player"])]
            output.extend([
                (values["k"] - target["ek"]) * 0.2,
                (values["d"] - target["ed"]) * 0.2,
                (values["adr"] / target["rounds"] - target["eadr"]) * 0.05,
            ])
        return output

    initial = np.array([1.5, 1.18, 0.83, 0.56, 0.29, 2.14])
    result = least_squares(residual, initial, bounds=([-4] * 5 + [0.1], [4] * 5 + [8]), max_nfev=1000)
    strengths, scale = unpack(result.x)
    return {
        "source": {
            "source": "fit",
            "script": "eco_fit.py",
            "accepted_joins": len(joins),
            "duels": len(duels),
            "targets": len(targets),
        },
        "groups": list(groups),
        "strength": dict(zip(groups, strengths.tolist())),
        "ct_edge": float(-np.log(0.48 / 0.52)),
        "kill_points_scale": float(scale),
        "duels": len(duels),
        "targets": len(targets),
        "objective_mae": float(np.mean(np.abs(residual(result.x)))),
        "status": "joint fit to eK/eD/eADR; validate exact display rounding before shipping",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--joins", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    joins = json.loads(args.joins.read_text(encoding="utf-8"))["accepted"]
    result = fit_model(args.data, joins)
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
if __name__=='__main__':main()
