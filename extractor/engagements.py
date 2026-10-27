"""Encounter windows (the engagements tables) and offline visibility for schema v1.

An engagement is one attacker facing one victim (opposite teams). It is
triggered by any of:
  (a) a mesh-visibility onset between the two (both alive): the eye-to-eye
      segment becomes clear of the map's collision mesh;
  (b) a shot by the attacker while the victim is mesh-visible and within the
      attacker's 60 degree view cone (30 degrees either side of the view ray);
  (c) any damage or kill by the attacker on the victim.
Triggers of one ordered pair less than MERGE_S apart extend the same
engagement. Its window runs from PRE_S before the first trigger to POST_S after
the last, inside the round (freeze end to round end), and is capped at CAP_S
from its start; a capped window is marked truncated and the next trigger opens
a new engagement. Hit-only windows would drop encounters where nobody lands a
shot, which biases reaction, pre-aim and spray metrics.

Visibility is computed from the two players' eye positions:
- mesh_visible (per engagement tick, directed): an awpy VisibilityChecker
  raycast, attacker eye to victim eye, or attacker eye to victim chest when the
  eye ray is blocked. Doors, props and breakables in their live state are not
  in the mesh.
- Onsets (trigger a) use the eye-to-eye ray only, sampled every ONSET_STRIDE
  ticks and recomputed at every tick between two samples that differ, so each
  onset lands on its exact tick; a sight shorter than ONSET_STRIDE ticks can be
  missed.
- smoke_blocked: an approximation. Each smoke is a sphere of SMOKE_RADIUS
  centred SMOKE_HEIGHT above its detonation point, the defaults of awpy 3.1.1's
  map_control; the eye-to-eye segment is blocked while it passes through an
  active sphere. On fixture B (Ancient) it flags 8 of 13
  kills the game marked thrusmoke and 10 of 125 it did not.
"""

from __future__ import annotations

import zlib

import numpy as np
import pandas as pd

PRE_S = 1.0
POST_S = 1.0
MERGE_S = 1.5
CAP_S = 8.0
VIEW_HALF_ANGLE_DEG = 30.0
ONSET_STRIDE = 4

# Eye height above the pawn origin: 64 standing, 46 fully ducked, linear in duck_amount. On the
# fixture B (Ancient), fire_bullets eye origins sit at median 63.2 / p95 64.0 above
# the origin standing and 45.2 / 46.0 ducked (a linear fit gives 62.8 - 18.1 * duck).
EYE_STANDING = 64.0
EYE_DUCK_DROP = 18.0
# Chest target for the fallback ray, an approximation (no hitbox data in the demo).
CHEST_BELOW_EYE = 16.0
SMOKE_RADIUS = 144.0
SMOKE_HEIGHT = 60.0


def eye_z(z, duck_amount):
    return z + EYE_STANDING - EYE_DUCK_DROP * duck_amount


def bot_id(user_id: int, name: str) -> int:
    """Player id for a bot, which has no SteamID: 2**32 * (user_id + 1) + crc32(name).

    Always below 2**40, so it can never collide with a SteamID64 (about 7.6e16).
    """
    return ((int(user_id) + 1) << 32) | zlib.crc32(name.encode("utf-8"))


def group_triggers(trig: pd.DataFrame, bounds: dict[int, tuple[int, int]], rate: float) -> pd.DataFrame:
    """Group triggers (round, attacker_steamid, victim_steamid, tick) into engagement windows.

    bounds maps a round to its (first, last) live tick.
    """
    cols = ["engagement_id", "round", "attacker_steamid", "victim_steamid", "start_tick", "end_tick", "truncated"]
    pre, post, merge, cap = (int(round(x * rate)) for x in (PRE_S, POST_S, MERGE_S, CAP_S))
    rows = []
    t = trig.drop_duplicates().sort_values(["round", "attacker_steamid", "victim_steamid", "tick"], kind="stable")
    for (rnd, a, v), g in t.groupby(["round", "attacker_steamid", "victim_steamid"], sort=False):
        lo, hi = bounds[int(rnd)]
        ticks = [int(x) for x in g.tick if lo <= x <= hi]
        prev_end = lo - 1
        i = 0
        while i < len(ticks):
            start = max(ticks[i] - pre, lo, prev_end + 1)
            cap_end = start + cap
            last, truncated, j = ticks[i], False, i + 1
            while j < len(ticks) and ticks[j] - last < merge:
                if ticks[j] > cap_end:
                    truncated = True
                    break
                last = ticks[j]
                j += 1
            end = min(last + post, hi)
            if end > cap_end:
                end, truncated = cap_end, True
            rows.append((int(rnd), a, v, start, end, truncated))
            prev_end, i = end, j
            while i < len(ticks) and ticks[i] <= prev_end:  # a trigger already inside the window
                i += 1
    e = pd.DataFrame(rows, columns=cols[1:])
    e.insert(0, "engagement_id", np.arange(len(e), dtype=np.int32))
    for c in ("attacker_steamid", "victim_steamid"):
        e[c] = pd.array(e[c], dtype="UInt64")
    return e[cols]


def window_ticks(eng: pd.DataFrame) -> pd.DataFrame:
    """One row per (engagement, tick) from start_tick to end_tick inclusive."""
    n = (eng.end_tick - eng.start_tick + 1).to_numpy()
    ids = np.repeat(eng.engagement_id.to_numpy(), n)
    starts = np.repeat(eng.start_tick.to_numpy(), n)
    offset = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
    return pd.DataFrame({"engagement_id": ids, "tick": starts + offset})


def in_view_cone(a_eye: np.ndarray, pitch: np.ndarray, yaw: np.ndarray, v_eye: np.ndarray) -> np.ndarray:
    """Whether v_eye lies within VIEW_HALF_ANGLE_DEG of the view ray from a_eye (CS angles: pitch down +)."""
    p, y = np.radians(pitch), np.radians(yaw)
    view = np.stack([np.cos(p) * np.cos(y), np.cos(p) * np.sin(y), -np.sin(p)], axis=1)
    to = v_eye - a_eye
    norm = np.linalg.norm(to, axis=1)
    cos = np.einsum("ij,ij->i", view, to) / np.where(norm > 0, norm, 1.0)
    return (norm > 0) & (cos >= np.cos(np.radians(VIEW_HALF_ANGLE_DEG)))


def segment_hits_sphere(a: np.ndarray, b: np.ndarray, center: np.ndarray, radius: float) -> np.ndarray:
    """For row-wise segments a->b (N x 3) and one sphere, whether each segment passes within radius."""
    ab = b - a
    denom = np.einsum("ij,ij->i", ab, ab)
    t = np.where(denom > 0, np.einsum("ij,ij->i", center - a, ab) / np.where(denom > 0, denom, 1.0), 0.0)
    closest = a + np.clip(t, 0.0, 1.0)[:, None] * ab
    return np.einsum("ij,ij->i", closest - center, closest - center) < radius * radius


def smoke_blocked(ticks: np.ndarray, a_eye: np.ndarray, v_eye: np.ndarray, smokes: pd.DataFrame) -> np.ndarray:
    """smokes needs start_tick, end_tick (null = never expired in the demo), x, y, z."""
    out = np.zeros(len(ticks), dtype=bool)
    for s in smokes.itertuples():
        end = np.inf if pd.isna(s.end_tick) else s.end_tick
        live = (ticks >= s.start_tick) & (ticks <= end)
        if live.any():
            c = np.array([s.x, s.y, s.z + SMOKE_HEIGHT])
            out[live] |= segment_hits_sphere(a_eye[live], v_eye[live], c, SMOKE_RADIUS)
    return out


def mesh_visible(checker, a_eye: np.ndarray, v_eye: np.ndarray) -> np.ndarray:
    """Directed: attacker eye to victim eye, falling back to victim chest when the eye ray is blocked."""
    out = np.zeros(len(a_eye), dtype=bool)
    for i, (a, v) in enumerate(zip(a_eye.tolist(), v_eye.tolist())):
        out[i] = checker.is_visible(a, v) or checker.is_visible(a, (v[0], v[1], v[2] - CHEST_BELOW_EYE))
    return out


def visibility_onsets(checker, eye: np.ndarray, alive: np.ndarray, pairs: list[tuple[int, int]]) -> list:
    """Onset ticks (indices into eye's first axis) of eye-to-eye visibility for each player pair.

    eye: T x P x 3 eye positions, alive: T x P. Returns (tick_index, i, j) for each onset.
    """
    T = eye.shape[0]
    if T == 0 or not pairs:
        return []

    # Python lists once per round: indexing the arrays per call cost more than the raycasts (5.4 s of 8.1 s on a
    # 53-round demo, 1.65M calls).
    eyes, live = eye.tolist(), alive.tolist()

    def clear(t, i, j):
        return bool(live[t][i] and live[t][j]) and checker.is_visible(eyes[t][i], eyes[t][j])

    samples = list(range(0, T, ONSET_STRIDE))
    if samples[-1] != T - 1:
        samples.append(T - 1)
    out = []
    for i, j in pairs:
        sv = [clear(t, i, j) for t in samples]
        vis = np.zeros(T, dtype=bool)
        for (s0, b0), (s1, b1) in zip(zip(samples, sv), zip(samples[1:], sv[1:])):
            vis[s0] = b0
            if b0 == b1:
                vis[s0 + 1:s1] = b0
            else:
                for t in range(s0 + 1, s1):
                    vis[t] = clear(t, i, j)
        vis[samples[-1]] = sv[-1]
        on = np.flatnonzero(vis & ~np.concatenate([[False], vis[:-1]]))
        out.extend((int(t), i, j) for t in on)
    return out
