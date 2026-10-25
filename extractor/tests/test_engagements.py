import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import engagements as eg  # noqa: E402
import extract as ex  # noqa: E402

A, B = 11, 22
RATE = 64.0


def _trig(ticks, rnd=1, a=A, v=B):
    df = pd.DataFrame(dict(round=rnd, attacker_steamid=a, victim_steamid=v, tick=ticks))
    return df.astype({"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})


def _windows(eng):
    return eng[["start_tick", "end_tick", "truncated"]].values.tolist()


def test_triggers_under_1_5_s_apart_share_a_window_padded_1_s_and_clipped_to_the_round():
    # 1000 and 1095 are 1.48 s apart (merge); 1191 is 1.5 s after 1095 (new window).
    eng = eg.group_triggers(_trig([1000, 1095, 1191]), {1: (980, 1200)}, RATE)
    assert _windows(eng) == [[980, 1159, False], [1160, 1200, False]]


def test_window_is_capped_at_8_s_and_the_next_trigger_opens_a_new_one():
    ticks = list(range(1000, 1700, 64))  # a trigger every second for 11 s
    eng = eg.group_triggers(_trig(ticks), {1: (0, 10_000)}, RATE)
    assert _windows(eng) == [[936, 1448, True], [1449, 1704, False]]


def test_view_cone_is_30_degrees_either_side_and_pitch_down_is_positive():
    a = np.zeros((4, 3))
    deg = np.radians
    v = np.array([[np.cos(deg(29)), np.sin(deg(29)), 0], [np.cos(deg(31)), np.sin(deg(31)), 0],
                  [1, 0, -1.0], [1, 0, 1.0]])
    # looking along +x level; then two rows looking 45 degrees down (pitch +45) at targets below / above
    pitch = np.array([0.0, 0.0, 45.0, 45.0])
    assert eg.in_view_cone(a, pitch, np.zeros(4), v).tolist() == [True, False, True, False]


class _Wall:
    """Stand-in geometry: the eye-to-eye ray is clear from tick `opens` on."""

    def __init__(self, opens):
        self.opens = opens

    def is_visible(self, a, b):
        return a[0] >= self.opens


def test_onsets_land_on_the_exact_tick_between_stride_samples_and_need_both_players_alive():
    T = 20
    eye = np.zeros((T, 3, 3))
    eye[:, :, 0] = np.arange(T)[:, None]  # x carries the tick so the stand-in knows it
    alive = np.ones((T, 3), dtype=bool)
    alive[:, 2] = False  # player 2 is dead: no onset for pairs with them
    onsets = eg.visibility_onsets(_Wall(opens=10), eye, alive, [(0, 1), (0, 2)])
    assert onsets == [(10, 0, 1)]


def test_bot_ids_never_collide_with_steamids_and_human_ids_are_kept():
    bots = {"Bot Alex": eg.bot_id(3, "Bot Alex"), "Bot Ben": eg.bot_id(4, "Bot Ben")}
    assert max(bots.values()) < 76561197960265728 and len(set(bots.values())) == 2
    ids = ex.resolve_ids(pd.Series([76561190000000001, 0, 0], dtype="uint64"),
                         pd.Series(["human", "Bot Alex", "Bot Unknown"]), bots)
    assert ids.tolist()[:2] == [76561190000000001, bots["Bot Alex"]] and ids.isna().tolist()[2]


def test_smoke_blocks_only_segments_through_a_live_sphere():
    smokes = pd.DataFrame(dict(start_tick=[100], end_tick=[200], x=[0.0], y=[0.0], z=[-60.0]))  # centre z=0
    a = np.array([[-500.0, 0, 0], [-500.0, 0, 0], [-500.0, 0, 0], [-500.0, 300, 0]])
    b = np.array([[500.0, 0, 0], [-200.0, 0, 0], [500.0, 0, 0], [500.0, 300, 0]])
    ticks = np.array([150, 150, 250, 150])
    # through the centre / stops 200 short of the sphere / smoke expired / passes 300 > 144 away
    assert eg.smoke_blocked(ticks, a, b, smokes).tolist() == [True, False, False, False]
