"""join_demos pairs demo players with HLTV players by the kills (structural_mapping). Synthetic: no real player."""
from __future__ import annotations

import unittest

import join_demos

# Two teams of three. Demo players are steamids 1-6, HLTV players nicknames; HLTV's kills per round, in order.
TEAMS = {1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1}


def hltv(kills_by_round: dict[int, list[tuple[str, str]]], counts: dict[str, int]) -> dict:
    team = {"alpha": 0, "bravo": 0, "charlie": 0, "delta": 1, "echo": 1, "fox": 1}
    return {"kills": kills_by_round,
            "players": {n: {"pid": str(100 + i), "team": team[n], "kills": counts.get(n, 0)} for i, n in enumerate(team)}}


def demo_counts(sequences: dict[int, list[tuple[int, int]]]) -> dict[int, int]:
    out: dict[int, int] = {}
    for kills in sequences.values():
        for a, _ in kills:
            out[a] = out.get(a, 0) + 1
    return out


# Round 1: alpha kills delta, echo kills bravo. Round 2: charlie kills echo, fox kills alpha, charlie kills fox.
HLTV_KILLS = {1: [("alpha", "delta"), ("echo", "bravo")], 2: [("charlie", "echo"), ("fox", "alpha"), ("charlie", "fox")]}
HLTV_COUNTS = {"alpha": 1, "echo": 1, "charlie": 2, "fox": 1}
DEMO = {1: [(1, 4), (5, 2)], 2: [(3, 5), (6, 1), (3, 6)]}


class StructuralMapping(unittest.TestCase):
    def test_players_whose_in_game_names_differ_from_hltv_join_by_their_kills(self):
        # The name join refused any map with a renamed player (39% of OpenCS2 maps, and HLTV ones such as a player
        # listed as tyra who plays as 1tyra); the kills place every player here without a single name in common.
        names = {1: "alpha1", 2: "xbravo", 3: "chuck", 4: "d3lta", 5: "echo_", 6: "f0x"}
        pairs, why = join_demos.structural_mapping(DEMO, TEAMS, names, demo_counts(DEMO), hltv(HLTV_KILLS, HLTV_COUNTS), {})
        self.assertIsNone(why)
        self.assertEqual(pairs, {1: "alpha", 2: "bravo", 3: "charlie", 4: "delta", 5: "echo", 6: "fox"})

    def test_a_pair_the_kills_contradict_is_refused_with_the_kill(self):
        # Round 2's HLTV kills name echo and fox the other way round from what round 1 established: no single pairing
        # holds, and a swap must not be accepted by trusting the later kills.
        swapped = {1: HLTV_KILLS[1], 2: [("charlie", "fox"), ("echo", "alpha"), ("charlie", "echo")]}
        pairs, why = join_demos.structural_mapping(DEMO, TEAMS, {}, demo_counts(DEMO), hltv(swapped, HLTV_COUNTS), {})
        self.assertIsNone(pairs)
        self.assertIn("round 2 kill 1", why)

    def test_players_the_kills_cannot_place_are_refused_unless_one_pairing_is_left(self):
        # One kill: alpha kills delta. Bravo and charlie, and echo and fox, have no kill or death and the same kill
        # count (0), so each team has two ways to pair them: refused, not guessed.
        demo = {1: [(1, 4)]}
        kills = {1: [("alpha", "delta")]}
        counts = {"alpha": 1}
        pairs, why = join_demos.structural_mapping(demo, TEAMS, {}, demo_counts(demo), hltv(kills, counts), {})
        self.assertIsNone(pairs)
        self.assertIn("2 ways to pair them", why)
        # An exact name match places them, as the tiebreak for players without a kill or death.
        names = {2: "bravo", 3: "charlie", 5: "echo", 6: "fox"}
        pairs, why = join_demos.structural_mapping(demo, TEAMS, names, demo_counts(demo), hltv(kills, counts), {})
        self.assertIsNone(why)
        self.assertEqual(pairs[2], "bravo")
        # So does a pair learned from an earlier join (steamid to HLTV player id), when names do not.
        learned = {"2": "101", "5": "104"}
        pairs, why = join_demos.structural_mapping(demo, TEAMS, {}, demo_counts(demo), hltv(kills, counts), learned)
        self.assertIsNone(why)
        self.assertEqual((pairs[2], pairs[5]), ("bravo", "echo"))

    def test_a_pairing_that_leaves_a_kill_count_unequal_is_refused(self):
        # HLTV's scoreboard credits charlie with 3 kills; the demo's player paired with him has 2. The kills table and
        # the scoreboard disagree, so the pairing is not trusted.
        counts = dict(HLTV_COUNTS, charlie=3)
        pairs, why = join_demos.structural_mapping(DEMO, TEAMS, {}, demo_counts(DEMO), hltv(HLTV_KILLS, counts), {})
        self.assertIsNone(pairs)
        self.assertIn("pairs with charlie, who has 3 kills on HLTV, not 2", why)


if __name__ == "__main__":
    unittest.main()
