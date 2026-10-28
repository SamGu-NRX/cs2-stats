"""Download OpenCS2 demos of maps whose HLTV scoreboard we hold into the pipeline's loose-demo inbox.

The OpenCS2 dataset (blanchon/opencs2_dataset_demo on Hugging Face, CC BY 4.0; THIRD_PARTY_NOTICES.md) holds HLTV
pro maps as loose .dem files. This picks the maps whose HLTV scoreboard is saved in <data>/hltv, matched by HLTV
match id and map name (a map is played once in a match; the dataset's map index names another map than HLTV's on 6 of
the 1,148 saved scoreboards), leaves out those the pipeline's ledger already holds (published, failed or refused) and
those already in the inbox, and downloads the rest, oldest first.

Each demo goes to <inbox>/<match id>/<dataset file name>.part, resumed with an HTTP Range request after a stop.
Hugging Face names each file's size and SHA-256 (X-Linked-Size, X-Linked-ETag on the resolve redirect); a resumed
response must cover the rest of exactly that size, and the whole file must hash to that SHA-256. A mismatch discards
the .part and starts over once; a second fails the map. Only then is its sidecar <name>.meta.json written (the
dataset path, size and SHA-256 with the ids, which the pipeline checks), and the .part renamed to <name>.dem, so the
pipeline never sees a partial demo or one without its sidecar (demo_pipeline.read_sidecar). The inbox must be one
made for the pipeline (demo_pipeline.claim_inbox); this claims a missing or empty folder.

Pacing: a download starts only while the pipeline's /pending says there is room (downloading + pending + extracting
below want, and capacity), the inbox's volume keeps the pipeline's free-space floor after it and after what the
downloads in progress still have to write, and fewer than --concurrency (at most 2) run. A failed download is tried
again after 1, 2, 4 and 8 minutes, then given up for this run. Ctrl+C stops cleanly; partial files stay for the next
run to resume.

Run:  .venv\\Scripts\\python.exe -I fetch_opencs2.py --limit 3     (the inbox from CS2_DEMO_INBOX or --inbox)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves this folder off sys.path

import demo_pipeline as dp  # noqa: E402
from repo_guard import check_output  # noqa: E402

DATASET = "blanchon/opencs2_dataset_demo"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main/"
USER_AGENT = "cs2-stats-opencs2-fetcher/1 (+https://github.com/SamGu-NRX/cs2-stats)"
MAX_CONCURRENCY = 2
CHUNK = 1 << 20
WAIT_S = 15.0  # between checks of /pending and free space while there is no room
RETRY_S = 60.0  # the first wait after a failed download, doubled after each further failure
ATTEMPTS = 5  # downloads of one map per run before it is given up
log = logging.getLogger("fetch_opencs2")


@dataclass(frozen=True)
class Map:
    match_id: str
    map_index: int
    map_name: str
    file_name: str  # the dataset's path, e.g. demos/shard-<...>/<match id>/<team1>-vs-<team2>-m1-dust2.dem
    demo_bytes: int
    match_date: str | None

    @property
    def ids(self) -> dict:
        return dict(source="opencs2", hltv_match_id=self.match_id, hltv_map_index=self.map_index)

    def sidecar(self, sha256: str) -> dict:
        return dict(self.ids, map_name=self.map_name, dataset_file=self.file_name, dem_bytes=self.demo_bytes,
                    sha256=sha256, match_date=self.match_date)

    def target(self, inbox: Path) -> Path:
        return inbox / self.match_id / Path(self.file_name).name


HLTV_MAP = re.compile(r"Map(Ancient|Anubis|Cache|Dust2|Inferno|Mirage|Nuke|Overpass|Train|Vertigo)")


def held_scoreboards(hltv_dir: Path) -> set[tuple[str, str]]:
    """(HLTV match id, map name without de_) of every saved HLTV map, from its match block and its info line."""
    held = set()
    for path in [*hltv_dir.glob("ocs_map_*.json"), *hltv_dir.glob("map_*.json")]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
            log.warning("cannot read %s: %s", path.name, e)
            continue
        match_id = (data.get("match") or {}).get("matchId")
        found = HLTV_MAP.search(str((data.get("info") or [""])[0]))
        if match_id and found:
            held.add((str(match_id), found[1].lower()))
    return held


def dataset_maps(meta_dir: Path) -> list[Map]:
    import polars as pl
    files = sorted(meta_dir.glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"no metadata parquet in {meta_dir}")
    df = pl.read_parquet(files, columns=["match_id", "map_index", "map_name", "file_name", "demo_bytes", "match_date"])
    return [Map(str(r["match_id"]), int(r["map_index"]), r["map_name"], r["file_name"], int(r["demo_bytes"]),
                r["match_date"].isoformat() if r["match_date"] is not None else None)
            for r in df.sort(["match_date", "match_id", "map_index"], nulls_last=True).iter_rows(named=True)]


def plan(maps: list[Map], held: set[tuple[str, str]], ledger: dict[str, dict], inbox: Path) -> list[Map]:
    """The maps to download: their HLTV scoreboard is held, the ledger has no record of their id (published, failed
    or refused), and the inbox does not hold them. A "dropped" row counts as no record: the pipeline wrote it when it
    deleted a kept failure to stay under its cap, so the demo is gone and is to be fetched again."""
    def recorded(aid: str) -> bool:
        return aid in ledger and ledger[aid].get("status") != "dropped"
    return [m for m in maps if (m.match_id, m.map_name.lower().removeprefix("de_")) in held
            and not recorded(dp.loose_id(m.ids)) and not m.target(inbox).exists()]


def room(status: dict, ours: int, need_gb: float, inbox: Path, floor_gb: float, reserved_gb: float = 0.0) -> str | None:
    """Why a download may not start now, or None. ours: downloads of this fetcher in progress; reserved_gb: what they
    still have to write."""
    if not status:
        return "the pipeline's status is not available"
    if not status.get("capacity", False):
        return "the pipeline reports no capacity"
    busy = ours + status.get("pending", 0) + status.get("extracting", 0)
    if busy >= status.get("want", 0):
        return f"{busy} demos in flight, the pipeline wants {status.get('want', 0)}"
    free = shutil.disk_usage(inbox).free / 1e9
    if free - reserved_gb - need_gb < floor_gb:
        return (f"{free:.1f} GB free less {reserved_gb:.1f} GB still to come and {need_gb:.1f} GB would pass the "
                f"{floor_gb:.0f} GB floor")
    return None


def pipeline_status(url: str) -> dict:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=10) as r:
            return json.loads(r.read())
    except (OSError, ValueError) as e:
        log.warning("cannot read %s: %s", url, e)
        return {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def remote_facts(url: str) -> tuple[str, int]:
    """(SHA-256, size) Hugging Face names for a stored file, from the headers of its resolve redirect."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        r = urllib.request.build_opener(_NoRedirect).open(req, timeout=60)
        headers = r.headers
    except urllib.error.HTTPError as e:  # the redirect itself, not followed
        headers = e.headers
    sha, size = (headers.get("X-Linked-ETag") or "").strip('"').lower(), headers.get("X-Linked-Size")
    if not re.fullmatch(r"[0-9a-f]{64}", sha) or not str(size).isdigit():
        raise ValueError(f"{url}: no SHA-256 and size in the response (X-Linked-ETag {sha!r}, X-Linked-Size {size!r})")
    return sha, int(size)


def file_sha256(path: Path, stop: threading.Event) -> str | None:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while not stop.is_set():
            block = f.read(CHUNK)
            if not block:
                return h.hexdigest()
            h.update(block)
    return None


def fetch_rest(url: str, part: Path, size: int, stop: threading.Event) -> bool:
    """Write the rest of the file into part: resumed with a Range request whose response must cover exactly the rest
    of size bytes, or from the start. False if stopped first."""
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0
    if have == size:
        return True
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **({"Range": f"bytes={have}-"} if have else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        if have and not (r.status == 206 and r.headers.get("Content-Range", "") == f"bytes {have}-{size - 1}/{size}"):
            if r.status == 206:  # another range or another total: nothing of it can be appended
                raise ValueError(f"{part.name}: asked for bytes {have}- of {size}, got {r.headers.get('Content-Range')}")
            have = 0  # the server sent the whole file: start over
        left = size - have
        if r.headers.get("Content-Length") not in (None, str(left)):
            raise ValueError(f"{part.name}: the server sends {r.headers.get('Content-Length')} bytes, "
                             f"not the {left} left")
        written = 0
        with open(part, "ab" if have else "wb") as f:
            while not stop.is_set() and written < left:  # never past the file's size, whatever the server sends
                block = r.read(min(CHUNK, left - written))
                if not block:
                    break
                f.write(block)
                written += len(block)
        if not stop.is_set() and written == left and r.read(1):
            raise ValueError(f"{part.name}: the server sent more than the {left} bytes left")
    return not stop.is_set()


def download(m: Map, url: str, inbox: Path, stop: threading.Event) -> bool:
    """Fetch m into the inbox, resuming its .part; True once <name>.dem and its sidecar are in place, False if stopped.
    Raises when the file does not match the size and SHA-256 Hugging Face names, twice, so a wrong file never reaches
    the pipeline."""
    final = m.target(inbox)
    part = final.with_name(final.name + ".part")
    final.parent.mkdir(parents=True, exist_ok=True)
    sha, size = remote_facts(url)
    if size != m.demo_bytes:
        raise ValueError(f"{m.file_name}: the dataset lists {m.demo_bytes} bytes, Hugging Face {size}")
    for attempt in (1, 2):
        if not fetch_rest(url, part, size, stop):
            return False
        got = file_sha256(part, stop)
        if got is None:
            return False
        if got == sha and part.stat().st_size == size:
            break
        part.unlink()
        if attempt == 2:
            raise ValueError(f"{m.file_name}: downloaded twice, and the SHA-256 is {got}, not {sha}")
        log.warning("%s: SHA-256 %s, not %s; downloading it again from the start", m.file_name, got, sha)
    side = dp.sidecar_path(final)
    staged = side.with_name(side.name + ".tmp")
    staged.write_text(json.dumps(m.sidecar(sha), indent=1), encoding="utf-8")
    os.replace(staged, side)  # the sidecar first: the pipeline reads it as soon as it sees the .dem
    os.replace(part, final)
    return True


def run(todo: list[Map], inbox: Path, status_url: str, concurrency: int, floor_gb: float, stop: threading.Event,
        base_url: str = BASE_URL, wait_s: float = WAIT_S, retry_s: float = RETRY_S, clock=None,
        wait=None) -> dict[str, str]:
    """Download todo in order, paced by room(); {loose id: done | stopped | error: ...}. A failed map is queued again
    after retry_s, doubling, up to ATTEMPTS downloads. clock and wait (seconds) default to the monotonic clock and the
    stop event's wait."""
    clock, wait = clock or time.monotonic, wait or stop.wait
    results: dict[str, str] = {}
    running: dict[str, tuple[threading.Thread, Map]] = {}
    tries: dict[str, int] = {}
    lock = threading.Lock()

    def work(m: Map) -> None:
        key = dp.loose_id(m.ids)
        try:
            outcome = "done" if download(m, base_url + m.file_name, inbox, stop) else "stopped"
        except (OSError, ValueError, urllib.error.URLError) as e:
            outcome = f"error: {type(e).__name__}: {e}"
        with lock:
            results[key] = outcome
        log.info("%s %s", key, outcome)

    def left_to_write(m: Map) -> int:
        part = m.target(inbox).with_name(m.target(inbox).name + ".part")
        return max(0, m.demo_bytes - (part.stat().st_size if part.exists() else 0))

    queue = [(clock(), m) for m in todo]  # (not before, map)
    try:
        while (queue or running) and not stop.is_set():
            for key in [k for k, (t, _) in running.items() if not t.is_alive()]:
                _, m = running.pop(key)
                tries[key] = tries.get(key, 0) + 1
                if results.get(key, "").startswith("error") and tries[key] < ATTEMPTS:
                    delay = retry_s * 2 ** (tries[key] - 1)
                    log.info("%s: trying again in %.0f s (attempt %d of %d)", key, delay, tries[key] + 1, ATTEMPTS)
                    queue.append((clock() + delay, m))
            now = clock()
            ready = [i for i, (t0, _) in enumerate(queue) if t0 <= now]
            if ready and len(running) < concurrency:
                m = queue[ready[0]][1]
                reserved = sum(left_to_write(r) for _, r in running.values()) / 1e9
                why = room(pipeline_status(status_url), len(running), left_to_write(m) / 1e9, inbox, floor_gb, reserved)
                if why is None:
                    queue.pop(ready[0])
                    key = dp.loose_id(m.ids)
                    log.info("downloading %s (%s, %.0f MB)", key, Path(m.file_name).name, m.demo_bytes / 1e6)
                    running[key] = (threading.Thread(target=work, args=(m,), name=key, daemon=True), m)
                    running[key][0].start()
                    continue
                log.info("waiting: %s", why)
            if running:  # a download's end is what can change; wait for it, up to a while
                next(iter(running.values()))[0].join(wait_s if ready else 1.0)
            else:  # until the next retry is due, or a while if room was what lacked
                wait(wait_s if ready else min((t0 - now for t0, _ in queue), default=wait_s))
    except KeyboardInterrupt:
        log.info("stopping; partial downloads stay for the next run to resume")
        stop.set()
    for t, _ in running.values():  # each stops after its current block once stop is set
        t.join()
    return results


def main(argv=None) -> int:
    data = dp.DATA_ROOT
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--inbox", type=Path, default=dp.INBOX, help="the pipeline's CS2_DEMO_INBOX")
    ap.add_argument("--meta", type=Path, default=data / "external" / "opencs2-meta" / "data",
                    help="the dataset's metadata parquet folder")
    ap.add_argument("--hltv", type=Path, default=data / "hltv", help="saved HLTV scoreboards")
    ap.add_argument("--ledger", type=Path, default=dp.LEDGER, help="the pipeline's archives.jsonl")
    ap.add_argument("--status", default=f"http://{dp.HOST}:{dp.PORT}/pending", help="the pipeline's status URL")
    ap.add_argument("--limit", type=int, default=0, help="download at most this many maps (0: all that qualify)")
    ap.add_argument("--concurrency", type=int, default=MAX_CONCURRENCY, choices=range(1, MAX_CONCURRENCY + 1))
    ap.add_argument("--dry-run", action="store_true", help="list what would be downloaded, and stop")
    a = ap.parse_args(argv)
    if a.inbox is None:
        ap.error("set CS2_DEMO_INBOX or pass --inbox")
    check_output(a.inbox, private=True, what="the OpenCS2 demos")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    why = dp.claim_inbox(a.inbox, dp.DATA_ROOT, dp.DOWNLOADS)
    if why:
        ap.error(f"{a.inbox} cannot be the inbox: {why}")
    todo = plan(dataset_maps(a.meta), held_scoreboards(a.hltv), dp.read_ledger(a.ledger), a.inbox)
    if a.limit:
        todo = todo[:a.limit]
    log.info("%d maps to download, %.1f GB", len(todo), sum(m.demo_bytes for m in todo) / 1e9)
    if a.dry_run:
        for m in todo:
            print(dp.loose_id(m.ids), m.file_name, m.demo_bytes)
        return 0
    stop = threading.Event()
    results = run(todo, a.inbox, a.status, a.concurrency, dp.MIN_FREE_GB, stop)
    if stop.is_set():
        return 130
    bad = {k: v for k, v in results.items() if v != "done"}
    print(json.dumps(dict(done=sum(v == "done" for v in results.values()), other=bad), indent=1))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
