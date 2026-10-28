"""Loose demos (OpenCS2) through the pipeline's inbox, and the fetcher that fills it. Synthetic except one private
fixture demo, which the test needing it copies under a made-up name and skips without."""

import json
import os
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import polars as pl
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import demo_pipeline as dp  # noqa: E402
import extract as ex  # noqa: E402
import fetch_opencs2 as fo  # noqa: E402

DATA = Path(os.environ.get("CS2_STATS_DATA") or HERE.parents[2] / "cs2-stats-data")
FIXTURE = DATA / "fixtures" / "fixture-d-vs-split-m1-cache-p1.dem"  # an HLTV Cache map's first part, 4 rounds


def _isolate(tmp_path, monkeypatch) -> Path:
    """Every folder and file the pipeline writes, under tmp_path/data; the inbox beside it, outside the data folder as
    in use (a finished demo there was refused deletion when only the data folder was allowed)."""
    data = tmp_path / "data"
    monkeypatch.setattr(dp, "DATA_ROOT", data)
    for name in ("DEMOS_DIR", "WORK_DIR", "FAILED_DIR", "LOG_DIR", "PARTS_DIR"):
        d = data / name.lower()
        d.mkdir(parents=True)
        monkeypatch.setattr(dp, name, d)
    for name in ("DOWNLOADS", "INBOX"):
        d = tmp_path / name.lower()
        d.mkdir()
        monkeypatch.setattr(dp, name, d)
    for name, file in (("LEDGER", "archives.jsonl"), ("DROPPED", "failed_dropped.jsonl"), ("MANIFEST", "manifest.jsonl"),
                       ("NEEDS_REEXTRACT", "needs_reextract.jsonl")):
        monkeypatch.setattr(dp, name, dp.DEMOS_DIR / file)
    monkeypatch.setattr(dp, "COPIES_LOG", dp.LOG_DIR / "download_copies.jsonl")
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 1000.0)
    return dp.INBOX


def _loose(inbox: Path, match_id: str, name: str, data: bytes, sidecar: dict | None) -> Path:
    dem = inbox / match_id / name
    dem.parent.mkdir(parents=True, exist_ok=True)
    dem.write_bytes(data)
    if sidecar is not None:
        dp.sidecar_path(dem).write_text(json.dumps(sidecar), encoding="utf-8")
    return dem


def _ledger() -> list[dict]:
    return [json.loads(x) for x in dp.LEDGER.read_text(encoding="utf-8").splitlines()] if dp.LEDGER.exists() else []


def test_a_loose_demo_with_a_sidecar_publishes_with_its_ids(tmp_path, monkeypatch):
    # The join to HLTV reads these ids from match.extra (model/rating3/join_demos.py); a map published without them
    # cannot be joined, and the fetcher would fetch it again without its ledger row.
    if not FIXTURE.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {FIXTURE}; publishing a loose demo is not being checked")
    inbox = _isolate(tmp_path, monkeypatch)
    dem = inbox / "123" / "team-a-vs-team-b-m1-cache.dem"
    dem.parent.mkdir()
    shutil.copyfile(FIXTURE, dem)
    dp.sidecar_path(dem).write_text(json.dumps(dict(source="opencs2", hltv_match_id="123", hltv_map_index=1,
                                                    map_name="de_cache", match_date="2026-04-01T12:00:00")))
    monkeypatch.setattr(dp, "RUN_CODE", tmp_path / "data" / "run")
    dp.freeze_code()
    p = dp.Pipeline()
    p.available_gb = lambda: 20.0
    deadline = time.time() + 600
    while "opencs2-123-m1" not in p.ledger:
        assert time.time() < deadline, "the loose demo was never finished"
        p.step()
        time.sleep(0.5)
    rec = p.ledger["opencs2-123-m1"]
    assert rec["status"] == "done", rec
    assert (rec["source"], rec["hltv_match_id"], rec["hltv_map_index"]) == ("opencs2", "123", 1)
    match = pl.read_parquet(ex.resolve_map_dir(dp.DEMOS_DIR / rec["slug"] / "m1-cache") / "match.parquet").row(0, named=True)
    extra = json.loads(match["extra"])
    assert match["archive"] == "opencs2-123-m1" and rec["slug"] == "team-a-vs-team-b-opencs2-123-m1"
    assert (extra["source"], extra["hltv_match_id"], extra["hltv_map_index"], extra["map_name"]) == \
        ("opencs2", "123", 1, "de_cache")
    assert not dem.exists() and not dp.sidecar_path(dem).exists()  # the inputs go once the map is published


def test_a_loose_demo_without_a_sidecar_is_refused(tmp_path, monkeypatch):
    # Without its HLTV ids a map cannot be joined to its scoreboard; it must not be parsed as an anonymous map.
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "456", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64), None)
    p = dp.Pipeline()
    p.scan(0.0)
    p.scan(0.0)  # skipped from then on, not refused again
    assert p.archives == {} and dem.exists()
    assert [(r["id"], r["status"], r["reason"]) for r in _ledger()] == \
        [("inbox:team-a-vs-team-b-m1-nuke.dem", "failed", "refused: no sidecar team-a-vs-team-b-m1-nuke.meta.json")]


def test_a_loose_demo_whose_sidecar_names_another_map_fails(tmp_path, monkeypatch):
    # Published under the sidecar's ids, a Cache demo labelled as a Dust2 map would be joined to the wrong HLTV map,
    # or block the right demo of those ids.
    if not FIXTURE.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {FIXTURE}; the map check of a loose demo is not being checked")
    inbox = _isolate(tmp_path, monkeypatch)
    dem = inbox / "789" / "team-a-vs-team-b-m1-dust2.dem"
    dem.parent.mkdir()
    shutil.copyfile(FIXTURE, dem)
    dp.sidecar_path(dem).write_text(json.dumps(dict(source="opencs2", hltv_match_id="789", hltv_map_index=1,
                                                    map_name="de_dust2")))
    p = dp.Pipeline()
    p.scan(0.0)
    p.start_extractions()
    rec = p.ledger["opencs2-789-m1"]
    assert rec["status"] == "failed" and "names de_dust2, the demo's header de_cache" in rec["reason"]
    assert not p.jobs and not dem.exists()
    kept = Path(rec["kept"])
    assert (kept / dem.name).exists() and dp.sidecar_path(kept / dem.name).exists()  # kept for a retry, sidecar too


class _Server:
    """Serves one demo with Range support; the first ranged request pauses after its first block until released."""

    def __init__(self, data: bytes):
        self.data, self.ranges, self.paused, self.release = data, [], threading.Event(), threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - http.server naming
                rng = self.headers.get("Range")
                outer.ranges.append(rng)
                start = int(rng.removeprefix("bytes=").split("-")[0]) if rng else 0
                body = outer.data[start:]
                self.send_response(206 if rng else 200)
                if rng:
                    self.send_header("Content-Range", f"bytes {start}-{len(outer.data) - 1}/{len(outer.data)}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body[:100])
                self.wfile.flush()
                if rng and not outer.paused.is_set():
                    outer.paused.set()
                    outer.release.wait(10)
                self.wfile.write(body[100:])

            def log_message(self, *a):
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/"


def test_a_resumed_download_completes_and_only_then_appears_in_the_inbox(tmp_path):
    # The pipeline takes any .dem in the inbox at once: a partial demo, or one whose sidecar is not written yet, would
    # be parsed broken or refused. A stopped download resumes from where its .part ends.
    data = dp.DEM_MAGIC + bytes(range(256)) * 40
    m = fo.Map("2390001", 1, "de_nuke", "demos/shard-x/2390001/team-a-vs-team-b-m1-nuke.dem", len(data), None)
    inbox = tmp_path / "inbox"
    final = m.target(inbox)
    final.parent.mkdir(parents=True)
    part = final.with_name(final.name + ".part")
    part.write_bytes(data[:1000])  # what a stopped run left
    server = _Server(data)
    try:
        done = []
        t = threading.Thread(target=lambda: done.append(fo.download(m, server.url + m.file_name, inbox,
                                                                       threading.Event())))
        t.start()
        assert server.paused.wait(10), "the download never asked the server"
        assert part.exists() and not final.exists() and not dp.sidecar_path(final).exists()
        server.release.set()
        t.join(10)
    finally:
        server.release.set()
        server.httpd.shutdown()
    assert done == [True] and server.ranges == ["bytes=1000-"]
    assert final.read_bytes() == data and not part.exists()
    assert dp.read_sidecar(final) == dict(source="opencs2", hltv_match_id="2390001", hltv_map_index=1,
                                          map_name="de_nuke", dataset_file=m.file_name, match_date=None)


def test_the_fetcher_skips_maps_already_published_or_without_a_scoreboard(tmp_path):
    # Fetching a map the pipeline already published (or failed) costs half a gigabyte for nothing; one with no saved
    # HLTV scoreboard cannot be joined, so it is no rating data.
    meta, hltv, inbox = tmp_path / "meta", tmp_path / "hltv", tmp_path / "inbox"
    for d in (meta, hltv, inbox):
        d.mkdir()
    rows = [dict(match_id=mid, map_index=i, map_name=mp, file_name=f"demos/s/{mid}/a-vs-b-m{i}-{mp[3:]}.dem",
                 demo_bytes=100, match_date=None) for mid, i, mp in
            (("1", 1, "de_nuke"), ("1", 2, "de_dust2"), ("2", 1, "de_mirage"), ("3", 1, "de_ancient"))]
    pl.DataFrame(rows).with_columns(pl.col("map_index").cast(pl.Int32), pl.col("match_date").cast(pl.Datetime("ms", "UTC"))) \
        .write_parquet(meta / "metadata-x.parquet")
    for n, (mid, i) in enumerate([("1", 1), ("1", 2), ("2", 1)]):  # match 3 has no saved scoreboard
        (hltv / f"ocs_map_{n}.json").write_text(json.dumps(dict(mapIndex=i, match=dict(matchId=mid))), encoding="utf-8")
    ledger = tmp_path / "archives.jsonl"
    dp.append_jsonl(ledger, dict(id="opencs2-1-m1", status="done"))
    dp.append_jsonl(ledger, dict(id="opencs2-2-m1", status="failed"))
    todo = fo.plan(fo.dataset_maps(meta), fo.held_scoreboards(hltv), dp.read_ledger(ledger), inbox)
    assert [(m.match_id, m.map_index) for m in todo] == [("1", 2)]
