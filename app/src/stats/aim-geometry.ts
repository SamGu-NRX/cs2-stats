// View-angle geometry for the aim family. Angles are degrees in the game's convention: pitch is
// positive looking down, yaw is counterclockwise from +x (SCHEMA-v1.md, Conventions).

const RAD = Math.PI / 180;

/** An angle difference folded into [-180, 180). */
export const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;

/** Unit view direction for a pitch and yaw. */
export function forward(pitch: number, yaw: number): [number, number, number] {
  const cp = Math.cos(pitch * RAD);
  return [cp * Math.cos(yaw * RAD), cp * Math.sin(yaw * RAD), -Math.sin(pitch * RAD)];
}

/** The pitch and yaw that look from `eye` at `target`. */
export function lookAt(eye: [number, number, number], target: [number, number, number]): { pitch: number; yaw: number } {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  return { pitch: -Math.atan2(dz, Math.hypot(dx, dy)) / RAD, yaw: Math.atan2(dy, dx) / RAD };
}

/** Angle in degrees between the view (pitch, yaw) and the ray from `eye` to `target`. */
export function aimAngle(pitch: number, yaw: number, eye: [number, number, number], target: [number, number, number]): number {
  const f = forward(pitch, yaw);
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len === 0) return 0;
  const cos = (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / len;
  return Math.acos(Math.min(1, Math.max(-1, cos))) / RAD;
}

/**
 * The aim error as a 2-D vector in angle space: how far the view must turn to reach the target,
 * [yaw, pitch] in degrees. Yaw is positive turning left, pitch positive turning down. The yaw part is
 * a plain angle difference (not scaled by cos(pitch)), which is within 6% of the true arc for the
 * pitches players aim at (|pitch| under 20 degrees).
 */
export function aimError(pitch: number, yaw: number, eye: [number, number, number], target: [number, number, number]): [number, number] {
  const want = lookAt(eye, target);
  return [wrap180(want.yaw - yaw), want.pitch - pitch];
}
