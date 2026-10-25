// A front-facing human figure for hits by body part, proportioned like a CS2 agent standing: head,
// neck, chest, stomach, two arms and two legs are separate paths, each shaded cream by its share of
// hits (the most-hit region full, an unhit one the panel colour).
import type { BodyShare } from "../../components/charts";

// Front view, about eight heads tall (head 57 of 468 units), shoulders a little under two heads wide,
// arms hanging slightly away from the torso so each region reads on its own. One side is drawn; the
// other mirrors it. Seams are the background-coloured stroke between regions.
const HEAD = "M100 8C114 8 124 18 124 33C124 41 122 48 119 53C116 59 109 65 100 65C91 65 84 59 81 53C78 48 76 41 76 33C76 18 86 8 100 8Z";
const NECK = "M89 58C93 62 96 65 100 65C104 65 107 62 111 58L114 79C108 83 92 83 86 79Z";
const CHEST = "M86 79C92 83 108 83 114 79C121 81 130 85 137 89C142 92 145 95 147 99C148 104 148 108 148 112C147 118 146 123 145 128C144 136 144 144 144 150C143 160 140 170 138 178L62 178C60 170 57 160 56 150C56 144 56 136 55 128C54 123 53 118 52 112C52 108 52 104 53 99C55 95 58 92 63 89C70 85 79 81 86 79Z";
const STOMACH = "M62 180L138 180C137 192 136 204 136 216C137 230 140 244 143 258C129 266 115 270 100 270C85 270 71 266 57 258C60 244 63 230 64 216C64 204 63 192 62 180Z";
const ARM = "M63 89C56 89 46 93 41 100C37 106 36 114 36 124C36 134 36 144 36 152C35 170 34 188 34 204C33 222 31 240 30 260C30 270 30 278 30 286C29 294 28 304 29 312C30 320 34 325 38 324C42 323 43 318 42 310C41 302 41 294 41 287C42 274 44 262 45 250C47 236 48 222 49 206C50 192 51 180 52 168C53 158 53 148 54 140C54 136 55 132 55 128C56 116 58 100 63 89Z";
const LEG = "M57 260C71 268 85 272 98 272L98 284C97 300 95 316 94 332C93 344 91 354 90 364C90 376 91 386 91 396C91 412 89 432 87 450C87 454 87 456 87 458C90 462 96 466 97 471C97 474 94 476 90 476L69 476C64 476 62 472 65 468C68 464 71 460 72 455C71 446 67 430 63 416C60 406 59 398 60 388C61 380 62 372 62 364C61 350 59 334 58 318C57 300 56 280 57 260Z";

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
