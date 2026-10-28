"""Download OpenCS2 demos of maps whose HLTV scoreboard we hold into the pipeline's loose-demo inbox.

The OpenCS2 dataset (blanchon/opencs2_dataset_demo on Hugging Face, CC BY 4.0; THIRD_PARTY_NOTICES.md) holds HLTV
pro maps as loose .dem files. This picks the maps whose HLTV scoreboard is saved in <data>/hltv (ocs_map_*.json and
map_*.json carry the HLTV match id and map index), leaves out those the pipeline's ledger already holds (published,
failed or refused) and those already in the inbox, and downloads the rest, oldest first.

Each demo goes to <inbox>/<match id>/<dataset file name>.part, resumed with an HTTP Range request after a stop.
When it is whole (its size is the metadata's demo_bytes and it starts with the demo magic bytes), its sidecar
<name>.meta.json is written, and then the .part is renamed to <name>.dem, so the pipeline never sees a partial demo
or one without its sidecar (demo_pipeline.read_sidecar).

Pacing: a download starts only while the pipeline's /pending says there is room (downloading + pending + extracting
below want, and capacity), the inbox's volume keeps the pipeline's free-space floor after it, and fewer than
--concurrency (at most 2) run. Ctrl+C stops cleanly; partial files stay for the next run to resume.

Run:  .venv\\Scripts\\python.exe -I fetch_opencs2.py --limit 3     (the inbox from CS2_DEMO_INBOX or --inbox)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
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
    def sidecar(self) -> dict:
        return dict(source="opencs2", hltv_match_id=self.match_id, hltv_map_index=self.map_index,
                    map_name=self.map_name, dataset_file=self.file_name, match_date=self.match_date)

    def target(self, inbox: Path) -> Path:
        return inbox / self.match_id / Path(self.file_name).name


def held_scoreboards(hltv_dir: Path) -> set[tuple[str, int]]:
    """(HLTV match id, map index) of every saved HLTV map that names both."""
    held = set()
    for path in [*hltv_dir.glob("ocs_map_*.json"), *hltv_dir.glob("map_*.json")]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
            log.warning("cannot read %s: %s", path.name, e)
            continue
        match_id, index = (data.get("match") or {}).get("matchId"), data.get("mapIndex")
        if match_id and isinstance(index, int):
            held.add((str(match_id), index))
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


def plan(maps: list[Map], held: set[tuple[str, int]], ledger: dict[str, dict], inbox: Path) -> list[Map]:
    """The maps to download: their HLTV scoreboard is held, the ledger has no record of their id (published, failed
    or refused), and the inbox does not hold them."""
    return [m for m in maps if (m.match_id, m.map_index) in held
            and dp.loose_id(m.sidecar) not in ledger and not m.target(inbox).exists()]


def room(status: dict, ours: int, need_gb: float, inbox: Path, floor_gb: float) -> str | None:
    """Why a download may not start now, or None. ours: downloads of this fetcher in progress."""
    if not status:
        return "the pipeline's status is not available"
    if not status.get("capacity", False):
        return "the pipeline reports no capacity"
    busy = ours + status.get("pending", 0) + status.get("extracting", 0)
    if busy >= status.get("want", 0):
        return f"{busy} demos in flight, the pipeline wants {status.get('want', 0)}"
    free = shutil.disk_usage(inbox).free / 1e9
    if free - need_gb < floor_gb:
        return f"{free:.1f} GB free less {need_gb:.1f} GB would pass the {floor_gb:.0f} GB floor"
    return None


def pipeline_status(url: str) -> dict:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=10) as r:
            return json.loads(r.read())
    except (OSError, ValueError) as e:
        log.warning("cannot read %s: %s", url, e)
        return {}


def download(m: Map, url: str, inbox: Path, stop: threading.Event) -> bool:
    """Fetch m into the inbox, resuming its .part; True once <name>.dem and its sidecar are in place. Raises on a
    size or content mismatch, so a wrong file never reaches the pipeline."""
    final = m.target(inbox)
    part = final.with_name(final.name + ".part")
    final.parent.mkdir(parents=True, exist_ok=True)
    have = part.stat().st_size if part.exists() else 0
    if have > m.demo_bytes:
        part.unlink()
        have = 0
    if have < m.demo_bytes:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **({"Range": f"bytes={have}-"} if have else {})})
        with urllib.request.urlopen(req, timeout=60) as r:
            if have and not (r.status == 206 and r.headers.get("Content-Range", "").startswith(f"bytes {have}-")):
                have = 0  # the server sent the whole file, or another range: start over
            with open(part, "ab" if have else "wb") as f:
                while not stop.is_set():
                    block = r.read(CHUNK)
                    if not block:
                        break
                    f.write(block)
        if stop.is_set():
            return False
    size = part.stat().st_size
    if size != m.demo_bytes:
        raise ValueError(f"{part.name}: {size} bytes, the dataset lists {m.demo_bytes}")
    with open(part, "rb") as f:
        if f.read(len(dp.DEM_MAGIC)) != dp.DEM_MAGIC:
            raise ValueError(f"{part.name} is not a CS2 demo")
    side = dp.sidecar_path(final)
    staged = side.with_name(side.name + ".tmp")
    staged.write_text(json.dumps(m.sidecar, indent=1), encoding="utf-8")
    os.replace(staged, side)  # the sidecar first: the pipeline reads it as soon as it sees the .dem
    os.replace(part, final)
    return True


def run(todo: list[Map], inbox: Path, status_url: str, concurrency: int, floor_gb: float, stop: threading.Event,
        base_url: str = BASE_URL, wait_s: float = WAIT_S) -> dict[str, str]:
    """Download todo in order, paced by room(); {loose id: done | stopped | error: ...}."""
    results: dict[str, str] = {}
    running: dict[str, threading.Thread] = {}
    lock = threading.Lock()

    def work(m: Map) -> None:
        key = dp.loose_id(m.sidecar)
        try:
            outcome = "done" if download(m, base_url + m.file_name, inbox, stop) else "stopped"
        except (OSError, ValueError, urllib.error.URLError) as e:
            outcome = f"error: {type(e).__name__}: {e}"
        with lock:
            results[key] = outcome
        log.info("%s %s", key, outcome)

    queue = list(todo)
    try:
        while (queue or running) and not stop.is_set():
            for key in [k for k, t in running.items() if not t.is_alive()]:
                del running[key]
            if queue and len(running) < concurrency:
                m = queue[0]
                why = room(pipeline_status(status_url), len(running), m.demo_bytes / 1e9, inbox, floor_gb)
                if why is None:
                    queue.pop(0)
                    key = dp.loose_id(m.sidecar)
                    log.info("downloading %s (%s, %.0f MB)", key, Path(m.file_name).name, m.demo_bytes / 1e6)
                    running[key] = threading.Thread(target=work, args=(m,), name=key, daemon=True)
                    running[key].start()
                    continue
                log.info("waiting: %s", why)
            stop.wait(wait_s if queue else 1.0)
    except KeyboardInterrupt:
        log.info("stopping; partial downloads stay for the next run to resume")
        stop.set()
    for t in running.values():  # each stops after its current block once stop is set
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
    todo = plan(dataset_maps(a.meta), held_scoreboards(a.hltv), dp.read_ledger(a.ledger), a.inbox)
    if a.limit:
        todo = todo[:a.limit]
    log.info("%d maps to download, %.1f GB", len(todo), sum(m.demo_bytes for m in todo) / 1e9)
    if a.dry_run:
        for m in todo:
            print(dp.loose_id(m.sidecar), m.file_name, m.demo_bytes)
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
