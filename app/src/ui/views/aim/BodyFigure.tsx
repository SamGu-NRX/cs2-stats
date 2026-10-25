// A front-facing human figure for hits by body part, about 7.5 heads tall with shoulders, a tapered
// waist, hands and feet: head, neck, chest, stomach, two arms and two legs are separate paths, each
// shaded cream by its share of hits. The figure's left side (the viewer's right) mirrors its right.
import type { BodyShare } from "../../components/charts";

const HEAD = "M100 10C118 10 130 24 130 44C130 61 123 73 113 79L87 79C77 73 70 61 70 44C70 24 82 10 100 10Z";
const NECK = "M87 79L113 79L115 95C107 99 93 99 85 95Z";
const CHEST = "M85 95C93 99 107 99 115 95C129 96 143 100 153 108C157 125 157 147 153 169L149 189L51 189L47 169C43 147 43 125 47 108C57 100 71 96 85 95Z";
const STOMACH = "M51 191L149 191C149 215 151 237 155 259C139 271 121 275 100 275C79 275 61 271 45 259C49 237 51 215 51 191Z";
const ARM = "M45 109C36 113 31 123 29 137C26 159 25 179 23 199C21 221 19 241 17 259C15 273 13 285 14 297C15 306 24 308 27 299C30 289 31 277 33 263C36 243 40 223 43 203C45 187 47 171 48 155C48 139 47 123 45 109Z";
const LEG = "M47 263C62 273 81 279 98 279L98 291C96 325 94 359 92 393C91 419 90 443 90 461C90 466 92 470 95 473L66 473C66 462 66 448 65 434C63 406 61 376 59 346C57 318 52 290 47 263Z";

export function BodyFigure({ share, height = 300 }: { share: BodyShare; height?: number }) {
  const max = Math.max(0.0001, ...Object.values(share));
  const f = (v: number) => (v <= 0 ? "var(--bg2)" : `rgba(255,215,173,${(0.14 + 0.86 * (v / max)).toFixed(3)})`);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const mirror = "translate(200 0) scale(-1 1)";
  return (
    <svg viewBox="0 0 200 480" height={height} width={(height * 200) / 480} className="bodyfig" role="img"
      aria-label={`Hits by body part: head ${pct(share.head)}, neck ${pct(share.neck)}, chest ${pct(share.chest)}, stomach ${pct(share.stomach)}, arms ${pct(share.leftArm + share.rightArm)}, legs ${pct(share.leftLeg + share.rightLeg)}`}>
      <g stroke="var(--bg1)" strokeWidth="2.5" strokeLinejoin="round">
        <path d={ARM} fill={f(share.rightArm)}><title>{`Right arm ${pct(share.rightArm)}`}</title></path>
        <path d={ARM} fill={f(share.leftArm)} transform={mirror}><title>{`Left arm ${pct(share.leftArm)}`}</title></path>
        <path d={LEG} fill={f(share.rightLeg)}><title>{`Right leg ${pct(share.rightLeg)}`}</title></path>
        <path d={LEG} fill={f(share.leftLeg)} transform={mirror}><title>{`Left leg ${pct(share.leftLeg)}`}</title></path>
        <path d={STOMACH} fill={f(share.stomach)}><title>{`Stomach ${pct(share.stomach)}`}</title></path>
        <path d={CHEST} fill={f(share.chest)}><title>{`Chest ${pct(share.chest)}`}</title></path>
        <path d={NECK} fill={f(share.neck)}><title>{`Neck ${pct(share.neck)}`}</title></path>
        <path d={HEAD} fill={f(share.head)}><title>{`Head ${pct(share.head)}`}</title></path>
      </g>
    </svg>
  );
}
