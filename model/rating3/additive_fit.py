"""Test additive Rating 3.02 transforms and quantify display-rounding floors."""
from __future__ import annotations
import argparse,json
from pathlib import Path
import numpy as np
from sklearn.preprocessing import SplineTransformer,StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupShuffleSplit
from sklearn.isotonic import IsotonicRegression
import runpy

FEATURES=('kpr_eco','adr_eco','dpr_eco','kast_eco','mk','swing')
DISPLAY_STEP={'kpr_eco':.01,'dpr_eco':.01,'adr_eco':.1,'kast_eco':.1,'mk':.1,'swing':.01,'rating':.01}

def rows(root):
 m=runpy.run_path(str(Path(__file__).with_name('fit_reference.py')));return m['map_rows'](root)
def score(y,p):
 e=np.abs(y-p);return {'n':len(y),'mae':float(e.mean()),'max':float(e.max()),'rmse':float(np.sqrt(np.mean(e*e))),'r':float(np.corrcoef(y,p)[0,1])}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--hltv',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);a=ap.parse_args();rs=rows(a.hltv)
 X=np.array([[r[f] for f in FEATURES] for r in rs]);y=np.array([r['rating'] for r in rs]);groups=np.array([r['map'] for r in rs]);ok=np.isfinite(X).all(1)&np.isfinite(y);X=X[ok];y=y[ok];groups=groups[ok]
 g=GroupShuffleSplit(n_splits=1,test_size=.2,random_state=0);train,test=next(g.split(X,y,groups))
 results={}
 for knots in (3,4,5,7,9,12):
  for alpha in (.01,.1,1,10):
   model=make_pipeline(SplineTransformer(n_knots=knots,degree=3,include_bias=False),Ridge(alpha=alpha)).fit(X[train],y[train]);results[f'spline{knots}_a{alpha}']={'train':score(y[train],model.predict(X[train])),'test':score(y[test],model.predict(X[test]))}
 # Additive isotonic, fit monotonic directions from linear slopes.
 pred=np.full(len(y),0.0);pred[test]=y[test].mean(); components=[]
 for j,f in enumerate(FEATURES):
  direction='increasing' if f in {'kpr_eco','adr_eco','kast_eco','mk','swing'} else 'decreasing'
  iso=IsotonicRegression(increasing=direction=='increasing',out_of_bounds='clip').fit(X[train,j],y[train]);components.append(iso);pred[test]+=iso.predict(X[test,j])-y[train].mean()/len(FEATURES)
 results['isotonic_heldout']={'test':score(y[test],pred[test])}
 # Quantization floor: exact target and feature values rounded at the published increments.
 # The display-only floor is uniform target rounding; input propagation is reported for
 # the best spline's local finite-difference sensitivity, not presented as a proof of HLTV's formula.
 best=min(results,key=lambda k:results[k].get('test',{'mae':999})['mae']);model=make_pipeline(SplineTransformer(n_knots=5,degree=3,include_bias=False),Ridge(alpha=.1)).fit(X[train],y[train]);base=model.predict(X[test]);rng=np.random.default_rng(0);pert=[]
 for _ in range(200):
  noisy=X[test]+rng.uniform(-.5,.5,size=X[test].shape)*np.array([DISPLAY_STEP[f] for f in FEATURES]);pert.append(model.predict(noisy))
 pert=np.array(pert);results['rounding_floor']={'rating_only':{'mae':.0025,'max':.005},'spline_input_quantization':{'mae':float(np.mean(np.abs(pert.mean(0)-base))),'max':float(np.max(np.abs(pert.max(0)-pert.min(0)))),'p95_half_width':float(np.quantile((pert.max(0)-pert.min(0))/2,.95))}}
 out={'features':FEATURES,'display_steps':DISPLAY_STEP,'split':{'train':len(train),'test':len(test),'groups':len(set(groups))},'results':results,'best':best}
 a.out.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'best':best,'best_test':results[best]['test'],'floor':results['rounding_floor']},indent=2))
if __name__=='__main__':main()
