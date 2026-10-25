"""Join post-plant HLTV event points to demo ticks and test defuse timing rules."""
from __future__ import annotations
import argparse,json,re
from collections import defaultdict
from pathlib import Path

def norm(s):return re.sub(r"[^a-z0-9]", "", s.lower())
def read_join(root,join):
 import pyarrow.parquet as pq
 demo=root/join['demo']; hltv=json.loads((root/'hltv'/join['hltv']).read_text(encoding='utf8'))
 economy=pq.read_table(demo/'economy.parquet').to_pylist(); names={r['steamid']:norm(r['name']) for r in economy}; sid={v:k for k,v in names.items()}
 rounds={r['round']:r for r in pq.read_table(demo/'rounds.parquet').to_pylist()}; kills=defaultdict(list)
 tick_rate=pq.read_table(demo/'meta.parquet',columns=['tick_rate']).to_pylist()[0]['tick_rate']
 for k in sorted(pq.read_table(demo/'kills.parquet').to_pylist(),key=lambda x:x['tick']):kills[k['round']].append(k)
 players={norm(p['nick']):p for p in hltv['performance']['players']}
 out=[]
 for rn,rd in hltv['performance']['rounds'].items():
  rnum=int(rn[5:]); rr=rounds[rnum]; dk=kills[rnum];ki=0;plant=None
  kit_holders={r['steamid'] for r in economy if r['round']==rnum and r['side']=='CT' and r['defuser']}
  alive=set(r['steamid'] for r in economy if r['round']==rnum)
  for idx,e in enumerate(rd['events']):
   tick=None; victim=None
   if e['icon']=='bombplant.svg':
    plant=rr['plant_tick']; tick=plant
   elif ' killed ' in e['title']:
    a,v=map(norm,e['title'].split(' killed ',1));
    while ki<len(dk) and (dk[ki]['is_suicide'] or dk[ki]['is_teamkill'] or norm(names.get(dk[ki]['attacker_steamid'],'?'))!=a or norm(names.get(dk[ki]['victim_steamid'],'?'))!=v):ki+=1
    if ki<len(dk):tick=dk[ki]['tick'];victim=dk[ki]['victim_steamid'];ki+=1
   elif e['icon'] in {'bomb_exploded.svg','bomb_defused.svg','stopwatch.svg'}:tick=rr['end_tick']
   if victim is not None:
    alive.discard(victim);kit_holders.discard(victim)
   if plant is not None and tick is not None and tick>=plant:
    explosion_tick=rr['explode_tick'] if rr['explode_tick'] is not None else plant+40*tick_rate
    kits=sum(s in alive for s in kit_holders)
    out.append({'map':join['hltv'],'round':rnum,'index':idx,'icon':e['icon'],'title':e['title'],'badge':e.get('badge'),'tick':tick,'plant_tick':plant,'end_tick':rr['end_tick'],'explosion_tick':explosion_tick,'seconds_left':(explosion_tick-tick)/tick_rate,'kits_alive':kits,'y':float(e['y']),'alive':e['alive'],'side':rd['side'],'reason':rr['reason']})
 return out

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--data',type=Path,required=True);ap.add_argument('--joins',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);a=ap.parse_args()
 import pyarrow.parquet
 joins=json.loads(a.joins.read_text())['accepted']; rows=[]
 for j in joins:
  if (a.data/j['demo']/'economy.parquet').exists(): rows+=read_join(a.data,j)
 # For each nonterminal postplant point, determine whether later HLTV y changes.
 by=defaultdict(list)
 for r in rows:by[(r['map'],r['round'])].append(r)
 for v in by.values():v.sort(key=lambda x:x['index'])
 for v in by.values():
  for i,r in enumerate(v):
   r['next_y']=v[i+1]['y'] if i+1<len(v) else None;r['changed_after']=r['next_y'] is not None and abs(r['next_y']-r['y'])>1e-12
 # Candidate thresholds by kit status. Compare constant after threshold and report errors.
 import numpy as np
 candidates={}
 for kit in range(6):
  for threshold in np.arange(0,20.01,.25):
   test=[r for r in rows if r['icon']=='kill.svg' and r['kits_alive']==kit]
   low=[r for r in test if r['seconds_left']<=threshold]
   high=[r for r in test if r['seconds_left']>threshold]
   candidates[f'kit{kit}_threshold{threshold:g}']={'n':len(test),'threshold':float(threshold),'kit':kit,'low_n':len(low),'low_unchanged':sum(not r['changed_after'] for r in low),'high_n':len(high),'high_unchanged':sum(not r['changed_after'] for r in high)}
 result={'rows':len(rows),'rounds':len(by),'postplant_rounds':len(by),'events_changed_after_plant':sum(r['changed_after'] for r in rows),'rows':rows,'candidate_thresholds':candidates}
 a.out.write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
 print(json.dumps({'rows':len(rows),'rounds':len(by),'events_changed_after_plant':result['events_changed_after_plant']},indent=2))
if __name__=='__main__':main()
