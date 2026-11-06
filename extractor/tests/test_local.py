"""Demos CS2 recorded on this machine (local_import.py): the renamed id, the recording player, the reasons a
demo fails, and the shared import core. A fake demoparser2 parser drives the real extraction stage for the
failure paths; one test extracts a real HLTV fixture from the private data folder and skips without it."""

import hashlib
import json
import logging
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import polars as pl
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import extract as ex  # noqa: E402
import local_import as li  # noqa: E402
import schema_v1  # noqa: E402
import valve_import as vi  # noqa: E402

DATA = Path(os.environ.get("CS2_STATS_DATA") or HERE.parents[2] / "cs2-stats-data")
U1, U2 = vi.STEAMID64_MIN + 1000, vi.STEAMID64_MIN + 2000
BOT_A, BOT_B = ex.bot_id(3, "Ringo"), ex.bot_id(4, "Vitaliy")
# tv_autorecord's name shape: the server name, on a listen server the host's Steam name, comes last. This one
# also parses as "<team1>-vs-<team2>-<map>", so a team name read from it would carry it.
HOST = "Zz-vs-the-zzpersonaqx"
AUTO = f"auto-20261106-0000-de_dust2-{HOST}.dem"


def leaks(text: str) -> list[str]:
    """What of AUTO's name a text holds, without regard to case: its distinctive persona, or its whole stem."""
    return [s for s in ("zzpersonaqx", Path(AUTO).stem.lower()) if s in text.lower()]


def _players(*ids):
    return pd.DataFrame({"steamid": list(ids), "is_bot": [i < 2 ** 40 for i in ids]})


def _fake_extractor(calls: list, players: pd.DataFrame):
    """Stands in for extract.extract_demo: asks for the players' extra as the real one does, then publishes a
    minimal map."""

    def fake(dem, out_dir, source, mapdata=None, archive="", meta_extra=None, name=None, extra_from_players=None):
        calls.append(dict(dem=Path(dem).name, source=source, archive=archive, name=name))
        extra = {**meta_extra, **(extra_from_players(players) if extra_from_players else {})}
        with ex.map_lock(Path(out_dir)):
            tmp = Path(out_dir) / ".tmp-test"
            tmp.mkdir(parents=True)
            pl.DataFrame({"demo_sha256": [ex.file_sha256(dem)], "extractor_version": [ex.EXTRACTOR_VERSION],
                          "extra": [json.dumps(extra)]}).write_parquet(tmp / "match.parquet")
            ex.publish_version(tmp, Path(out_dir), ex.EXTRACTOR_VERSION, ["match.parquet"])
        return dict(ok=True, errors=[], validation={})
    return fake


class WarmupParser:
    """demoparser2's DemoParser over a recording that ends in round 1's freeze time, the shape of the first
    tv_autorecord demo from a listen server: warmup's winnerless round_end at 1112, begin_new_match at 1113, one
    round_freeze_end at 2488, then nothing. `fail` makes it fail to read, with the path in its message, as a
    parser does for a file it cannot open."""

    fail = False

    def __init__(self, path):
        self.path = path

    def parse_header(self):
        if self.fail:
            raise RuntimeError(f"failed to read {self.path}")
        return {"map_name": "de_dust2", "server_name": HOST}

    def list_game_events(self):
        return ["round_start", "round_end", "begin_new_match", "round_freeze_end"]

    def parse_events(self, names, player=None, other=None):
        events = {
            "round_start": pd.DataFrame({"tick": [87]}),
            "round_end": pd.DataFrame({"tick": [1112], "winner": [None], "reason": [None], "total_rounds_played": [0]}),
            "begin_new_match": pd.DataFrame({"tick": [1113]}),
            "round_freeze_end": pd.DataFrame({"tick": [2488]}),
        }
        return [(n, events[n]) for n in names if n in events]


@pytest.fixture
def warmup_demo(monkeypatch):
    """The real extraction stage over WarmupParser, with awpy's stage reduced to the header it sets."""
    import demoparser2

    def awpy(ctx):
        ctx.info["awpy_header"] = {}
        return {}
    monkeypatch.setattr(demoparser2, "DemoParser", WarmupParser)
    monkeypatch.setattr(ex, "STAGES", [("awpy", awpy), ("demoparser2", ex.stage_demoparser2)])
    monkeypatch.setattr(li, "demo_map", lambda dem: "de_dust2")
    return WarmupParser


def _demo(folder: Path, name: str = AUTO, body: bytes = b"a recorded demo") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(body)
    return folder / name


def _run(args, out):
    code = li.main([*map(str, args), "--out", str(out), "--result", str(out.parent / "summary.json")])
    return code, json.loads((out.parent / "summary.json").read_text(encoding="utf-8"))


@pytest.fixture
def dust2(monkeypatch):
    monkeypatch.setattr(li, "demo_map", lambda dem: "de_dust2")


def test_a_recording_that_ends_before_a_round_reports_no_rounds(tmp_path, warmup_demo):
    code, summary = _run([_demo(tmp_path / "replays")], tmp_path / "out")
    row = summary["results"][0]
    assert (code, summary["ok"], row["reason"]) == (1, 0, "no_rounds"), row["errors"]


def test_the_original_name_reaches_no_result_summary_progress_line_or_log(tmp_path, warmup_demo, monkeypatch, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(warmup_demo, "fail", True)
    dem = _demo(tmp_path / "replays")
    li.main([str(dem), "--out", str(tmp_path / "out"), "--progress", "--result", str(tmp_path / "summary.json")])
    summary = json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))
    row = summary["results"][0]
    # the parser's error named the file; the result names the id in its place
    assert row["reason"] == "extract_failed" and row["demo"] in row["errors"][0], row["errors"]
    printed = capsys.readouterr()
    for text in (printed.out, printed.err, json.dumps(summary), caplog.text):
        assert not leaks(text)

    # the core itself: the result, its traceback included, and the team names read from the name it stores
    res = ex.extract_demo(dem, tmp_path / "core", "local", name=f"{row['demo']}.dem")
    assert not leaks(json.dumps(res, default=str))
    assert (res["dem_file"], res["team1_file"], res["team2_file"]) == (f"{row['demo']}.dem", None, None)
    assert ex.teams_from_filename(dem) != (None, None)  # what the stored name would have given


def test_a_recorded_demo_gone_before_the_core_reads_it_fails_without_its_name(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    res = ex.extract_demo(tmp_path / AUTO, tmp_path / "out", "local", name="20261106T0600Z_de_dust2_abcdef12.dem")
    assert res["ok"] is False and res["errors"][0].startswith("FileNotFoundError"), res["errors"]
    assert not leaks(json.dumps(res, default=str)) and not leaks(caplog.text)


def test_the_core_refuses_a_recorded_demo_without_an_id_name(tmp_path, capsys):
    dem = _demo(tmp_path)
    for name in (None, AUTO, "anything.dem"):
        with pytest.raises(ValueError, match="source local needs name=") as e:
            ex.extract_demo(dem, tmp_path / "out", "local", name=name)
        assert not leaks(str(e.value))
    with pytest.raises(SystemExit) as e:
        ex.main([str(dem), str(tmp_path / "out"), "--source", "local"])
    assert e.value.code == 2 and not leaks(capsys.readouterr().err)
    assert not (tmp_path / "out").exists()


def test_an_unreadable_demo_is_reported_by_place_and_the_batch_goes_on(tmp_path, monkeypatch, dust2):
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, BOT_A)))
    bad, good = _demo(tmp_path / "a"), _demo(tmp_path / "b", "auto-20261025-0400-de_dust2-x.dem", b"another")
    real = ex.file_sha256

    def sha(path):
        if Path(path) == bad:
            raise PermissionError(f"[Errno 13] Permission denied: '{path}'")
        return real(path)
    monkeypatch.setattr(li.extract, "file_sha256", sha)
    code, summary = _run([bad, good], tmp_path / "out")
    assert [(r["demo"], r["ok"], r["reason"]) for r in summary["results"]][0] == ("unreadable-1", False, "unreadable")
    assert summary["results"][1]["ok"] and len(calls) == 1 and code == 1
    assert not leaks(json.dumps(summary))


def test_a_demo_that_vanishes_after_its_hash_fails_alone_and_without_its_name(tmp_path, monkeypatch, capsys):
    # Its id needs the file's creation time, and so does its metadata, read only when it is extracted. Gone
    # between the two, it raised an error naming its path, and the batch stopped.
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1, BOT_A)))
    monkeypatch.setattr(li, "demo_map", lambda dem: "de_dust2")
    gone = _demo(tmp_path / "a", AUTO)
    ok = _demo(tmp_path / "b", "auto-20261106-0100-de_dust2-x.dem", b"another")
    real, seen = li.created_utc, []

    def created(dem):
        if dem == gone and dem in seen:
            raise FileNotFoundError(f"[WinError 2] The system cannot find the file specified: '{dem}'")
        seen.append(dem)
        return real(dem)
    monkeypatch.setattr(li, "created_utc", created)
    code, summary = _run([gone, ok, "--progress"], tmp_path / "out")
    first, second = summary["results"]
    assert (first["ok"], first["reason"], li.ID_RE.match(first["demo"]) is not None) == (False, "unreadable", True)
    assert first["errors"] == ["FileNotFoundError: the demo could not be read"] and second["ok"] and code == 1
    printed = capsys.readouterr()
    for text in (json.dumps(summary), printed.out, printed.err):
        assert not leaks(text)


@pytest.mark.parametrize("host", ["ok", "de"])
def test_a_short_steam_name_is_scrubbed_without_rewriting_the_result(tmp_path, parsed_match, host):
    # Replaced everywhere, "ok" rewrote the result's "ok" (its key and its visibility value), and "de" rewrote
    # "de_dust2" in the id and the map.
    dem = _demo(tmp_path / "replays", f"auto-20261106-0000-de_dust2-{host}.dem")
    code, summary = _run([dem], tmp_path / "out")
    row = summary["results"][0]
    assert (code, row["ok"], row["map"], row["reason"], row["visibility"]) == (0, True, "de_dust2", None, "ok"), row
    assert re.fullmatch(r"\d{8}T\d{4}Z_de_dust2_[0-9a-f]{8}", row["demo"])
    assert pl.read_parquet(ex.resolve_map_dir(Path(row["out"])) / "match.parquet")["map"][0] == "de_dust2"


def test_the_id_is_the_creation_time_the_header_map_and_the_hash_and_a_named_demo_keeps_its_own(
        tmp_path, monkeypatch):
    monkeypatch.setattr(li, "demo_map", lambda dem: "Workshop/De Mirage!")
    dem = _demo(tmp_path)
    sha = hashlib.sha256(dem.read_bytes()).hexdigest()
    did = li.demo_id(dem, sha)
    assert re.fullmatch(rf"\d{{8}}T\d{{4}}Z_workshop_de_mirage_{sha[:8]}", did)
    if hasattr(dem.stat(), "st_birthtime"):
        # the app moves the demo into its own folder, which updates no time but could touch the modification
        # time of a copy; the id must stay the one the creation time gives
        os.utime(dem, (1600000000, 1600000000))
        assert li.demo_id(dem, sha) == did
    named = dem.rename(dem.with_name(f"{did}.dem"))
    monkeypatch.setattr(li, "demo_map", lambda dem: pytest.fail("a demo named by its id is not read again"))
    assert li.demo_id(named, sha) == did


def test_a_name_shaped_like_an_id_but_another_files_never_takes_that_matchs_folder(tmp_path, monkeypatch, dust2):
    # A file named <id>.dem whose bytes are not that id's (renamed or overwritten by hand) would extract into the
    # other match's folder and replace its tables.
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1, BOT_A)))
    out = tmp_path / "out"
    first = li.import_local([_demo(tmp_path / "a")], out, None, lambda: None)[0]
    impostor = _demo(tmp_path / "b", f"{first['demo']}.dem", b"another recording")
    second = li.import_local([impostor], out, None, lambda: None)[0]
    assert second["ok"] and second["demo"] != first["demo"]
    assert second["demo"].endswith(hashlib.sha256(b"another recording").hexdigest()[:8])
    kept = pl.read_parquet(ex.resolve_map_dir(out / first["demo"]) / "match.parquet")["demo_sha256"][0]
    assert kept == hashlib.sha256(b"a recorded demo").hexdigest()


def test_the_same_demo_under_another_creation_time_reuses_its_tables(tmp_path, monkeypatch, dust2):
    # A copy of a demo keeps its bytes but not its creation time, so it would get another id and be
    # extracted, and listed, twice.
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, BOT_A)))
    times = iter([datetime(2026, 10, 25, 8, 35, tzinfo=timezone.utc), datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)])
    monkeypatch.setattr(li, "created_utc", lambda dem: next(times))
    dem, out = _demo(tmp_path / "replays"), tmp_path / "out"
    first = _run([dem], out)[1]["results"][0]
    again = _run([dem], out)[1]["results"][0]
    assert (again["demo"], "skipped" in again, len(calls)) == (first["demo"], True, 1)
    assert [p.name for p in out.iterdir() if p.is_dir()] == [first["demo"]]


def test_the_recording_player_is_the_only_human_else_the_user_if_he_played():
    assert li.pov_of(_players(U1, BOT_A, BOT_B), U2) == dict(pov=str(U1), pov_source="the only human player")
    assert li.pov_of(_players(U1, U2, BOT_A), U2) == dict(pov=str(U2), pov_source="the user's SteamID64")
    assert li.pov_of(_players(U1, U2, BOT_A), vi.STEAMID64_MIN + 5) == {}
    assert li.pov_of(_players(BOT_A, BOT_B), U1) == {}


def test_a_bot_match_never_looks_the_user_up_and_why_a_pov_is_missing_outlives_a_rerun(tmp_path, monkeypatch, dust2):
    def no_user():
        raise FileNotFoundError("no Steam install found; pass --steam")
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1, BOT_A, BOT_B)))
    rows = li.import_local([_demo(tmp_path / "a")], tmp_path / "out", None, lambda: pytest.fail("looked up"))
    assert (rows[0]["ok"], rows[0]["pov"], "pov_error" in rows[0]) == (True, str(U1), False)

    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, U2, BOT_A)))
    two = _demo(tmp_path / "b", body=b"another demo")
    for _ in range(2):  # extracted, then skipped: the reason stays
        row = li.import_local([two], tmp_path / "out", None, no_user)[0]
        assert (row["ok"], row["pov"], row["pov_error"]) == (True, None, "FileNotFoundError: no Steam install found; pass --steam")
    assert len(calls) == 1


def test_a_rerun_skips_a_demo_until_the_local_importer_or_the_importer_itself_changes(tmp_path, monkeypatch, dust2):
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, BOT_A)))
    dem, out = _demo(tmp_path / "replays"), tmp_path / "out"
    assert _run([dem], out)[0] == 0
    code, summary = _run([dem], out)
    assert (code, len(calls), summary["results"][0]["pov"]) == (0, 1, str(U1))  # skipped, its pov still reported
    monkeypatch.setattr(li, "IMPORTER_VERSION", li.IMPORTER_VERSION + 1)
    assert _run([dem], out)[0] == 0 and len(calls) == 2
    # tables another importer wrote for this file at the same version number are not these
    did = summary["results"][0]["demo"]
    vi.extract_into(dem, out / did, "valve", None, "valve_import", li.IMPORTER_VERSION, dict, force=True, archive=did)
    assert _run([dem], out)[0] == 0 and len(calls) == 4


def test_with_no_demo_given_only_recorded_demos_in_the_replays_folder_are_imported(tmp_path, monkeypatch, dust2):
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, BOT_A)))
    steam = tmp_path / "Steam"
    (steam / "steamapps").mkdir(parents=True)
    _demo(steam / vi.REPLAYS, AUTO)
    _demo(steam / vi.REPLAYS, "match730_003000000000000000001_0000000001_100.dem", b"a matchmaking demo")
    assert _run(["--steam", steam], tmp_path / "out")[0] == 0
    assert [c["dem"] for c in calls] == [AUTO]


def test_the_importer_refuses_an_out_inside_a_repository(tmp_path, monkeypatch, dust2):
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1)))
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    out = tmp_path / "repo" / "data" / "local"
    with pytest.raises(SystemExit) as e:
        li.main([str(_demo(tmp_path)), "--out", str(out)])
    assert e.value.code == 2 and not out.exists()


def test_the_version_the_app_reads_is_the_bare_extractor_version(capsys):
    # The host keeps a failed demo until this changes, and compares it with what its ledger stored.
    with pytest.raises(SystemExit) as e:
        li.main(["--version"])
    assert (e.value.code, capsys.readouterr().out.strip()) == (0, ex.EXTRACTOR_VERSION)


def test_a_truncated_demo_cut_off_before_its_second_freeze_end_still_gets_a_tick_rate():
    # One complete round (freeze end 2488, round end 9000), then the recording stops: measuring between the one
    # freeze end and itself divided by zero.
    class Clock:
        def parse_ticks(self, props, ticks):
            return pd.DataFrame({"tick": ticks, "game_time": [t / 64 for t in ticks]})
    assert ex.truncated_tick_rate(Clock(), [2488, 9000], 64.0) == 64.0
    assert ex.truncated_tick_rate(Clock(), [2488], 64.0) == 64.0

    class Frozen(Clock):
        def parse_ticks(self, props, ticks):
            return pd.DataFrame({"tick": ticks, "game_time": [40.0] * len(ticks)})
    assert ex.truncated_tick_rate(Frozen(), [2488, 9000], 64.0) == 64.0

    # demoparser2 leaves the column out when it decoded no game time at either tick
    class Undecoded(Clock):
        def parse_ticks(self, props, ticks):
            return pd.DataFrame({"tick": pd.Series([], dtype="int64")})
    assert ex.truncated_tick_rate(Undecoded(), [2488, 9000], 64.0) == 64.0


@pytest.mark.parametrize("extra", ["[]", "null", "{not json"])
def test_tables_whose_match_extra_is_not_an_object_are_extracted_again(tmp_path, monkeypatch, extra):
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1)))
    dem, map_dir = _demo(tmp_path), tmp_path / "out" / "m"
    with ex.map_lock(map_dir):
        tmp = map_dir / ".tmp-test"
        tmp.mkdir(parents=True)
        pl.DataFrame({"demo_sha256": [ex.file_sha256(dem)], "extractor_version": [ex.EXTRACTOR_VERSION],
                      "extra": [extra]}).write_parquet(tmp / "match.parquet")
        ex.publish_version(tmp, map_dir, ex.EXTRACTOR_VERSION, ["match.parquet"])
    row = vi.extract_into(dem, map_dir, "valve", None, "valve_import", vi.IMPORTER_VERSION, dict, force=False, archive="m")
    assert row["ok"] and "skipped" not in row and len(calls) == 1


def _row(table: str, **values) -> dict:
    """One row of a schema v1 table with a neutral value in every column, then `values`."""
    neutral = {"Boolean": False, "String": "", "List(String)": [], "List(UInt64)": [], "Float32": 0.0}
    return {c: neutral.get(t, 0) for c, t in schema_v1.TYPES[table].items()} | values


@pytest.fixture
def parsed_match(monkeypatch):
    """Both parsing stages replaced by what they hand on for a one-round bot match on a listen server named
    after its host: the header with that server name, the round, three players. Everything after them is
    the real extraction: the match row, the result and the published tables."""
    def awpy(ctx):
        ctx.truncated = True  # skips the cross-check against awpy's own tables
        ctx.info.update(awpy_error="stand-in", awpy_header={})
        return {}

    def demoparser2(ctx):
        ctx.info.update(
            header={"map_name": "de_dust2", "server_name": HOST, "patch_version": "14109", "demo_version_guid": "g"},
            rounds=1, final_score={"ct_start": 1, "t_start": 0}, match_start_tick=1113, unattributed_damage_hp=0,
            final_tick=9000, voided_windows=[], dropped_attempts=[], excluded_players=[], departed=[],
            scoreboard_taken={}, convars={"hostname": HOST}, checks=[], equip_value_mismatch_rows=0, economy_rows=0,
            visibility=dict(status="ok", release="2000935", patch_version="1.41.9.2", buildid="26144732",
                            mesh_sha256="0" * 64, kill_agreement=1.0))
        return {"rounds": pd.DataFrame([_row("rounds", round=1, ct_team="ct_start", t_team="t_start")]),
                "players": pd.DataFrame([_row("players", steamid=s, name=n, is_bot=s < 2 ** 40, team=t)
                                         for s, n, t in ((U1, "Player", "ct_start"), (BOT_A, "Ringo", "t_start"),
                                                         (BOT_B, "Vitaliy", "ct_start"))])}
    monkeypatch.setattr(ex, "STAGES", [("awpy", awpy), ("demoparser2", demoparser2)])
    monkeypatch.setattr(li, "demo_map", lambda dem: "de_dust2")


def test_a_published_import_holds_no_part_of_the_original_name(tmp_path, parsed_match, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    code, summary = _run([_demo(tmp_path / "replays"), "--progress"], tmp_path / "out")
    row = summary["results"][0]
    assert (code, row["ok"], row["pov"]) == (0, True, str(U1)), row["errors"]
    tables = sorted(ex.resolve_map_dir(Path(row["out"])).glob("*.parquet"))
    assert [t.stem for t in tables] == ["match", "players", "rounds"]
    for t in tables:
        assert not leaks(_strings(t)), t.name
    printed = capsys.readouterr()
    for text in (json.dumps(summary), printed.out, printed.err, caplog.text):
        assert not leaks(text)
    m = pl.read_parquet(tables[0]).row(0, named=True)
    assert (m["source"], m["dem_file"], m["server_name"], m["team1_file"], m["team2_file"]) == (
        "local", f"{row['demo']}.dem", "", None, None)


# --- a real demo from the private data folder ----------------------------------

def _strings(path: Path) -> str:
    """Every string a parquet table holds, in any column, as one text."""
    df = pl.read_parquet(path)
    return json.dumps(df.select([c for c, t in df.schema.items() if t == pl.String or isinstance(t, pl.List)]).to_dicts(),
                      default=str)


def test_a_real_demo_through_the_local_path_writes_no_part_of_its_original_name(tmp_path, caplog):
    # The same check on every table a real demo produces; it needs the private fixtures, and the synthetic
    # test above enforces the rule without them.
    src = DATA / "fixtures" / "fixture-d-vs-split-m1-cache-p1.dem"  # an HLTV Cache map's first part, 4 rounds
    mapdata = DATA / "mapdata" / "2000935"
    if not src.exists() or not mapdata.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src} or {mapdata}; the tables of a real demo are not grepped")
    caplog.set_level(logging.DEBUG)
    dem = tmp_path / "replays" / f"auto-20261106-0000-de_cache-{HOST}.dem"
    dem.parent.mkdir()
    shutil.copyfile(src, dem)
    code, summary = _run([dem, "--user", str(U1), "--mapdata", mapdata], tmp_path / "out")
    row = summary["results"][0]
    assert (code, row["ok"], row["pov"]) == (0, True, None), (row["errors"], row.get("failed_checks"))  # ten humans, none of them the user
    tables = ex.resolve_map_dir(Path(row["out"]))
    for t in sorted(tables.glob("*.parquet")):
        assert not leaks(_strings(t)), t.name
    assert not leaks(json.dumps(summary)) and not leaks(caplog.text)
    m = pl.read_parquet(tables / "match.parquet").row(0, named=True)
    assert (m["source"], m["dem_file"], m["server_name"], m["team1_file"], m["team2_file"]) == (
        "local", f"{row['demo']}.dem", "", None, None)
    assert row["demo"].endswith(f"_de_cache_{m['demo_sha256'][:8]}")
