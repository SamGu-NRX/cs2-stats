"""Demos CS2 recorded on this machine (local_import.py): the renamed id, the recording player, the reasons a
demo fails, and the shared import core. Synthetic data, except two tests that read the private data folder and
skip without it."""

import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

import pandas as pd
import polars as pl
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import extract as ex  # noqa: E402
import local_import as li  # noqa: E402
import valve_import as vi  # noqa: E402

DATA = Path(os.environ.get("CS2_STATS_DATA") or HERE.parents[2] / "cs2-stats-data")
U1, U2 = vi.STEAMID64_MIN + 1000, vi.STEAMID64_MIN + 2000
BOT_A, BOT_B = ex.bot_id(3, "Ringo"), ex.bot_id(4, "Vitaliy")
# the shape of tv_autorecord's name, ending in the server name, which on a listen server is the host's Steam name
HOST = "Some-vs-the-persona"
AUTO = f"auto-20261025-0335-de_dust2-{HOST}.dem"


def _players(*ids):
    return pd.DataFrame({"steamid": list(ids), "is_bot": [i < 2 ** 40 for i in ids]})


def _fake_extractor(calls: list, players: pd.DataFrame, error: str | None = None):
    """Stands in for extract.extract_demo: asks for the players' extra as the real one does, then publishes a
    minimal map, or fails with `error`."""

    def fake(dem, out_dir, source, mapdata=None, archive="", meta_extra=None, name=None, extra_from_players=None):
        calls.append(dict(dem=Path(dem).name, source=source, archive=archive, name=name))
        if error:
            return dict(ok=False, errors=[error], validation={})
        extra = {**meta_extra, **extra_from_players(players)}
        with ex.map_lock(Path(out_dir)):
            tmp = Path(out_dir) / ".tmp-test"
            tmp.mkdir(parents=True)
            pl.DataFrame({"demo_sha256": [ex.file_sha256(dem)], "extractor_version": [ex.EXTRACTOR_VERSION],
                          "extra": [json.dumps(extra)]}).write_parquet(tmp / "match.parquet")
            ex.publish_version(tmp, Path(out_dir), ex.EXTRACTOR_VERSION, ["match.parquet"])
        return dict(ok=True, errors=[], validation={})
    return fake


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


def test_the_original_name_which_ends_in_a_steam_name_is_never_stored_printed_or_read_for_teams(
        tmp_path, monkeypatch, capsys, dust2):
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, BOT_A),
                                                                   error=f"OSError: cannot read {AUTO}"))
    dem = _demo(tmp_path / "replays")
    out = tmp_path / "local"
    li.main([str(dem), "--out", str(out), "--progress", "--result", str(tmp_path / "summary.json")])
    did = calls[0]["archive"]
    assert li.ID_RE.match(did) and calls == [dict(dem=AUTO, source="local", archive=did, name=f"{did}.dem")]
    printed = capsys.readouterr()
    for text in (printed.out, printed.err, (tmp_path / "summary.json").read_text(encoding="utf-8")):
        assert "persona" not in text and did in text
    # the original name parses as "<team1>-vs-<team2>-<map>"; the id the extractor is given does not
    assert ex.teams_from_filename(Path(AUTO)) != (None, None)
    assert ex.teams_from_filename(Path(calls[0]["name"])) == (None, None)


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
    assert li.demo_id(named, "0" * 64) == did


def test_the_recording_player_is_the_only_human_else_the_user_if_he_played():
    assert li.pov_of(_players(U1, BOT_A, BOT_B), U2) == dict(pov=str(U1), pov_source="the only human player")
    assert li.pov_of(_players(U1, U2, BOT_A), U2) == dict(pov=str(U2), pov_source="the user's SteamID64")
    assert li.pov_of(_players(U1, U2, BOT_A), vi.STEAMID64_MIN + 5) == {}
    assert li.pov_of(_players(BOT_A, BOT_B), U1) == {}


def test_a_bot_match_never_looks_the_user_up_and_a_failed_lookup_still_writes_the_tables(tmp_path, monkeypatch, dust2):
    def no_user():
        raise FileNotFoundError("no Steam install found; pass --steam")
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1, BOT_A, BOT_B)))
    rows = li.import_local([_demo(tmp_path / "a")], tmp_path / "out", None, lambda: pytest.fail("looked up"))
    assert (rows[0]["ok"], rows[0]["pov"], "pov_error" in rows[0]) == (True, str(U1), False)

    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1, U2, BOT_A)))
    rows = li.import_local([_demo(tmp_path / "b", body=b"another demo")], tmp_path / "out", None, no_user)
    assert (rows[0]["ok"], rows[0]["pov"]) == (True, None)
    assert rows[0]["pov_error"] == "FileNotFoundError: no Steam install found; pass --steam"
    extra = json.loads(pl.read_parquet(ex.resolve_map_dir(Path(rows[0]["out"])) / "match.parquet")["extra"][0])
    assert "pov" not in extra and extra["importer"] == "local_import"


@pytest.mark.parametrize("error, reason", [
    ("RuntimeError: no round_end events after match start", "no_rounds"),
    ("ValidationFailed: 1 fatal validation checks failed", "extract_failed"),
])
def test_a_failed_demo_says_why_and_fails_the_run(tmp_path, monkeypatch, dust2, error, reason):
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], _players(U1), error=error))
    code, summary = _run([_demo(tmp_path / "replays")], tmp_path / "out")
    assert (code, summary["ok"], summary["results"][0]["reason"]) == (1, 0, reason)


def test_a_rerun_skips_a_demo_until_the_local_importer_changes(tmp_path, monkeypatch, dust2):
    calls = []
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, _players(U1, BOT_A)))
    dem, out = _demo(tmp_path / "replays"), tmp_path / "out"
    assert _run([dem], out)[0] == 0
    code, summary = _run([dem], out)
    assert (code, len(calls), summary["results"][0]["pov"]) == (0, 1, str(U1))  # skipped, its pov still reported
    monkeypatch.setattr(li, "IMPORTER_VERSION", li.IMPORTER_VERSION + 1)
    assert _run([dem], out)[0] == 0 and len(calls) == 2


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


# --- real demos from the private data folder ---------------------------------

def test_a_recording_cut_off_before_round_one_ends_reports_no_rounds(tmp_path):
    # The first tv_autorecord demo from a listen server ends in round 1's freeze time.
    found = sorted((DATA / "user-demos").glob("auto-*.dem"))
    if not found:
        pytest.skip(f"PRIVATE FIXTURE MISSING: no auto-*.dem in {DATA / 'user-demos'}; the cut-off demo is not checked")
    code, summary = _run([found[0]], tmp_path / "out")
    row = summary["results"][0]
    assert (code, row["ok"], row["reason"]) == (1, False, "no_rounds")
    assert found[0].stem.rsplit("-", 1)[-1] not in json.dumps(summary)


def test_a_demo_through_the_local_path_writes_tables_without_its_original_name(tmp_path):
    src = DATA / "fixtures" / "fixture-d-vs-split-m1-cache-p1.dem"  # an HLTV Cache map's first part, 4 rounds
    mapdata = DATA / "mapdata" / "2000935"
    if not src.exists() or not mapdata.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src} or {mapdata}; the local path is not checked on a real demo")
    dem = tmp_path / "replays" / f"auto-20261025-0335-de_cache-{HOST}.dem"
    dem.parent.mkdir()
    shutil.copyfile(src, dem)
    code, summary = _run([dem, "--user", str(U1), "--mapdata", mapdata], tmp_path / "out")
    row = summary["results"][0]
    assert (code, row["ok"], row["pov"]) == (0, True, None), (row["errors"], row.get("failed_checks"))  # ten humans, none of them the user
    m = pl.read_parquet(ex.resolve_map_dir(Path(row["out"])) / "match.parquet").row(0, named=True)
    assert (m["source"], m["dem_file"], m["server_name"], m["team1_file"], m["team2_file"]) == (
        "local", f"{row['demo']}.dem", "", None, None)
    assert row["demo"].endswith(f"_de_cache_{m['demo_sha256'][:8]}")
    assert json.loads(m["extra"])["importer"] == "local_import"


def test_the_version_the_app_reads_is_the_bare_extractor_version(capsys):
    # The host keeps a failed demo until this changes, and compares it with what its ledger stored.
    with pytest.raises(SystemExit) as e:
        li.main(["--version"])
    assert (e.value.code, capsys.readouterr().out.strip()) == (0, ex.EXTRACTOR_VERSION)
