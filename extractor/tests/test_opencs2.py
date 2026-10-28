"""Loose demos (OpenCS2) through the pipeline's inbox, and the fetcher that fills it. Synthetic except one private
fixture demo, which the tests needing it copy under a made-up name and skip without."""

import hashlib
import json
import logging
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
    """Every folder and file the pipeline writes, under tmp_path/data; the inbox beside it, claimed, outside the data
    folder as in use; the OpenCS2 metadata at tmp_path/meta (_meta writes its rows)."""
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
    (dp.INBOX / dp.INBOX_MARKER).write_text("", encoding="utf-8")
    for name, file in (("LEDGER", "archives.jsonl"), ("DROPPED", "failed_dropped.jsonl"), ("MANIFEST", "manifest.jsonl"),
                       ("NEEDS_REEXTRACT", "needs_reextract.jsonl")):
        monkeypatch.setattr(dp, name, dp.DEMOS_DIR / file)
    monkeypatch.setattr(dp, "COPIES_LOG", dp.LOG_DIR / "download_copies.jsonl")
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 1000.0)
    monkeypatch.setattr(dp, "OPENCS2_META", tmp_path / "meta")
    monkeypatch.setattr(dp, "_opencs2", None)
    return dp.INBOX


def _meta(folder: Path, rows: list[dict]) -> None:
    folder.mkdir(exist_ok=True)
    pl.DataFrame(rows).with_columns(pl.col("map_index").cast(pl.Int32), pl.col("demo_bytes").cast(pl.Int64)) \
        .write_parquet(folder / "metadata-x.parquet")


def _loose(inbox: Path, match_id: str, index: int, map_name: str, name: str, data: bytes | Path,
           sidecar_changes: dict | None = None, meta_changes: dict | None = None) -> Path:
    """A loose demo with its dataset row and a sidecar that agrees with both, unless changed."""
    dem = inbox / match_id / name
    dem.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(data, dem) if isinstance(data, Path) else dem.write_bytes(data)
    file_name = f"demos/shard-x/{match_id}/{name}"
    size, sha = dem.stat().st_size, hashlib.sha256(dem.read_bytes()).hexdigest()
    _meta(dp.OPENCS2_META, [{**dict(file_name=file_name, match_id=match_id, map_index=index, map_name=map_name,
                                    demo_bytes=size), **(meta_changes or {})}])
    side = {**dict(source="opencs2", hltv_match_id=match_id, hltv_map_index=index, map_name=map_name,
                   dataset_file=file_name, dem_bytes=size, sha256=sha), **(sidecar_changes or {})}
    dp.sidecar_path(dem).write_text(json.dumps(side), encoding="utf-8")
    return dem


def _link_folder(link: Path, target: Path) -> None:
    """link, a junction to target on Windows (no privilege needed), a symlink elsewhere."""
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


def _hashed(p) -> None:
    deadline = time.time() + 30
    while any(a.state == "hashing" for a in p.archives.values()):
        assert time.time() < deadline, "the hash never came back"
        p.poll_hashes()
        time.sleep(0.01)


def _ledger() -> list[dict]:
    return [json.loads(x) for x in dp.LEDGER.read_text(encoding="utf-8").splitlines()] if dp.LEDGER.exists() else []


def _until(p, done, timeout=600.0):
    deadline = time.time() + timeout
    while not done():
        assert time.time() < deadline, "the pipeline never got there"
        p.step()
        time.sleep(0.2)


def test_a_loose_demo_with_a_sidecar_publishes_with_its_ids(tmp_path, monkeypatch):
    # The join to HLTV reads these ids from match.extra (model/rating3/join_demos.py); a map published without them
    # cannot be joined, and the fetcher would fetch it again without its ledger row.
    if not FIXTURE.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {FIXTURE}; publishing a loose demo is not being checked")
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "123", 1, "de_cache", "team-a-vs-team-b-m1-cache.dem", FIXTURE)
    monkeypatch.setattr(dp, "RUN_CODE", tmp_path / "data" / "run")
    dp.freeze_code()
    p = dp.Pipeline()
    p.available_gb = lambda: 20.0
    _until(p, lambda: "opencs2-123-m1" in p.ledger)
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
    dem = inbox / "456" / "team-a-vs-team-b-m1-nuke.dem"
    dem.parent.mkdir()
    dem.write_bytes(dp.DEM_MAGIC + bytes(64))
    _meta(dp.OPENCS2_META, [dict(file_name="demos/shard-x/1/other.dem", match_id="1", map_index=1, map_name="de_nuke",
                                 demo_bytes=72)])
    p = dp.Pipeline()
    p.scan(0.0)
    p.scan(0.0)  # skipped from then on, not refused again
    assert p.archives == {} and dem.exists()
    assert [(r["id"], r["status"], r["reason"]) for r in _ledger()] == \
        [("inbox:team-a-vs-team-b-m1-nuke.dem", "failed", "refused: no sidecar team-a-vs-team-b-m1-nuke.meta.json")]


@pytest.mark.parametrize("sidecar, meta, reason", [
    (dict(hltv_match_id="999"), None, "the sidecar says ('999', 1, 'de_nuke', "),  # ids of another match
    (None, dict(map_index=2), "the dataset ('77', 2, 'de_nuke', "),  # the dataset puts the file at map 2
    (dict(dataset_file="demos/shard-x/77/other.dem"), None, "the dataset has no such file"),
])
def test_a_sidecar_that_disagrees_with_the_dataset_is_refused(tmp_path, monkeypatch, sidecar, meta, reason):
    # Review of PR 67: ids were only syntax-checked, so a sidecar with another map's ids would publish this demo
    # under them. The dataset's row for the sidecar's file must say the same ids, map and size.
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "77", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64), sidecar, meta)
    p = dp.Pipeline()
    p.scan(0.0)
    assert p.archives == {} and dem.exists()
    assert reason in _ledger()[0]["reason"]


def test_a_loose_demo_whose_sha256_differs_from_its_sidecar_is_refused(tmp_path, monkeypatch):
    # Review of PR 67: the sidecar must be bound to its file; a different demo under a right sidecar would publish
    # under ids that are not its own.
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "88", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64),
                 dict(sha256="0" * 64))
    p = dp.Pipeline()
    p.scan(0.0)
    deadline = time.time() + 30
    while p.archives:
        assert time.time() < deadline, "the hash never came back"
        p.poll_hashes()
        time.sleep(0.01)
    assert not p.jobs and dem.exists()
    assert f"its SHA-256 is {hashlib.sha256(dem.read_bytes()).hexdigest()}, its sidecar says {'0' * 64}" in \
        _ledger()[0]["reason"]


def test_a_loose_demo_whose_header_names_another_map_is_refused_in_place(tmp_path, monkeypatch):
    # Published under the sidecar's ids, a Cache demo labelled as a Dust2 map would be joined to the wrong HLTV map,
    # or block the right demo of those ids. Review 3 of PR 67: it was moved to failed/ though its sidecar is not bound
    # to it; a refused inbox file is never moved.
    if not FIXTURE.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {FIXTURE}; the map check of a loose demo is not being checked")
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "789", 1, "de_dust2", "team-a-vs-team-b-m1-dust2.dem", FIXTURE)
    p = dp.Pipeline()
    _until(p, lambda: _ledger(), timeout=60)
    assert [(r["id"], r["status"]) for r in _ledger()] == [("inbox:team-a-vs-team-b-m1-dust2.dem", "failed")]
    assert "the sidecar names de_dust2, the demo's header de_cache" in _ledger()[0]["reason"]
    assert not p.jobs and not p.archives and dem.exists() and dp.sidecar_path(dem).exists()
    assert not any(dp.FAILED_DIR.iterdir())


def test_a_loose_demo_whose_hash_fails_is_refused_in_place(tmp_path, monkeypatch):
    # Review 3 of PR 67: a hashing error failed the archive, which moved the demo out of the inbox before its sidecar
    # was bound to it.
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "91", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64))
    p = dp.Pipeline()
    p.hasher.take = lambda f: RuntimeError("the disk said no")
    p.scan(0.0)
    p.poll_hashes()
    assert not p.archives and dem.exists() and dp.sidecar_path(dem).exists() and not any(dp.FAILED_DIR.iterdir())
    assert [(r["id"], r["reason"]) for r in _ledger()] == \
        [("inbox:team-a-vs-team-b-m1-nuke.dem", "refused: hashing it failed: RuntimeError: the disk said no")]


def test_the_inbox_scan_skips_links_and_junctions(tmp_path, monkeypatch):
    # Review 3 of PR 67: the scan globbed through a junction, so a valid demo and sidecar elsewhere on the disk were
    # taken in, and deleted once published.
    inbox = _isolate(tmp_path, monkeypatch)
    outside = tmp_path / "outside"
    dem = _loose(outside, "92", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64))
    _link_folder(inbox / "92", outside / "92")
    try:
        os.symlink(dem, inbox / dem.name)
        os.symlink(dp.sidecar_path(dem), dp.sidecar_path(inbox / dem.name))
    except OSError:  # Windows without the symlink privilege: the junction is the case that matters there
        pass
    p = dp.Pipeline()
    p.scan(0.0)
    assert p.archives == {} and _ledger() == [] and dem.exists()


def test_a_failure_never_moves_a_file_from_outside_the_inbox(tmp_path, monkeypatch):
    # Review 3 of PR 67: failing moved the demo with a raw shutil.move, so a path into the inbox that leads out of it
    # (a junction made after the scan) moved a file from anywhere into failed/.
    inbox = _isolate(tmp_path, monkeypatch)
    outside = tmp_path / "outside"
    dem = _loose(outside, "93", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64))
    _link_folder(inbox / "93", outside / "93")
    p = dp.Pipeline()
    via = inbox / "93" / dem.name
    a = dp.Archive(rar=via, id="opencs2-93-m1", loose=dp.read_sidecar(via), rar_bytes=dem.stat().st_size)
    p.archives[a.id] = a
    with pytest.raises(ValueError, match="refusing to delete"):
        p.fail_archive(a, "the parse failed")
    assert dem.exists() and dp.sidecar_path(dem).exists()


def test_unreadable_metadata_turns_the_inbox_off_for_the_run(tmp_path, monkeypatch, caplog):
    # Review 3 of PR 67: a metadata read error refused every demo in the inbox, each with a ledger row, and the
    # metadata was read again on every loop.
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "94", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64))
    (dp.OPENCS2_META / "metadata-x.parquet").write_bytes(b"not a parquet file")
    p = dp.Pipeline()
    with caplog.at_level(logging.ERROR, logger=dp.log.name):
        p.scan(0.0)
        p.scan(0.0)
    assert p.archives == {} and _ledger() == [] and dem.exists()
    assert "cannot be read" in p.inbox_off
    assert sum("taking no loose demos" in r.getMessage() for r in caplog.records) == 1


@pytest.mark.parametrize("first, taken", [(dict(map_index=1), True), (dict(map_index=2), False)])
def test_a_file_the_dataset_lists_twice_is_taken_only_if_both_rows_agree(tmp_path, monkeypatch, first, taken):
    # Review 3 of PR 67: rows were keyed by file name, the last one silently winning, so a conflicting earlier row
    # (another map index here) was ignored and the demo published under ids the dataset disputes.
    inbox = _isolate(tmp_path, monkeypatch)
    dem = _loose(inbox, "95", 1, "de_nuke", "team-a-vs-team-b-m1-nuke.dem", dp.DEM_MAGIC + bytes(64))
    row = pl.read_parquet(dp.OPENCS2_META / "metadata-x.parquet").row(0, named=True)
    _meta(dp.OPENCS2_META, [{**row, **first}, row])
    p = dp.Pipeline()
    p.scan(0.0)
    assert list(p.archives) == (["opencs2-95-m1"] if taken else []) and dem.exists()
    assert [r["reason"] for r in _ledger()] == ([] if taken else [
        "refused: the dataset lists demos/shard-x/95/team-a-vs-team-b-m1-nuke.dem more than once with different ids, "
        "map or size"])


def test_the_inbox_must_be_a_folder_made_for_it(tmp_path, monkeypatch):
    # Review of PR 67: the pipeline deletes the demos in the inbox, and any folder was accepted, so CS2_DEMO_INBOX set
    # to a drive root or the user profile could delete unrelated .dem files.
    data, downloads = tmp_path / "data", tmp_path / "downloads"
    data.mkdir()
    downloads.mkdir()
    claim = lambda inbox: dp.claim_inbox(inbox, data, downloads)
    assert "drive root" in claim(Path(tmp_path.anchor))
    assert "the user profile" in claim(Path.home())
    assert "the data folder" in claim(data / "inbox") and "the data folder" in claim(tmp_path)
    assert "the downloads folder" in claim(downloads / "inbox")
    used = tmp_path / "used"
    used.mkdir()
    (used / "match.dem").write_bytes(b"x")
    assert "holds files but no .cs2-stats-inbox" in claim(used) and not (used / dp.INBOX_MARKER).exists()
    new = tmp_path / "new" / "inbox"
    assert claim(new) is None and (new / dp.INBOX_MARKER).is_file()  # a missing folder is made and claimed
    (new / "123").mkdir()
    assert claim(new) is None  # claimed already, whatever it holds now


def test_the_disk_budget_counts_the_inbox_and_its_partial_downloads(tmp_path, monkeypatch):
    # Review of PR 67: half-written downloads in the inbox were in no budget, so extractions and parses planned
    # against space the fetcher was filling.
    inbox = _isolate(tmp_path, monkeypatch)
    (inbox / "1").mkdir()
    (inbox / "1" / "a-vs-b-m1-nuke.dem.part").write_bytes(b"x" * 5000)
    assert dp.Pipeline().disk_usage()[0] >= 5000


def test_the_fetcher_keeps_the_floor_after_what_downloads_in_progress_still_write(tmp_path, monkeypatch):
    # Review of PR 67: each start checked only its own size against the free space, so two starts in a row could
    # together pass the floor.
    status = dict(capacity=True, want=4, pending=0, extracting=0)
    monkeypatch.setattr(fo.shutil, "disk_usage", lambda p: shutil._ntuple_diskusage(0, 0, int(50e9)))
    assert fo.room(status, 1, 2.0, tmp_path, 45.0, reserved_gb=0.0) is None
    assert "still to come" in fo.room(status, 1, 2.0, tmp_path, 45.0, reserved_gb=4.0)


class _HuggingFace:
    """Serves one stored file the way Hugging Face does: resolve/<path> redirects (302) to the blob with the file's
    SHA-256 and size in X-Linked-ETag and X-Linked-Size; the blob honours Range. bad: blob bodies to send wrong,
    one per request, before right ones; fail: blob requests to answer 500 first; extra: bytes sent after the file,
    with no Content-Length if length is False. The first ranged blob request pauses after its first 100 bytes until
    release is set."""

    def __init__(self, data: bytes, bad: list[bytes] = (), fail: int = 0, extra: bytes = b"", length: bool = True):
        self.data, self.bad, self.fail, self.extra, self.length = data, list(bad), fail, extra, length
        self.ranges, self.paused, self.release = [], threading.Event(), threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _redirect(self):
                self.send_response(302)
                self.send_header("Location", "/blob")
                self.send_header("X-Linked-ETag", f'"{hashlib.sha256(outer.data).hexdigest()}"')
                self.send_header("X-Linked-Size", str(len(outer.data)))
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_HEAD(self):  # noqa: N802 - http.server naming
                self._redirect()

            def do_GET(self):  # noqa: N802
                if self.path != "/blob":
                    return self._redirect()
                if outer.fail:
                    outer.fail -= 1
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                data = outer.bad.pop(0) if outer.bad else outer.data
                rng = self.headers.get("Range")
                outer.ranges.append(rng)
                start = int(rng.removeprefix("bytes=").split("-")[0]) if rng else 0
                body = data[start:] + outer.extra
                self.send_response(206 if rng else 200)
                if rng:
                    self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
                if outer.length:
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
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/resolve/"


DEMO = dp.DEM_MAGIC + bytes(range(256)) * 40
MAP = fo.Map("2390001", 1, "de_nuke", "demos/shard-x/2390001/team-a-vs-team-b-m1-nuke.dem", len(DEMO), None)


def test_a_resumed_download_completes_and_only_then_appears_in_the_inbox(tmp_path):
    # The pipeline takes any .dem in the inbox at once: a partial demo, or one whose sidecar is not written yet, would
    # be parsed broken or refused. A stopped download resumes from where its .part ends.
    inbox = tmp_path / "inbox"
    final = MAP.target(inbox)
    final.parent.mkdir(parents=True)
    part = final.with_name(final.name + ".part")
    part.write_bytes(DEMO[:1000])  # what a stopped run left
    server = _HuggingFace(DEMO)
    try:
        done = []
        t = threading.Thread(target=lambda: done.append(fo.download(MAP, server.url + MAP.file_name, inbox,
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
    assert final.read_bytes() == DEMO and not part.exists()
    assert dp.read_sidecar(final) == dict(source="opencs2", hltv_match_id="2390001", hltv_map_index=1,
                                          map_name="de_nuke", dataset_file=MAP.file_name, dem_bytes=len(DEMO),
                                          sha256=hashlib.sha256(DEMO).hexdigest(), match_date=None)


def test_a_partial_download_that_does_not_hash_right_is_fetched_again_then_given_up(tmp_path):
    # Review of PR 67: resume checked only where the range began, so a .part with wrong bytes (another file under the
    # same name, a broken write) became a demo. The whole file must hash to the SHA-256 Hugging Face names.
    inbox = tmp_path / "inbox"
    final = MAP.target(inbox)
    final.parent.mkdir(parents=True)
    final.with_name(final.name + ".part").write_bytes(b"wrong" * 200)  # what a broken run left
    server = _HuggingFace(DEMO)
    server.release.set()
    try:
        assert fo.download(MAP, server.url + MAP.file_name, inbox, threading.Event())
        assert server.ranges == ["bytes=1000-", None] and final.read_bytes() == DEMO
        final.unlink()
        dp.sidecar_path(final).unlink()
        server.bad = [DEMO[:-1] + b"!", DEMO[:-1] + b"?"]  # the same size, other bytes, twice
        with pytest.raises(ValueError, match="downloaded twice, and the SHA-256 is"):
            fo.download(MAP, server.url + MAP.file_name, inbox, threading.Event())
    finally:
        server.httpd.shutdown()
    assert not final.exists() and not dp.sidecar_path(final).exists()


def test_a_failed_download_is_tried_again_after_1_2_4_and_8_minutes(tmp_path, monkeypatch):
    # A transient server error gave the map up for the run; retrying at once would hammer a struggling server. The
    # clock is fake and moves only while the fetcher waits, so the starts are exact.
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    server = _HuggingFace(DEMO, fail=4)
    server.release.set()
    monkeypatch.setattr(fo, "pipeline_status", lambda url: dict(capacity=True, want=4, pending=0, extracting=0))
    now, starts, real = [0.0], [], fo.download
    monkeypatch.setattr(fo, "download", lambda *a: (starts.append(now[0]), real(*a))[1])
    try:
        results = fo.run([MAP], inbox, "unused", 1, 0.0, threading.Event(), base_url=server.url,
                         clock=lambda: now[0], wait=lambda s: now.__setitem__(0, now[0] + s))
    finally:
        server.httpd.shutdown()
    assert results == {"opencs2-2390001-m1": "done"} and MAP.target(inbox).read_bytes() == DEMO
    assert [b - a for a, b in zip(starts, starts[1:])] == [60.0, 120.0, 240.0, 480.0]


@pytest.mark.parametrize("length", [True, False])
def test_a_download_never_writes_past_the_files_size(tmp_path, length):
    # Review 3 of PR 67: the fetcher wrote whatever the server sent, so a server sending more (with no length, or a
    # wrong one) could fill the disk past the floor the fetcher keeps.
    inbox = tmp_path / "inbox"
    server = _HuggingFace(DEMO, extra=b"x" * 50_000, length=length)
    server.release.set()
    try:
        with pytest.raises(ValueError, match=f"not the {len(DEMO)} left" if length else "sent more than"):
            fo.download(MAP, server.url + MAP.file_name, inbox, threading.Event())
    finally:
        server.httpd.shutdown()
    final = MAP.target(inbox)
    part = final.with_name(final.name + ".part")
    assert not final.exists() and (part.stat().st_size if part.exists() else 0) <= len(DEMO)


def test_the_fetcher_never_claims_a_folder_that_holds_files(tmp_path):
    # The pipeline deletes the demos in a folder holding the marker; the fetcher, the other writer of the inbox, must
    # not write it into a folder that is in use.
    used = tmp_path / "used"
    used.mkdir()
    (used / "match.dem").write_bytes(b"x")
    with pytest.raises(SystemExit):
        fo.main(["--inbox", str(used), "--dry-run"])
    assert not (used / dp.INBOX_MARKER).exists()


def test_the_fetcher_skips_maps_already_published_or_without_a_scoreboard(tmp_path):
    # Fetching a map the pipeline already published (or failed) costs half a gigabyte for nothing; one with no saved
    # HLTV scoreboard cannot be joined, so it is no rating data. A scoreboard is matched by match and map name: the
    # dataset's map index named another map than HLTV's on 6 of 1,148 saved scoreboards.
    meta, hltv, inbox = tmp_path / "meta", tmp_path / "hltv", tmp_path / "inbox"
    for d in (meta, hltv, inbox):
        d.mkdir()
    rows = [dict(match_id=mid, map_index=i, map_name=mp, file_name=f"demos/s/{mid}/a-vs-b-m{i}-{mp[3:]}.dem",
                 demo_bytes=100, match_date=None) for mid, i, mp in
            (("1", 1, "de_nuke"), ("1", 2, "de_dust2"), ("2", 1, "de_mirage"), ("3", 1, "de_ancient"))]
    pl.DataFrame(rows).with_columns(pl.col("map_index").cast(pl.Int32), pl.col("match_date").cast(pl.Datetime("ms", "UTC"))) \
        .write_parquet(meta / "metadata-x.parquet")
    # match 3 has no saved scoreboard; match 1's second map is saved under index 3, as HLTV numbered it
    for n, (mid, i, mp) in enumerate([("1", 1, "Nuke"), ("1", 3, "Dust2"), ("2", 1, "Mirage")]):
        (hltv / f"ocs_map_{n}.json").write_text(json.dumps(dict(mapIndex=i, match=dict(matchId=mid),
                                                                info=[f"Event2026-04-01 12:00Map{mp}a13b7"])),
                                                encoding="utf-8")
    ledger = tmp_path / "archives.jsonl"
    dp.append_jsonl(ledger, dict(id="opencs2-1-m1", status="done"))
    dp.append_jsonl(ledger, dict(id="opencs2-2-m1", status="failed"))
    todo = fo.plan(fo.dataset_maps(meta), fo.held_scoreboards(hltv), dp.read_ledger(ledger), inbox)
    assert [(m.match_id, m.map_index) for m in todo] == [("1", 2)]
    # the pipeline later deletes the kept failure under its failed/ cap: its last row says dropped, and the map is
    # fetched again; skipping it as recorded would lose it for good
    dp.append_jsonl(ledger, dict(id="opencs2-2-m1", status="dropped"))
    todo = fo.plan(fo.dataset_maps(meta), fo.held_scoreboards(hltv), dp.read_ledger(ledger), inbox)
    assert [(m.match_id, m.map_index) for m in todo] == [("1", 2), ("2", 1)]
