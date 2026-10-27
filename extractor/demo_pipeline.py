"""Turn downloaded HLTV demo archives into per-map parquet tables, then delete the demos.

Watches the browser's download folder for RAR archives, extracts their .dem
files with 7-Zip, parses each demo in its own worker process (extract.py), and
deletes the .dem files and the RAR once every map of that archive is written
and validated. A failed archive keeps its RAR, moved to failed/ with the reason.
Status is served on http://127.0.0.1:8766/pending for the HLTV tab that paces
downloads.

Run:  .venv\\Scripts\\python.exe -I demo_pipeline.py            (runs until stopped)
      .venv\\Scripts\\python.exe -I demo_pipeline.py --once     (exit when idle)
      add --retry-failed to also pick up RARs in failed/ (each failed demo once per extractor version)
Environment: CS2_DEMO_DOWNLOADS (required), CS2_STATS_DATA, CS2_PIPELINE_MAX_GB (disk budget, default 30),
CS2_PIPELINE_MAX_WORKERS (optional cap on parse workers; memory and cpu_count - 2 set the rest),
CS2_PIPELINE_DOWNLOAD_COPIES (off, dry-run or delete; default dry-run): what to do with the copy of each finished
archive that the browser also saves to Windows Downloads (download_copies.py).
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parent  # code
sys.path.insert(0, str(ROOT))  # -I drops the script dir from sys.path; extract.py lives next to this file
import download_copies  # noqa: E402
import extract  # noqa: E402
import stitch  # noqa: E402
from repo_guard import FROZEN_MARKER, REPO_ENV, OutputRefused, check_output, repo_root  # noqa: E402

# The browser's download folder the HLTV tab saves archives to (CS2_DEMO_DOWNLOADS); main() refuses
# to start without it. The data folder (CS2_STATS_DATA) defaults to cs2-stats-data beside the repo.
DOWNLOADS: Path | None = Path(os.environ["CS2_DEMO_DOWNLOADS"]) if os.environ.get("CS2_DEMO_DOWNLOADS") else None
DATA_ROOT = Path(os.environ.get("CS2_STATS_DATA") or ROOT.parent.parent / "cs2-stats-data")  # data; holds no code
DEMOS_DIR = DATA_ROOT / "demos"
WORK_DIR = DATA_ROOT / "work"
FAILED_DIR = DATA_ROOT / "failed"
# A split recording's parts (<map>-pN) are written here, never to demos/, and joined into one map in demos/ when
# stitch.plan allows; parts.jsonl here records each split map's outcome.
PARTS_DIR = DATA_ROOT / "parts"
LOG_DIR = DATA_ROOT / "logs"
# awpy-data release 2000935 was built from CS2 1.41.9.2 (Steam build 26144732), the build installed
# locally; extract.py withholds mesh visibility for any map whose mesh disagrees with the demo.
MAPDATA = DATA_ROOT / "mapdata" / "2000935"
MANIFEST = DEMOS_DIR / "manifest.jsonl"
LEDGER = DEMOS_DIR / "archives.jsonl"  # one line per finished archive, done or failed
DROPPED = DEMOS_DIR / "failed_dropped.jsonl"  # failed archives deleted because failed/ was full
# The browser's second copy of each archive, in Windows Downloads. Only a finished archive's copy is deleted: a
# failed archive's copy is kept, because failed/ deletes its oldest archives past MAX_FAILED_GB and the copy may
# then be the only one left to diagnose the failure. dry-run, the default, logs what delete would remove; delete
# is the user's choice, made knowing the one case it can remove a file of the user's (download_copies docstring).
COPIES_MODE = os.environ.get("CS2_PIPELINE_DOWNLOAD_COPIES") or "dry-run"
COPIES_LOG = LOG_DIR / "download_copies.jsonl"  # one line per candidate copy: deleted, would_delete or kept
# Maps written by an older extractor; a re-downloaded copy extracted now replaces the old folder.
NEEDS_REEXTRACT = DEMOS_DIR / "needs_reextract.jsonl"

RAR_MAGIC = b"Rar!\x1a\x07"  # shared prefix of RAR 4 (…\x00) and RAR 5 (…\x01\x00) signatures
PARTIAL_SUFFIXES = (".crdownload", ".part", ".partial", ".download", ".tmp")
STABLE_SECONDS = 10.0
# Disk budget (set by the user, who has limited disk): no new extraction when free space is
# below MIN_FREE_GB, or when the pipeline's transient data exceeds MAX_OUR_GB: archives waiting and downloading,
# work/, space held for running extractions, failed/, and parts/ (a split map's parts while they wait to be joined).
# demos/, the published tables, is the product and is not in the budget; the free-space floor on every volume
# bounds it.
# failed/ has its own cap: each failed archive is kept with its failing .dem files and their validation
# reports so the failure can be diagnosed, up to MAX_FAILED_GB; beyond that the oldest is logged and deleted.
# parts/ holds a split map's parts only while they are held back: a stitched map's parts are deleted, and beyond
# MAX_PARTS_GB the oldest held map's parts are deleted, each with a parts.jsonl row. One HLTV map's two parts took
# 1.3 and 4.4 MB, so the cap holds hundreds of held maps; it is not a measured need.
MIN_FREE_GB = 45.0
MAX_OUR_GB = float(os.environ.get("CS2_PIPELINE_MAX_GB") or 30)
MAX_FAILED_GB = 8.0
MAX_PARTS_GB = 2.0
TRUNCATED = "truncated_demo"  # fail_reason of a demo nothing can read to a complete round; never retried
STALE_WORK_S = 2 * 3600
WORK_SWEEP_S = 600
BUDGET_CACHE_S = 10.0
MAX_EXTRACTED = 2  # archives whose .dem files are on disk (extracting or parsing)
# Parse workers run as many as memory allows (worker_capacity): never more than cpu_count - 2, nor
# CS2_PIPELINE_MAX_WORKERS when set, nor GAMING_WORKERS while CS2 runs.


def max_workers_setting(raw: str | None) -> int | None:
    """CS2_PIPELINE_MAX_WORKERS as a cap, None when unset. Anything but a whole number of at least 1 raises: 0 or
    less would start no worker, and the pipeline would wait forever."""
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        n = 0
    if n < 1:
        raise ValueError(f"CS2_PIPELINE_MAX_WORKERS is {raw!r}; set a whole number of at least 1, or leave it unset")
    return n


try:
    MAX_WORKERS_SET, MAX_WORKERS_ERROR = max_workers_setting(os.environ.get("CS2_PIPELINE_MAX_WORKERS")), None
except ValueError as _e:  # main() refuses to start with this message
    MAX_WORKERS_SET, MAX_WORKERS_ERROR = None, str(_e)
GAMING_WORKERS = 1
# Memory floors, set by the user: RAM_HEADROOM_GB stays free for other work when sizing the pool, nothing starts
# below RAM_PRESSURE_GB available, and below RAM_KILL_GB the newest worker is killed and its demo requeued.
RAM_HEADROOM_GB = 3.0
RAM_PRESSURE_GB = 2.0
RAM_KILL_GB = 1.0
# A parse's peak RSS is the p90 of the last PEAK_SAMPLES measured peaks, seeded at startup from the manifest.
# With none measured, DEFAULT_PARSE_EST_GB stands in; it has no measurement behind it (the measured peaks
# noted at WORKER_RSS_LIMIT_GB are under 2 GB), so it starts fewer workers until real peaks arrive.
DEFAULT_PARSE_EST_GB = 4.0
PEAK_SAMPLES = 20
# want (desired_downloads) uses per-archive means over the last TIMING_SAMPLES archives: parse worker-seconds,
# seeded from the manifest, and download seconds, measured only in this run. How many more archives fit uses the
# largest of the last TIMING_SAMPLES archives (RAR plus listed demo bytes), not the mean: one large archive must
# not overrun the budget. The defaults stand in until then and have no measurement behind them.
DEFAULT_PARSE_S = 600.0
DEFAULT_DOWNLOAD_S = 120.0
DEFAULT_ARCHIVE_GB = 2.0
TIMING_SAMPLES = 20
# The free-space floor (MIN_FREE_GB) is a hard limit on starting work: an extraction starts only if the floor
# still holds after its listed demo bytes, an output estimate for each of its maps, and the estimates of the
# parses already running; a parse starts only if it holds after its own estimate and theirs. It assumes no
# other program fills the disk and no map writes more than the estimate: the p90 of the output size of the last
# TIMING_SAMPLES maps, seeded from the manifest. With none measured, DEFAULT_OUTPUT_GB stands in: the live
# manifest's 1,434 maps wrote at most 15.4 MB each (p90 7.7 MB).
DEFAULT_OUTPUT_GB = 0.02
MAX_WANT = 4
# Kill a worker above this RSS. Measured peaks: 1.05 GB (401 MB Nuke demo), 1.46 GB (670 MB Dust2).
WORKER_RSS_LIMIT_GB = 3.5
WORKER_TIMEOUT_S = 45 * 60
TRUNCATION_GRACE_S = 300  # a RAR that 7z calls truncated is re-watched if modified this recently
POLL_S = 2.0
HOST, PORT = "127.0.0.1", 8766
ALLOWED_ORIGIN = "https://www.hltv.org"

IDLE = getattr(subprocess, "IDLE_PRIORITY_CLASS", 0)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SEVEN_ZIP = shutil.which("7z") or "7z"

log = logging.getLogger("demo_pipeline")


# ---------------------------------------------------------------------------
# Detection (pure; unit-tested)
# ---------------------------------------------------------------------------

def is_rar(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(RAR_MAGIC)) == RAR_MAGIC
    except OSError:
        return False


def is_candidate_name(path: Path) -> bool:
    """Browser downloads land as extensionless uuid files; anything with an extension is ignored."""
    return path.suffix == "" and not path.name.startswith(".")


def has_partial_marker(path: Path) -> bool:
    """True if the file or any sibling in its folder looks like an in-progress download."""
    if path.name.lower().endswith(PARTIAL_SUFFIXES):
        return True
    try:
        return any(p.name.lower().endswith(PARTIAL_SUFFIXES) for p in path.parent.iterdir() if p != path)
    except OSError:
        return True


class CompletenessTracker:
    """A file is complete once its size has been unchanged for STABLE_SECONDS of our own observations."""

    def __init__(self, stable_seconds: float = STABLE_SECONDS):
        self.stable_seconds = stable_seconds
        self._seen: dict[Path, tuple[int, float]] = {}
        self._first: dict[Path, tuple[int, float]] = {}  # (size, time) when first observed

    def observe(self, path: Path, size: int, now: float) -> bool:
        self._first.setdefault(path, (size, now))
        prev = self._seen.get(path)
        if prev is None or prev[0] != size:
            self._seen[path] = (size, now)
            return False
        return size > 0 and now - prev[1] >= self.stable_seconds

    def forget(self, path: Path) -> None:
        self._seen.pop(path, None)
        self._first.pop(path, None)

    def last_change(self, path: Path) -> float | None:
        """When this run first saw the file at its current size, if its size changed while observed (a download
        seen in progress). None for a file already whole when first seen."""
        first, seen = self._first.get(path), self._seen.get(path)
        if first is None or seen is None or seen[0] == first[0]:
            return None
        return seen[1]

    def first_seen(self, path: Path) -> float | None:
        first = self._first.get(path)
        return None if first is None else first[1]

    def download_s(self, path: Path, now: float) -> float | None:
        """Seconds from the file's first observation to now, if its size changed in between (a download seen
        in progress). None for a file already whole when first seen: one waiting at startup, or one a browser
        moved in finished, whose download time is unknown."""
        first, seen = self._first.get(path), self._seen.get(path)
        if first is None or seen is None or seen[0] == first[0]:
            return None
        return now - first[1]

    def tracked(self) -> set[Path]:
        return set(self._seen)


def is_complete_rar(path: Path, tracker: CompletenessTracker, now: float) -> bool:
    try:
        size = path.stat().st_size
    except OSError:
        tracker.forget(path)
        return False
    stable = tracker.observe(path, size, now)
    return stable and not has_partial_marker(path) and is_rar(path)


# ---------------------------------------------------------------------------
# Archive state
# ---------------------------------------------------------------------------

@dataclass
class Archive:
    rar: Path
    id: str
    state: str = "pending"  # pending -> extracting -> parsing -> (done | failed)
    slug: str | None = None
    work: Path | None = None
    dems: list[Path] = field(default_factory=list)
    listing: dict = field(default_factory=dict)
    results: dict = field(default_factory=dict)
    out_dirs: dict = field(default_factory=dict)  # demo name -> the folder its job writes, as allocated
    # demo name -> (base map key, part number) for a part of a split recording, from its file name; its folder name
    # may carry a _dup suffix, so the identity is kept here and never read back from the folder
    split: dict = field(default_factory=dict)
    proc: subprocess.Popen | None = None
    extract_log: Path | None = None
    size_at_extract: int = 0
    t_extract: float = 0.0
    t_extract_s: float = 0.0
    worker_s: float = 0.0  # parse worker-seconds spent on its demos
    rar_bytes: int = 0  # the downloaded file as picked up: its size, SHA-256, and when its download began
    rar_sha256: str | None = None
    download_started: float = 0.0
    download_finished: float | None = None  # the first poll at its final size, for a download seen in progress
    archive_gb_counted: bool = False


@dataclass
class Job:
    archive: Archive
    dem: Path
    out_dir: Path
    map_key: str
    result_path: Path
    log_path: Path
    proc: subprocess.Popen | None = None
    t0: float = 0.0
    rss_gb: float = 0.0  # the worker's process tree, at the last poll
    kids: dict = field(default_factory=dict)  # pid -> psutil.Process the worker was seen to start
    peak_rss_gb: float = 0.0
    output_gb: float = 0.0  # space held for the tables it writes, fixed when it starts and released when it ends
    killed: str | None = None


def slug_for(dem_names: list[str], archive_id: str, legacy: bool = False) -> str:
    """The archive's folder name: its teams and its whole id. Extractors before 1.10.0 kept only the id's
    first 8 characters (legacy=True), so two archives could share a folder and write the same map path."""
    for n in dem_names:
        t1, t2 = extract.teams_from_filename(Path(n))
        if t1:
            prefix = f"{t1}-vs-{t2}-"
            # A RAR retried from failed/ is already named by its slug.
            return archive_id if archive_id.startswith(prefix) else f"{prefix}{archive_id[:8] if legacy else archive_id}"
    return archive_id


def _owned_by(folder: Path, archive_id: str) -> bool:
    """Whether a map in folder was extracted from archive_id (match.archive)."""
    import polars as pl
    for m in folder.iterdir():
        try:
            d = extract.resolve_map_dir(m) if m.is_dir() else None
            if d is not None and pl.read_parquet(d / "match.parquet", columns=["archive"])["archive"][0] == archive_id:
                return True
        except (OSError, ValueError, pl.exceptions.PolarsError) as e:  # an unreadable map proves nothing
            log.warning("cannot read the archive of %s: %s", m, e)
    return False


def maybe_demo(name: str) -> bool:
    """A file in an archive that may be a demo: a .dem, or a name with no extension made of letters, digits, "-" and
    "_" only. One HLTV archive held its two demos as "<team1>-vs-<team2>-m1-dust2" and "...-m2-ancient", each
    starting with the demo magic bytes; extracted_demos keeps an extensionless file only if it starts with them. The
    bare names become 7z file arguments, so one that 7z would read as a wildcard or an @list file is never listed."""
    n = Path(name.replace("\\", "/")).name
    return n.lower().endswith(".dem") or re.fullmatch(r"[A-Za-z0-9_-]+", n) is not None


DEM_MAGIC = b"PBDEMS2\x00"  # the first 8 bytes of a CS2 demo


def extracted_demos(work: Path) -> list[Path]:
    """The demos 7z extracted into work: every .dem, plus each extensionless file that starts with DEM_MAGIC, renamed
    to <name>.dem. Any other extensionless file is deleted; it is not a demo."""
    for f in sorted(p for p in work.iterdir() if p.is_file() and not p.suffix):
        with open(f, "rb") as fh:
            is_demo = fh.read(len(DEM_MAGIC)) == DEM_MAGIC
        target = f.with_name(f.name + ".dem")
        if is_demo and not target.exists():
            f.rename(target)
        else:
            log.warning("%s: %s", f, "a .dem of that name is in the archive too; deleted" if is_demo else "not a demo; deleted")
            safe_unlink(f)
    return sorted(work.glob("*.dem"))


def list_archive(rar: Path) -> dict[str, dict]:
    """Names, sizes and mtimes of the files inside the archive that may be demos (maybe_demo; 7z -slt listing)."""
    out = subprocess.run([SEVEN_ZIP, "l", "-slt", "-ba", "--", str(rar)], capture_output=True, text=True,
                         creationflags=IDLE | NO_WINDOW, timeout=120, encoding="utf-8", errors="replace")
    entries, cur = {}, {}
    for line in out.stdout.splitlines() + [""]:
        if not line.strip():
            if maybe_demo(cur.get("Path", "")) and cur.get("Folder") != "+":
                name = Path(cur["Path"].replace("\\", "/")).name
                entries[name] = dict(size=int(cur.get("Size") or 0), modified=cur.get("Modified"))
            cur = {}
            continue
        k, _, v = line.partition(" = ")
        cur[k.strip()] = v.strip()
    return entries


def cs2_running() -> bool:
    for p in psutil.process_iter(["name"]):
        try:
            if (p.info["name"] or "").lower() == "cs2.exe":
                return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return False


def available_gb() -> float:
    return psutil.virtual_memory().available / 1e9


def p90(values, default: float) -> float:
    """The 90th percentile (nearest rank) of values, or default when there are none."""
    ordered = sorted(values)
    return ordered[math.ceil(0.9 * len(ordered)) - 1] if ordered else default


def mean(values, default: float) -> float:
    return sum(values) / len(values) if values else default


def worker_capacity(avail_gb: float, parse_est_gb: float, growth_gb: float, running: int, cpu_count: int,
                    cs2: bool, cap: int | None = MAX_WORKERS_SET) -> int:
    """The most parse workers to run now, running ones included.

    Memory sets it: what is available, less RAM_HEADROOM_GB and less growth_gb, the RSS that running workers
    have yet to reach (each one's estimated peak minus its RSS now, so a burst of starts cannot overcommit),
    divided by the estimated peak of a new parse. Nothing new starts below RAM_PRESSURE_GB. With none running
    and RAM_PRESSURE_GB available, one may start even when the division gives none: a run on a copied archive
    with 6.8 GB available and the 4 GB default estimate waited 2.5 minutes for memory, and with other work
    holding it would wait for good. RAM_KILL_GB still guards that one. It is capped at cpu_count - 2, at cap
    when set, and at GAMING_WORKERS while CS2 runs.
    """
    limit = GAMING_WORKERS if cs2 else max(1, cpu_count - 2)
    if cap is not None:
        limit = min(limit, cap)
    if avail_gb < RAM_PRESSURE_GB:
        return min(limit, running)
    new = max(0, math.floor((avail_gb - RAM_HEADROOM_GB - growth_gb) / parse_est_gb))
    return min(limit, max(running + new, 1))


def desired_downloads(workers: int, parse_s: float, download_s: float, in_flight: int, room_gb: float,
                      archive_gb: float) -> int:
    """Archives to keep downloading, pending or extracting (the HLTV tab starts one while fewer are).

    Little's law: workers busy for parse_s worker-seconds per archive finish workers / parse_s archives a
    second, and a download takes download_s, so workers * download_s / parse_s downloads keep them fed; one
    more is the buffer. It is at most MAX_WANT, and at most in_flight plus the whole archives of archive_gb that
    room_gb (the disk budget and free-space floor left) still holds: with no room for one more, it is in_flight,
    0 when nothing is in flight, and the tab starts nothing.
    """
    keep = math.ceil(workers * download_s / max(parse_s, 1e-9)) + 1
    fits = in_flight + max(0, math.floor(room_gb / max(archive_gb, 1e-9)))
    return max(0, min(MAX_WANT, keep, fits))


def tree_rss_gb(pid: int) -> float:
    """RSS of a process and its children. A worker started through the venv's python.exe is a launcher
    stub whose child is the interpreter doing the parse; the stub alone holds about 0.01 GB."""
    try:
        root = psutil.Process(pid)
        procs = [root, *root.children(recursive=True)]
    except psutil.Error:
        return 0.0
    total = 0
    for pr in procs:
        try:
            total += pr.memory_info().rss
        except psutil.Error:
            continue
    return total / 1e9


def kill_tree(proc: subprocess.Popen) -> list[int]:
    """Kill a worker and its children (killing the launcher stub alone leaves the parse running); returns
    every pid it had."""
    try:
        kids = psutil.Process(proc.pid).children(recursive=True)
    except psutil.Error:
        kids = []
    for k in kids:
        try:
            k.kill()
        except psutil.Error:
            pass
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:  # it exited between the poll and the kill
            pass
    proc.wait()
    psutil.wait_procs(kids, timeout=10)
    return [proc.pid, *(k.pid for k in kids)]


def lowest_free_gb() -> float:
    """Free space on the fullest volume the pipeline writes to: the data folder's, and the downloads folder's,
    where archives land."""
    return min(free_gb(p) for p in [p for p in (DATA_ROOT, DOWNLOADS) if p is not None and Path(p).exists()] or [DATA_ROOT])


def worker_python() -> tuple[str, dict]:
    """The interpreter a worker runs, and what to add to its environment. On Windows the venv's python.exe is a
    launcher stub that starts the base interpreter as its child, so a worker was two processes, and the stub could
    exit while the interpreter kept parsing (review of PR 55). Workers start the base interpreter directly,
    told which venv it serves by __PYVENV_LAUNCHER__, as multiprocessing does on Windows: one process, so poll()
    and a kill reach the parse itself."""
    base = getattr(sys, "_base_executable", sys.executable)
    if os.name == "nt" and base and Path(base) != Path(sys.executable):
        return base, {"__PYVENV_LAUNCHER__": sys.executable}
    return sys.executable, {}


def worker_processes(j: "Job") -> list:
    """The processes of a worker still running: the worker, and every process under it it was seen to start. A job
    is finished only when this list is empty."""
    alive = []
    if j.proc.poll() is None:
        try:
            alive.append(psutil.Process(j.proc.pid))
            for k in alive[0].children(recursive=True):
                j.kids.setdefault(k.pid, k)
        except psutil.Error:
            pass
    for k in j.kids.values():
        try:
            if k.is_running() and k.status() != psutil.STATUS_ZOMBIE:  # is_running also checks its creation time
                alive.append(k)
        except psutil.Error:
            continue
    return alive


def kill_worker(j: "Job") -> list[int]:
    """Kill a worker's stub and every process under it, remembered ones included; returns every pid it had."""
    pids = kill_tree(j.proc) if j.proc.poll() is None else [j.proc.pid]
    for k in list(j.kids.values()):
        try:
            if k.is_running():
                k.kill()
                k.wait(timeout=10)
        except psutil.Error:
            pass
        pids.append(k.pid)
    return sorted(set(pids))


def free_gb(path: Path | None = None) -> float:
    # DATA_ROOT is read at call time, not bound as a default, so tests that move it are measured there
    return shutil.disk_usage(path or DATA_ROOT).free / 1e9


def tree_bytes(path: Path) -> int:
    total = 0
    stack = [path]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(Path(e.path))
                        else:
                            total += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def newest_mtime(path: Path) -> float:
    """Latest modification time of a folder or anything directly inside it."""
    times = [path.stat().st_mtime]
    for e in path.iterdir():
        try:
            times.append(e.stat().st_mtime)
        except OSError:
            continue
    return max(times)


def bind_children_to_this_process() -> None:
    """Put this process in a Windows job that kills every child when this process ends.

    Without it, killing the pipeline leaves its parse workers and 7z running, and they
    keep writing into work/ and demos/ while a restarted pipeline cleans up.
    """
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("Read", "Write", "Other", "ReadBytes", "WriteBytes",
                                                     "OtherBytes")]

    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = k32.CreateJobObjectW(None, None)
    info = Extended()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job or not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError(ctypes.get_last_error(), "could not create kill-on-close job")
    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), "could not join kill-on-close job")
    bind_children_to_this_process.job = job  # keep the handle open for the process lifetime


def _deletable(path: Path) -> Path:
    """The resolved path, if it lies strictly inside DATA_ROOT, or inside DOWNLOADS (a finished RAR)."""
    r = Path(path).resolve()
    for root in (DATA_ROOT.resolve(), *([DOWNLOADS.resolve()] if DOWNLOADS else [])):
        if r != root and root in r.parents:
            return r
    raise ValueError(f"refusing to delete {r}: not inside {DATA_ROOT} or {DOWNLOADS}")


def safe_rmtree(path: Path, ignore_errors: bool = False) -> None:
    shutil.rmtree(_deletable(path), ignore_errors=ignore_errors)


def safe_unlink(path: Path, missing_ok: bool = False) -> None:
    _deletable(path).unlink(missing_ok=missing_ok)


def append_jsonl(path: Path, obj: dict) -> None:
    """Append one JSON line in a single write, flushed and fsynced. A torn tail left by a crash is cut first,
    so the new line never lands in the middle of a broken one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = (json.dumps(obj, default=extract._json_default) + "\n").encode("utf-8")
    with open(path, "ab+") as f:
        f.seek(0, os.SEEK_END)
        if f.tell():
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.seek(0)
                data = f.read()
                keep = data.rfind(b"\n") + 1
                log.warning("%s: dropping a torn last line (%d bytes)", path.name, len(data) - keep)
                f.truncate(keep)
        f.seek(0, os.SEEK_END)
        f.write(line)
        f.flush()
        os.fsync(f.fileno())


def read_jsonl(path: Path) -> list[dict]:
    """Rows of a JSONL file. A malformed final line (a crash mid-append) is skipped and logged; a malformed
    line anywhere else is corruption and raises."""
    if not path.exists():
        return []
    lines = [x for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    rows = []
    for i, x in enumerate(lines):
        try:
            rows.append(json.loads(x))
        except json.JSONDecodeError:
            if i != len(lines) - 1:
                raise
            log.warning("%s: skipping a torn last line", path.name)
    return rows


def fail_reason(res: dict, log_path: Path) -> str | None:
    """One line saying why a map failed; never empty for a failure, None for a success."""
    if res.get("ok"):
        return None
    if res.get("errors"):
        return str(res["errors"][0])[:500]
    failed = (res.get("validation") or {}).get("failed") or []
    if failed:
        return "validation: " + ", ".join(f"{c['check']} {c.get('expected')}!={c.get('actual')}" for c in failed[:5])
    return f"worker reported failure without a reason; see {log_path}"


def write_jsonl_atomic(path: Path, rows: list[dict]) -> None:
    """Rewrite a JSONL file whole: a staged copy, fsynced, then os.replace, so a crash leaves the old file
    or the new one, never a truncated one."""
    staged = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with open(staged, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(r, default=extract._json_default) + "\n" for r in rows))
            f.flush()
            os.fsync(f.fileno())
        os.replace(staged, path)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise


def replace_old_extractions(results: dict, out_dirs: dict[str, Path]) -> None:
    """Retire the listed old folder of each map this archive re-extracted (same demo name and size).

    out_dirs maps each of the archive's demos to the folder its job was given; the worker's own map name is
    never used to find it, because it can differ (a name without "-vs-", a _dup key). A row whose old folder
    is that same folder was re-extracted in place, and is done only if, under the map's lock, the map
    resolves to the version this job wrote (result["version_dir"]); a map withdrawn again since keeps its
    row. Otherwise the old map is retired only while the new one resolves, both maps' locks held; if it does
    not resolve, the old map and its row stay.
    """
    if not NEEDS_REEXTRACT.exists():
        return
    rows = read_jsonl(NEEDS_REEXTRACT)
    successor = {(r.get("dem_file"), r.get("dem_bytes")): (Path(out_dirs[name]), r.get("version_dir"))
                 for name, r in results.items() if r.get("ok") and name in out_dirs}
    keep = []
    for row in rows:
        new, version = successor.get((row.get("dem_file"), row.get("dem_bytes")), (None, None))
        if new is None:
            keep.append(row)
            continue
        rel = Path(row["out_dir"])
        if rel.is_absolute() or ".." in rel.parts:
            log.error("needs_reextract row with an unsafe out_dir %r; not deleting anything", row["out_dir"])
            keep.append(row)
            continue
        old = DATA_ROOT / rel
        if old.resolve() == new.resolve():
            try:
                with extract.map_lock(new):
                    live = extract.resolve_map_dir(new)
            except (extract.MapLocked, OSError, ValueError) as e:
                live = None
                log.error("cannot check %s: %s", row["out_dir"], e)
            if live is not None and version and live.name == version:
                continue  # re-extracted in place, and what readers get is the version this job wrote
            log.warning("%s was re-extracted in place but does not resolve to %s; keeping its row",
                        row["out_dir"], version)
            keep.append(row)
            continue
        if not old.exists():
            continue  # nothing is left to retire
        try:
            # Readers stop resolving it at once; files a reader still has open go at a later start.
            left = extract.retire_map(_deletable(old), successor=_deletable(new))
        except (extract.SuccessorMissing, extract.MapLocked, OSError) as e:
            log.error("not replacing %s: %s", row["out_dir"], e)
            keep.append(row)
            continue
        log.info("replaced %s with %s%s", row["out_dir"], new.relative_to(DATA_ROOT),
                 f"; {len(left)} entries still open, deleted at a later start" if left else "")
    if len(keep) != len(rows):
        write_jsonl_atomic(NEEDS_REEXTRACT, keep)


def tidy_demos() -> None:
    """At startup: finish folder swaps that extractors before 1.5.0 left half done, then prune every map
    folder (old versions, partial writes, retired maps). Whatever a reader still has open waits for the next
    start; one map that cannot be tidied is logged and skipped."""
    for d in DEMOS_DIR.glob("*/*.tmp"):  # pre-1.5.0 partial output beside its map
        try:
            with extract.map_lock(d.with_name(d.name.removesuffix(".tmp")), wait=False):
                safe_rmtree(d, ignore_errors=True)
        except extract.MapLocked:
            log.warning("%s is in use; left for the next start", d)
    for d in DEMOS_DIR.glob("*/*.old"):  # a pre-1.5.0 folder swap a crash interrupted
        out = _deletable(d.with_name(d.name.removesuffix(".old")))
        try:
            with extract.map_lock(out, wait=False):
                extract.recover_output(out)
        except extract.MapLocked:
            log.warning("%s is in use; left for the next start", d)
    for m in sorted(DEMOS_DIR.glob("*/*")):
        if not m.is_dir():
            continue
        try:
            # Never wait: a map another process holds (a worker still writing it) is left for the next start.
            left = extract.prune_map(_deletable(m), wait=False)
        except extract.MapLocked:
            log.warning("%s is being written by another process; left for the next start", m)
            continue
        except (OSError, ValueError, RuntimeError) as e:
            log.error("could not tidy %s: %s", m, e)
            continue
        if left:
            log.warning("%s: %d old entries are still open; retrying at the next start", m, len(left))


# Workers run a copy of the extractor taken at startup. Running the repo files directly let edits made
# while the pipeline ran reach live workers, which failed 13 maps on half-edited code.
RUN_CODE: Path | None = None  # %TEMP%\cs2-stats-pipeline\<pid>, set by freeze_code; importing needs no temp folder
CODE_FILES = ("extract.py", "engagements.py", "schema_v1.py", "repo_guard.py", "prices_cs2_1.41.9.2.json")


def freeze_code() -> None:
    global RUN_CODE
    if RUN_CODE is None:
        RUN_CODE = Path(tempfile.gettempdir()) / "cs2-stats-pipeline" / str(os.getpid())
    RUN_CODE.mkdir(parents=True, exist_ok=True)
    for name in CODE_FILES:
        shutil.copy2(ROOT / name, RUN_CODE / name)
    # The copy's repo_guard guards the repository named in REPO_ENV (set for each worker), not %TEMP%'s parent.
    (RUN_CODE / FROZEN_MARKER).write_text(str(repo_root()), encoding="utf-8")
    log.info("workers run extractor %s copied to %s", extract.EXTRACTOR_VERSION, RUN_CODE)


def failure_versions(folder: Path) -> tuple[dict[str, str | None], str | None]:
    """A kept failure's extractor versions: ({demo file: version its parse failed under}, the version in
    reason.json). A failure kept before versions were recorded reads as None."""
    demos = {}
    for f in folder.glob("*.result.json"):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        demos[r.get("dem_file") or f.name.removesuffix(".result.json") + ".dem"] = r.get("extractor_version")
    try:
        archive = json.loads((folder / "reason.json").read_text(encoding="utf-8")).get("extractor_version")
    except (OSError, json.JSONDecodeError):
        archive = None
    return demos, archive


def due_for_retry(folder: Path, version: str) -> bool:
    """--retry-failed tries each failed demo once per extractor version: a kept failure is due while one of
    its demos failed under another version, or, with no demo results (7-Zip or listing failures), while
    reason.json names another."""
    demos, archive = failure_versions(folder)
    return any(v != version for v in demos.values()) if demos else archive != version


def manifest_seed(rows: list[dict]) -> tuple[list[float], list[float]]:
    """(peak RSS GB of the last PEAK_SAMPLES parses, parse worker-seconds of the last TIMING_SAMPLES archives)
    from manifest rows, so the estimates start from this machine's measurements, not the defaults."""
    peaks = [float(r["peak_rss_gb"]) for r in rows if r.get("peak_rss_gb")][-PEAK_SAMPLES:]
    per: dict[str, float] = {}
    for r in rows:
        w = (r.get("timings") or {}).get("worker_wall_s")
        if w:
            per[r.get("archive")] = per.pop(r.get("archive"), 0.0) + float(w)  # re-inserted: ordered by last map
    return peaks, list(per.values())[-TIMING_SAMPLES:]


def output_seed(rows: list[dict]) -> list[float]:
    """Output GB of the last TIMING_SAMPLES maps written, from manifest rows."""
    return [float(r["output_bytes"]) / 1e9 for r in rows if r.get("ok") and r.get("output_bytes")][-TIMING_SAMPLES:]


def read_ledger() -> dict[str, dict]:
    return {rec["id"]: rec for rec in read_jsonl(LEDGER)}


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

class Pipeline:
    def __init__(self, retry_failed: bool = False, copies_folder: Path | None = None):
        self.retry_failed = retry_failed
        self.copies_folder = copies_folder  # checked by download_copies.check_folder; None: copies are left alone
        self.tracker = CompletenessTracker()
        self.archives: dict[str, Archive] = {}
        self.jobs: deque[Job] = deque()
        self.running: list[Job] = []
        self.ledger = read_ledger()
        self.lock = threading.Lock()
        self.status: dict = {}
        self.ignored: set[Path] = set()
        self.retried: set[Path] = set()  # a failure kept in this run is not retried in it
        rows = read_jsonl(MANIFEST)
        peaks, parse_s = manifest_seed(rows)
        self.output_gb: deque[float] = deque(output_seed(rows), maxlen=TIMING_SAMPLES)
        self.peaks: deque[float] = deque(peaks, maxlen=PEAK_SAMPLES)
        self.parse_s: deque[float] = deque(parse_s, maxlen=TIMING_SAMPLES)
        self.download_s: deque[float] = deque(maxlen=TIMING_SAMPLES)
        self.archive_gb: deque[float] = deque(maxlen=TIMING_SAMPLES)
        self.available_gb = available_gb  # replaced in tests
        self.cpu_count = os.cpu_count() or 1
        self.cs2 = False  # read once per step
        self.started = time.time()
        self.last_sweep = 0.0
        self._outputs: tuple[float, int] | None = None  # (read at, bytes in demos/ and failed/); None: read again
        self._room = 0.0
        self._floor_waiting = False  # a parse is waiting on the free-space floor (logged once)
        self._reextract: tuple[float, set[str]] = (-1.0, set())  # (needs_reextract mtime, ledger ids)

    def reextract_ids(self) -> set[str]:
        """Finished archives that a needs_reextract row asks for again (by archive slug): a refeed of one of
        these under its old id is extracted, not skipped as done."""
        try:
            mtime = NEEDS_REEXTRACT.stat().st_mtime
        except OSError:
            return set()
        if mtime != self._reextract[0]:
            wanted = {r.get("archive_slug") or r.get("archive") for r in read_jsonl(NEEDS_REEXTRACT)}
            ids = {aid for aid, rec in self.ledger.items() if rec.get("status") == "done" and rec.get("slug") in wanted}
            self._reextract = (mtime, ids)
        return self._reextract[1]

    def slug_of(self, a: Archive) -> str:
        """The archive's folder name. An archive the ledger knows keeps the folder it used, and one whose maps
        already sit in a folder named by the 8-character form of extractors before 1.10.0 keeps that one."""
        recorded = (self.ledger.get(a.id) or {}).get("slug")
        if recorded:
            return recorded
        names = sorted(a.listing)
        slug, legacy = slug_for(names, a.id), slug_for(names, a.id, legacy=True)
        if legacy != slug and (DEMOS_DIR / legacy).is_dir() and _owned_by(DEMOS_DIR / legacy, a.id):
            return legacy
        return slug

    # --- inputs
    def candidates(self):
        if DOWNLOADS.exists():
            for d in DOWNLOADS.iterdir():
                if d.is_dir():
                    for f in d.iterdir():
                        if f.is_file() and is_candidate_name(f):
                            yield f
                elif d.is_file() and is_candidate_name(d):
                    yield d
        if self.retry_failed and FAILED_DIR.exists():
            yield from (f for f in FAILED_DIR.glob("*/archive.rar") if f.is_file())

    def scan(self, now: float) -> None:
        for gone in [p for p in self.tracker.tracked() if not p.exists()]:
            self.tracker.forget(gone)
        busy = {a.rar for a in self.archives.values()}
        for f in self.candidates():
            if f in busy or f in self.ignored:
                continue
            in_failed = f.parent.parent == FAILED_DIR
            aid = f.parent.name if in_failed else f.name
            done = self.ledger.get(aid, {}).get("status") == "done" and aid not in self.reextract_ids()
            if done or (self.ledger.get(aid, {}).get("status") == "failed" and not in_failed):
                continue
            if in_failed and (f in self.retried or not due_for_retry(f.parent, extract.EXTRACTOR_VERSION)):
                continue
            if in_failed:
                self.retried.add(f)
            if not in_failed:
                try:
                    size = f.stat().st_size
                except OSError:
                    continue
                # Judge the file only once it is complete: a download in progress can start
                # with bytes that are not yet the RAR header.
                if not (self.tracker.observe(f, size, now) and not has_partial_marker(f)):
                    continue
                took = self.tracker.download_s(f, now)
                if took is not None:
                    self.download_s.append(took)
            seen, finished = self.tracker.first_seen(f), self.tracker.last_change(f)
            self.tracker.forget(f)
            if not is_rar(f):
                self.ignored.add(f)
                log.info("ignoring complete non-RAR file %s", f)
                continue
            st = f.stat()
            # The download began no later than the file appeared: its creation time, or when this run first saw it.
            created = getattr(st, "st_birthtime", st.st_ctime)
            sha = extract.file_sha256(f)
            started = min(created, seen) if seen is not None else created
            if in_failed:  # a retry: the download's own times, from its failure record, if it is the same file
                rec = self.failure_record(f.parent, sha)
                if rec:
                    started, finished = rec.get("download_started") or started, rec.get("download_finished")
            self.archives[aid] = Archive(rar=f, id=aid, rar_bytes=st.st_size, rar_sha256=sha,
                                         download_started=started, download_finished=finished)
            log.info("pending archive %s (%.0f MB)", f, f.stat().st_size / 1e6)

    # --- extraction
    def extracted_count(self) -> int:
        return sum(a.state in ("extracting", "parsing") for a in self.archives.values())

    def start_extractions(self) -> None:
        for a in sorted((a for a in self.archives.values() if a.state == "pending"), key=lambda a: a.rar.stat().st_mtime
                        if a.rar.exists() else 0):
            if self.extracted_count() >= MAX_EXTRACTED:
                return
            if not a.listing:
                try:
                    a.listing = list_archive(a.rar)
                except Exception as e:  # noqa: BLE001
                    self.fail_archive(a, f"7z listing failed: {e}")
                    continue
                if not a.listing:
                    self.fail_archive(a, "archive lists no .dem files")
                    continue
            # The budget counts what the extraction will add: the uncompressed .dem sizes from the listing.
            expand = sum(int(e.get("size") or 0) for e in a.listing.values()) / 1e9
            if expand > MAX_OUR_GB:
                self.fail_archive(a, f"its demos ({expand:.1f} GB) are larger than the {MAX_OUR_GB:.0f} GB budget")
                continue
            if not a.archive_gb_counted:
                self.archive_gb.append(expand + a.rar.stat().st_size / 1e9)  # what it holds on disk while it parses
                a.archive_gb_counted = True
            # Archives still extracting hold the rest of their listed size: their demos are not on disk yet.
            our, held = (b / 1e9 for b in self.disk_usage())
            free = lowest_free_gb()
            outputs = len(a.listing) * self.output_est_gb() + self.output_reserved_gb()
            if our + held + expand > MAX_OUR_GB or free - held - expand - outputs < MIN_FREE_GB:
                log.warning("disk budget: ours %.2f + %.2f GB held by running extractions + %.2f GB of demos "
                            "(max %.0f), free %.1f GB less %.2f GB of tables to come (min %.0f after extracting); "
                            "%s waits", our, held, expand, MAX_OUR_GB, free, outputs, MIN_FREE_GB, a.id)
                return
            a.slug = self.slug_of(a)
            a.work = WORK_DIR / a.slug
            if a.work.exists():
                safe_rmtree(a.work)
            a.work.mkdir(parents=True)
            a.extract_log = LOG_DIR / f"7z-{a.slug}.log"
            a.size_at_extract = a.rar.stat().st_size
            # e: flat extraction (no stored paths, so no traversal); only *.dem and the extensionless names the
            # listing found (maybe_demo), recursively.
            bare = sorted({n for n in a.listing if not n.lower().endswith(".dem")})
            cmd = [SEVEN_ZIP, "e", "-y", "-bd", "-r", f"-o{a.work}", "--", str(a.rar), "*.dem", *bare]
            with open(a.extract_log, "w", encoding="utf-8") as lf:
                a.proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                          creationflags=IDLE | NO_WINDOW, cwd=str(DATA_ROOT))
            a.state, a.t_extract = "extracting", time.time()
            log.info("extracting %s -> %s (%d dem)", a.id, a.work, len(a.listing))

    def poll_extractions(self) -> None:
        for a in [a for a in self.archives.values() if a.state == "extracting"]:
            rc = a.proc.poll()
            if rc is None:
                continue
            a.t_extract_s = round(time.time() - a.t_extract, 1)
            text = a.extract_log.read_text(encoding="utf-8", errors="replace") if a.extract_log.exists() else ""
            if rc != 0:
                truncated = any(s in text for s in ("Unexpected end of archive", "Headers Error", "Can not open"))
                recent = a.rar.exists() and time.time() - a.rar.stat().st_mtime < TRUNCATION_GRACE_S
                grew = a.rar.exists() and a.rar.stat().st_size != a.size_at_extract
                if truncated and (recent or grew) and a.rar.parent.parent != FAILED_DIR:
                    log.warning("7z says %s is incomplete; watching it again", a.id)
                    safe_rmtree(a.work, ignore_errors=True)
                    del self.archives[a.id]
                    continue
                self.fail_archive(a, f"7z exit {rc}: {text[-800:]}")
                continue
            a.dems = extracted_demos(a.work)
            if not a.dems:
                self.fail_archive(a, "7z extracted no .dem files")
                continue
            safe_unlink(a.extract_log, missing_ok=True)
            a.state = "parsing"
            keys: set[str] = set()
            # A retried failure parses only the demos that failed under another extractor version; one that
            # already failed under this one keeps that result.
            failed_under, _ = failure_versions(a.rar.parent) if a.rar.parent.parent == FAILED_DIR else ({}, None)
            for dem in a.dems:
                key = extract.map_key_for(dem, dem.stem)
                part = stitch.split_key(key)
                if part:
                    a.split[dem.name] = part
                while key in keys:
                    key += "_dup"
                keys.add(key)
                jd = LOG_DIR / "jobs"
                jd.mkdir(parents=True, exist_ok=True)
                a.out_dirs[dem.name] = (PARTS_DIR if part else DEMOS_DIR) / a.slug / key
                if failed_under.get(dem.name) == extract.EXTRACTOR_VERSION:
                    a.results[dem.name] = json.loads((a.rar.parent / f"{dem.stem}.result.json").read_text(encoding="utf-8"))
                    log.info("%s/%s already failed under extractor %s; not parsed again", a.slug, key,
                             extract.EXTRACTOR_VERSION)
                    continue
                self.jobs.append(Job(archive=a, dem=dem, out_dir=a.out_dirs[dem.name], map_key=key,
                                     result_path=a.work / f"{dem.stem}.result.json",
                                     log_path=jd / f"{a.slug}-{key}.log"))
            log.info("extracted %s in %.1fs: %s", a.id, a.t_extract_s, [d.name for d in a.dems])

    # --- parsing
    def parse_est_gb(self) -> float:
        return p90(self.peaks, DEFAULT_PARSE_EST_GB)

    def output_est_gb(self) -> float:
        return p90(self.output_gb, DEFAULT_OUTPUT_GB)

    def output_reserved_gb(self) -> float:
        """Space held for the tables of the parses running now: each one's estimate as it stood when it started, so
        a later change to the estimate shrinks no reservation of a parse still running."""
        return sum(j.output_gb for j in self.running)

    def worker_max(self) -> int:
        est = self.parse_est_gb()
        growth = sum(max(0.0, est - j.rss_gb) for j in self.running)
        return worker_capacity(self.available_gb(), est, growth, len(self.running), self.cpu_count, self.cs2)

    def dispatch(self) -> None:
        while self.jobs:
            # Re-checked before each start: the worker just started reserves a whole estimated peak.
            if len(self.running) >= self.worker_max():
                return
            free, held = lowest_free_gb(), self.disk_usage()[1] / 1e9
            if free - held - self.output_reserved_gb() - self.output_est_gb() < MIN_FREE_GB:
                if not self._floor_waiting:
                    log.warning("free %.1f GB less %.2f GB held by extractions and %.2f GB for tables would pass the "
                                "%.0f GB floor; parses wait", free, held,
                                self.output_reserved_gb() + self.output_est_gb(), MIN_FREE_GB)
                self._floor_waiting = True
                return
            self._floor_waiting = False
            j = self.jobs.popleft()
            listing = j.archive.listing.get(j.dem.name, {})
            meta = dict(archive_rar=str(j.archive.rar), archive_slug=j.archive.slug,
                        dem_modified_in_archive=listing.get("modified"), dem_size_in_archive=listing.get("size"),
                        download_folder=j.archive.rar.parent.name)
            python, python_env = worker_python()
            cmd = [python, "-I", str(RUN_CODE / "extract.py"), str(j.dem), str(j.out_dir), "--source", "hltv",
                   "--mapdata", str(MAPDATA), "--archive", j.archive.id, "--meta", json.dumps(meta),
                   "--result", str(j.result_path)]
            env = dict(os.environ, RAYON_NUM_THREADS="4", POLARS_MAX_THREADS="4", PYTHONIOENCODING="utf-8",
                       **{REPO_ENV: str(repo_root())}, **python_env)
            j.out_dir.parent.mkdir(parents=True, exist_ok=True)
            j.t0, j.rss_gb, j.peak_rss_gb, j.killed, j.kids = time.time(), 0.0, 0.0, None, {}
            j.output_gb = self.output_est_gb()
            try:
                with open(j.log_path, "w", encoding="utf-8") as lf:
                    j.proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                              cwd=str(DATA_ROOT), env=env, creationflags=IDLE | NO_WINDOW)
            except OSError as e:
                # The demo fails with the reason, and its archive with it once its other demos end. The result
                # names no extractor version, so --retry-failed tries it again (due_for_retry).
                log.error("could not start a worker for %s/%s: %s", j.archive.slug, j.map_key, e)
                j.killed = f"worker did not start: {python}: {e}"
                self.finish_job(j, -1)
                continue
            self.running.append(j)
            log.info("parsing %s/%s (%d running)", j.archive.slug, j.map_key, len(self.running))

    def poll_workers(self) -> None:
        avail = self.available_gb()
        if self.running and avail < RAM_KILL_GB:
            self.requeue_newest(avail)
        for j in list(self.running):
            procs = worker_processes(j)
            if procs:  # the stub or anything under it still runs: the job is not finished
                rss = 0
                for pr in procs:
                    try:
                        rss += pr.memory_info().rss
                    except psutil.Error:
                        continue
                j.rss_gb = rss / 1e9
                j.peak_rss_gb = max(j.peak_rss_gb, j.rss_gb)
                if j.rss_gb > WORKER_RSS_LIMIT_GB:
                    j.killed = f"killed: worker RSS {j.rss_gb:.2f} GB > {WORKER_RSS_LIMIT_GB} GB"
                elif time.time() - j.t0 > WORKER_TIMEOUT_S:
                    j.killed = f"killed: worker ran longer than {WORKER_TIMEOUT_S} s"
                if j.killed:
                    log.error("%s/%s %s", j.archive.slug, j.map_key, j.killed)
                    kill_worker(j)
                else:
                    continue
            self.running.remove(j)
            self.finish_job(j, j.proc.returncode)

    def requeue_newest(self, avail: float) -> None:
        """Memory is nearly gone: kill the newest worker and queue its demo again. Only that worker's staging
        folder (<map>/.tmp-<pid>, extract.write_output) goes; a version it or any earlier run published stays."""
        alive = [j for j in self.running if worker_processes(j)]
        if not alive:
            return  # every worker has exited; poll_workers finishes them
        j = alive[-1]
        self.running.remove(j)
        pids = kill_worker(j)
        for pid in pids:
            staging = j.out_dir / f".tmp-{pid}"
            if staging.exists():
                safe_rmtree(staging, ignore_errors=True)
        j.result_path.unlink(missing_ok=True)
        log.error("%s/%s killed and requeued: %.2f GB of RAM available, under %.1f GB", j.archive.slug, j.map_key,
                  avail, RAM_KILL_GB)
        self.jobs.appendleft(j)

    def finish_job(self, j: Job, rc: int) -> None:
        self.outputs_changed()
        j.archive.worker_s += time.time() - j.t0
        res = None
        if j.result_path.exists():
            try:
                res = json.loads(j.result_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                res = None
        if res is None and j.result_path.exists():
            j.killed = j.killed or "unreadable result file"
        if res is None:
            tail = j.log_path.read_text(encoding="utf-8", errors="replace")[-1500:] if j.log_path.exists() else ""
            res = dict(ok=False, errors=[j.killed or f"worker exit {rc} without a result"], log_tail=tail,
                       dem_file=j.dem.name)
        # A result only counts as success if its map really resolves to written tables.
        if res.get("ok") and extract.resolve_map_dir(j.out_dir) is None:
            res["ok"] = False
            res.setdefault("errors", []).append(f"output missing: {j.out_dir}")
        j.archive.results[j.dem.name] = res
        line = dict(archive=j.archive.id, archive_slug=j.archive.slug, map=j.map_key, dem_file=j.dem.name,
                    out_dir=str(j.out_dir.relative_to(DATA_ROOT)), version_dir=res.get("version_dir"),
                    ok=bool(res.get("ok")),
                    extractor_version=res.get("extractor_version"), visibility=res.get("visibility"),
                    team1_file=res.get("team1_file"), team2_file=res.get("team2_file"),
                    map_name=res.get("map_name"), tick_rate=res.get("tick_rate"), rounds=res.get("rounds"),
                    final_score=res.get("final_score"), rows=res.get("rows"), bytes=res.get("bytes"),
                    output_bytes=res.get("output_bytes"),
                    timings=dict(res.get("timings") or {}, worker_wall_s=round(time.time() - j.t0, 2),
                                 extract_archive_s=j.archive.t_extract_s),
                    peak_rss_gb=res.get("peak_rss_gb"), validation=res.get("validation"),
                    errors=res.get("errors"), fail_reason=fail_reason(res, j.log_path),
                    finished_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        append_jsonl(MANIFEST, line)
        # The worker's own peak working set when it reported one; polling every POLL_S can miss the top.
        peak = max(j.peak_rss_gb, float(res.get("peak_rss_gb") or 0.0))
        if peak and not j.killed:
            self.peaks.append(peak)
        if line["ok"] and res.get("output_bytes"):
            self.output_gb.append(float(res["output_bytes"]) / 1e9)
        log.info("%s/%s %s in %.0fs%s", j.archive.slug, j.map_key, "OK" if line["ok"] else "FAILED",
                 time.time() - j.t0, "" if line["ok"] else f": {res.get('errors')}")

    # --- completion
    def finish_archives(self) -> None:
        for a in [a for a in self.archives.values() if a.state == "parsing"]:
            if len(a.results) < len(a.dems):
                continue
            if a.worker_s:
                self.parse_s.append(a.worker_s)
            bad = {n: r.get("errors") for n, r in a.results.items() if not r.get("ok")}
            if bad:
                self.fail_archive(a, json.dumps(bad, default=str)[:4000])
                continue
            replace_old_extractions(a.results, a.out_dirs)
            rows = self.stitch_parts(a)
            self.outputs_changed()
            missing = self.unaccounted(a, rows)
            if missing:  # the RAR stays, in failed/, so nothing is lost
                self.fail_archive(a, "maps neither published nor held with their parts: " + "; ".join(missing))
                continue
            # Every map is published, or held back with its parts intact: the inputs can go.
            safe_rmtree(a.work, ignore_errors=True)
            if a.work.exists():
                log.error("could not remove %s; keeping RAR %s", a.work, a.rar)
                continue
            if a.rar.parent.parent == FAILED_DIR:
                safe_rmtree(a.rar.parent)  # a retried failure: its kept demos and reports go too
            else:
                safe_unlink(a.rar)
            rec = dict(id=a.id, status="done", slug=a.slug, maps=sorted(r.get("map") or "" for r in a.results.values()),
                       held=[dict(map=base, reason=row.get("reason")) for base, row in sorted(rows.items())
                             if row["status"] != "stitched"],
                       finished_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"), **self.rar_facts(a))
            append_jsonl(LEDGER, rec)
            self.ledger[a.id] = rec
            del self.archives[a.id]
            log.info("archive %s done; deleted %d dem files and %s", a.slug, len(a.dems), a.rar)
            self.clean_copies(rec)

    def stitch_parts(self, a: Archive, failed: str | None = None) -> dict[str, dict]:
        """Join each split map of the archive into demos/, or hold it back; either way parts.jsonl says so. Returns
        {base map key: parts.jsonl row}. Parts are grouped by the identity their file names give (Archive.split),
        so a second copy of a part, whose folder got a _dup suffix, holds its map instead of passing for a map."""
        groups: dict[str, dict[int, list[Path]]] = {}
        for dem, (base, n) in sorted(a.split.items()):
            groups.setdefault(base, {}).setdefault(n, []).append(Path(a.out_dirs[dem]))
        rows = {}
        for base, by_n in sorted(groups.items()):
            out_dir = DEMOS_DIR / (a.slug or a.id) / base
            parts = {n: ds[0] for n, ds in sorted(by_n.items())}
            dup = {n: ds for n, ds in sorted(by_n.items()) if len(ds) > 1}
            held = dict(map=str(out_dir), parts={str(n): [str(d) for d in ds] for n, ds in sorted(by_n.items())},
                        status="held")
            if failed:
                row = dict(held, reason=f"the archive failed: {failed[:300]}")
            elif dup:
                row = dict(held, reason="part " + ", ".join(map(str, dup)) + " appears more than once in the archive; "
                                        "which copy is the match's cannot be told")
            else:
                try:
                    row = stitch.stitch_map(parts, out_dir)
                except Exception as e:  # noqa: BLE001 - a map that cannot be stitched is held, the archive is still done
                    row = dict(held, reason=f"stitching raised {type(e).__name__}: {e}"[:500])
            append_jsonl(PARTS_DIR / stitch.PARTS_MANIFEST, row)
            log.info("%s/%s %s%s", a.slug, base, row["status"], f": {row['reason']}" if row.get("reason") else "")
            if row["status"] == "stitched":  # the joined map in demos/ holds everything its parts did
                for d in parts.values():
                    stitch.delete_part(d)
            rows[base] = row
        self.enforce_parts_cap()
        return rows

    def unaccounted(self, a: Archive, rows: dict[str, dict]) -> list[str]:
        """What keeps the archive's originals from being deleted: a whole map that does not resolve, a stitched map
        that does not resolve, or a held split map with a part folder that no longer holds its tables."""
        out = []
        for dem, d in sorted(a.out_dirs.items()):
            if dem not in a.split and extract.resolve_map_dir(Path(d)) is None:
                out.append(f"{dem}: {d} holds no complete map")
        for base, row in sorted(rows.items()):
            if row["status"] == "stitched":
                if extract.resolve_map_dir(DEMOS_DIR / (a.slug or a.id) / base) is None:
                    out.append(f"{base}: stitched, but holds no complete map")
                continue
            gone = [str(a.out_dirs[dem]) for dem, (b, _) in sorted(a.split.items())
                    if b == base and extract.resolve_map_dir(Path(a.out_dirs[dem])) is None]
            if gone:
                out.append(f"{base}: held, but part folder(s) {gone} hold no complete map")
        return out

    def enforce_parts_cap(self) -> None:
        """Delete the oldest held parts, one archive's folder in parts/ at a time, while parts/ holds more than
        MAX_PARTS_GB, recording each. An archive still in flight is never touched: its finished parts wait for its
        other parts. A part folder whose map lock another process holds is skipped."""
        active = {a.slug for a in self.archives.values() if a.slug}
        folders = sorted((d for d in PARTS_DIR.iterdir() if d.is_dir()), key=lambda d: newest_mtime(d)) \
            if PARTS_DIR.exists() else []
        sizes = {d: tree_bytes(d) for d in folders}
        total = sum(sizes.values())
        for d in folders:
            if total <= MAX_PARTS_GB * 1e9:
                return
            if d.name in active:
                continue
            removed = [m for m in sorted(x for x in d.iterdir() if x.is_dir()) if stitch.delete_part(m)]
            if not removed:
                continue
            if not any(x.is_dir() for x in d.iterdir()):
                safe_rmtree(d, ignore_errors=True)
            self.outputs_changed()
            total -= sizes[d]
            append_jsonl(PARTS_DIR / stitch.PARTS_MANIFEST, dict(
                map=str(DEMOS_DIR / d.name), parts=[str(m) for m in removed], status="expired",
                reason=f"parts/ over {MAX_PARTS_GB:.0f} GB; the oldest held parts were deleted", bytes=sizes[d],
                checked_utc=datetime.now(timezone.utc).isoformat(timespec="seconds")))
            log.warning("parts/ over %.0f GB; deleted the held parts of %s (%.1f MB)", MAX_PARTS_GB, d.name,
                        sizes[d] / 1e6)

    def fail_archive(self, a: Archive, reason: str) -> None:
        """Keep a failed archive with its failing .dem files and validation reports in failed/<slug>/."""
        self.outputs_changed()
        log.error("archive %s failed: %s", a.id, reason[:500])
        self.stitch_parts(a, failed=reason)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        bad = {n: r for n, r in a.results.items() if not r.get("ok")}
        retried = a.rar.parent.parent == FAILED_DIR
        if bad and all(str(fail_reason(r, Path("")) or "").startswith(TRUNCATED) for r in bad.values()):
            # Nothing reads these demos to a complete round; keeping or retrying them cannot help.
            append_jsonl(DROPPED, dict(id=a.id, slug=a.slug, dems=sorted(a.listing), reason=TRUNCATED,
                                       detail=reason[:2000], dropped_utc=now))
            if retried:
                safe_rmtree(a.rar.parent, ignore_errors=True)
            elif a.rar.exists():
                safe_unlink(a.rar)
            if a.work and a.work.exists():
                safe_rmtree(a.work, ignore_errors=True)
            self._record_failure(a, reason, kept=None, retry=False)
            return
        dest = a.rar.parent if retried else FAILED_DIR / (a.slug or a.id)
        if not retried and dest.exists():
            dest = FAILED_DIR / f"{a.slug or a.id}-{int(time.time())}"
        dest.mkdir(parents=True, exist_ok=True)
        if a.rar.exists() and not retried:
            shutil.move(str(a.rar), dest / "archive.rar")
        if retried:
            # Only the demos failing now stay on record. One that passed this time is published; its old record,
            # from an older version, kept the archive due for retry (due_for_retry) on every scan.
            for old in dest.glob("*.result.json"):
                dem_name = old.name.removesuffix(".result.json") + ".dem"
                if dem_name not in bad:
                    safe_unlink(old)
                    safe_unlink(dest / dem_name, missing_ok=True)
        for name, res in bad.items():
            dem = a.work / name if a.work else None
            if dem and dem.exists():
                shutil.move(str(dem), dest / name)
            (dest / f"{Path(name).stem}.result.json").write_text(json.dumps(res, default=str, indent=1),
                                                                 encoding="utf-8")
        (dest / "reason.json").write_text(json.dumps(dict(id=a.id, original_path=str(a.rar), slug=a.slug,
                                                          dems=sorted(a.listing), reason=reason,
                                                          extractor_version=extract.EXTRACTOR_VERSION, failed_utc=now),
                                                     default=str, indent=1), encoding="utf-8")
        if a.work and a.work.exists():
            safe_rmtree(a.work, ignore_errors=True)
        self.retried.add(dest / "archive.rar")  # a fresh failure is not retried again in this run
        self._record_failure(a, reason, kept=str(dest), retry=True, ledger_id=dest.name if retried else a.id)
        self.enforce_failed_cap()

    def _record_failure(self, a: Archive, reason: str, kept: str | None, retry: bool, ledger_id: str | None = None):
        rec = dict(id=ledger_id or a.id, status="failed", slug=a.slug, reason=reason[:2000], kept=kept, retry=retry,
                   finished_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"), **self.rar_facts(a))
        append_jsonl(LEDGER, rec)
        self.ledger[a.id] = rec
        self.archives.pop(a.id, None)

    def failure_record(self, kept: Path, sha256: str) -> dict | None:
        """The latest ledger record of the failure kept in folder kept whose file has this SHA-256: what its download
        measured, carried into a retry so a retry that passes can still match the browser's copy."""
        recs = [r for r in self.ledger.values() if r.get("kept") and Path(r["kept"]) == kept
                and r.get("rar_sha256") == sha256]
        return max(recs, key=lambda r: r.get("finished_utc") or "") if recs else None

    @staticmethod
    def rar_facts(a: Archive) -> dict:
        """The downloaded file's size, SHA-256, download start and finish, for its ledger record: what
        clean_copies matches the browser's saved copy against."""
        return dict(rar_bytes=a.rar_bytes, rar_sha256=a.rar_sha256, download_started=a.download_started,
                    download_finished=a.download_finished) if a.rar_sha256 else {}

    def clean_copies(self, rec: dict) -> None:
        """Delete (or in dry-run, log) the browser's Downloads copy of a finished archive. A record without a
        download seen in progress has no finish time to match on, and its copy is left alone."""
        if self.copies_folder is None or rec.get("status") != "done" or not rec.get("rar_sha256") \
                or rec.get("download_finished") is None:
            return
        d = download_copies.Download(id=rec["id"], size=rec["rar_bytes"], sha256=rec["rar_sha256"],
                                     finished=rec["download_finished"])
        try:
            rows = download_copies.clean(self.copies_folder, d, delete=COPIES_MODE == "delete", log_path=COPIES_LOG)
        except OSError as e:
            log.error("could not clean the Downloads copy of %s: %s", rec["id"], e)
            return
        for r in rows:
            log.info("Downloads copy %s of %s: %s%s", r["path"], rec["id"], r["outcome"],
                     f" ({r['reason']})" if r["reason"] else "")

    def enforce_failed_cap(self) -> None:
        """Delete the oldest kept failures while failed/ holds more than MAX_FAILED_GB, logging each."""
        self.outputs_changed()
        kept = sorted((d for d in FAILED_DIR.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime)
        sizes = {d: tree_bytes(d) for d in kept}
        total = sum(sizes.values())
        for d in kept:
            if total <= MAX_FAILED_GB * 1e9:
                return
            info = {}
            if (d / "reason.json").exists():
                info = json.loads((d / "reason.json").read_text(encoding="utf-8"))
            append_jsonl(DROPPED, dict(id=info.get("id", d.name), slug=info.get("slug", d.name),
                                       dems=info.get("dems"), bytes=sizes[d], reason=str(info.get("reason"))[:4000],
                                       dropped_utc=datetime.now(timezone.utc).isoformat(timespec="seconds")))
            safe_rmtree(d, ignore_errors=True)
            total -= sizes[d]
            log.warning("failed/ over %.0f GB; deleted the oldest kept failure %s (%.0f MB)", MAX_FAILED_GB, d.name,
                        sizes[d] / 1e6)

    # --- disk budget
    def disk_usage(self) -> tuple[int, int]:
        """(bytes we use, bytes held for running extractions), from one size reading of each work folder.

        Held is each extracting archive's listed .dem bytes minus what its work folder holds. Reading the
        work folders once for both keeps a 7-Zip write between two readings from counting in neither.
        """
        waiting = sum(a.rar.stat().st_size for a in self.archives.values()
                      if a.rar.exists() and a.rar.parent.parent != FAILED_DIR)
        downloading = 0
        for f in self.tracker.tracked():
            try:
                downloading += f.stat().st_size
            except OSError:
                continue
        work: dict[Path, int] = {}
        try:
            with os.scandir(WORK_DIR) as it:
                for e in it:
                    try:
                        work[Path(e.path)] = tree_bytes(Path(e.path)) if e.is_dir(follow_symlinks=False) \
                            else e.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except FileNotFoundError:
            pass
        held = 0
        for a in self.archives.values():
            if a.state == "extracting" and a.listing:
                listed = sum(int(e.get("size") or 0) for e in a.listing.values())
                held += max(0, listed - (work.get(Path(a.work), 0) if a.work else 0))
        return self.outputs_bytes() + sum(work.values()) + waiting + downloading, held

    def outputs_bytes(self) -> int:
        """Bytes in failed/ and parts/ (MAX_FAILED_GB and MAX_PARTS_GB cap them inside the budget). The reading is
        kept for up to BUDGET_CACHE_S; the pipeline's own writes there drop it (outputs_changed). Everything a
        download changes (waiting and in-progress archives, work/, space held by extractions) is read fresh every
        time, so a download that just finished counts at once. demos/ is not in the budget."""
        if self._outputs is None or time.time() - self._outputs[0] > BUDGET_CACHE_S:
            self._outputs = (time.time(), tree_bytes(FAILED_DIR) + tree_bytes(PARTS_DIR))
        return self._outputs[1]

    def outputs_changed(self) -> None:
        self._outputs = None

    def budget(self) -> tuple[float, bool]:
        """(GB we use, whether a new extraction fits), read now; room_gb() is then what is left under both limits.
        Free space here is less what running extractions and running parses' tables still hold, so a download never
        takes space reserved for either."""
        our, held = (b / 1e9 for b in self.disk_usage())
        free = lowest_free_gb() - self.output_reserved_gb()
        self._room = min(MAX_OUR_GB - our - held, free - held - MIN_FREE_GB)
        return our, our + held < MAX_OUR_GB and free - held > MIN_FREE_GB  # at either limit, nothing more fits

    def room_gb(self) -> float:
        """What the last budget() reading left under the disk budget and the free-space floor."""
        return self._room

    def sweep_work(self, force: bool = False) -> None:
        """Delete extraction folders in work/ older than STALE_WORK_S that no active archive owns."""
        if not force and time.time() - self.last_sweep < WORK_SWEEP_S:
            return
        self.last_sweep = time.time()
        owned = {a.work for a in self.archives.values() if a.work}
        for d in WORK_DIR.iterdir():
            if not d.is_dir() or d in owned:
                continue
            try:
                age = time.time() - newest_mtime(d)
            except OSError:
                continue
            if age > STALE_WORK_S:
                log.info("removing stale work folder %s (%.1f h old)", d.name, age / 3600)
                safe_rmtree(d, ignore_errors=True)

    # --- status
    def snapshot(self) -> dict:
        st = [a.state for a in self.archives.values()]
        downloading = sum(1 for p in self.tracker.tracked() if p.exists() and p not in self.ignored)
        statuses = [r.get("status") for r in self.ledger.values()]
        our, capacity = self.budget()
        pending = st.count("pending")
        avail = self.available_gb()
        workers_max = self.worker_max()
        want = desired_downloads(workers_max, mean(self.parse_s, DEFAULT_PARSE_S),
                                 mean(self.download_s, DEFAULT_DOWNLOAD_S),
                                 downloading + pending + st.count("extracting"), self.room_gb(),
                                 max(self.archive_gb, default=DEFAULT_ARCHIVE_GB))
        return {
            # The HLTV tab downloads only while downloading + pending + extracting < want, so without capacity
            # pending reports at least 2 to stop it; pendingActual is the real count.
            "pending": pending if capacity else max(pending, 2), "pendingActual": pending, "want": want,
            "extracting": st.count("extracting"), "parsing": st.count("parsing"),
            "done": statuses.count("done"), "failed": statuses.count("failed"),
            "freeGB": round(lowest_free_gb(), 1), "ourGB": round(our, 2), "capacity": capacity,
            "failedGB": round(tree_bytes(FAILED_DIR) / 1e9, 2),
            "downloading": downloading, "workers": len(self.running), "workersMax": workers_max,
            "parseEstGB": round(self.parse_est_gb(), 2), "availGB": round(avail, 2),
            "queuedDems": len(self.jobs), "cs2Running": self.cs2}

    def idle(self) -> bool:
        return not self.archives and not self.jobs and not self.running and not self.tracker.tracked()

    def step(self) -> None:
        now = time.time()
        self.cs2 = cs2_running()
        self.scan(now)
        self.poll_extractions()
        self.start_extractions()
        self.poll_workers()
        self.dispatch()
        self.finish_archives()
        self.sweep_work()
        snap = self.snapshot()
        with self.lock:
            self.status = snap

    def shutdown(self) -> None:
        """Kill every worker and 7-Zip with its children; the kill-on-close job may not exist."""
        for j in self.running:
            kill_worker(j)
        for a in self.archives.values():
            if a.proc is not None and a.proc.poll() is None:
                kill_tree(a.proc)


# ---------------------------------------------------------------------------
# HTTP status endpoint
# ---------------------------------------------------------------------------

class StatusServer(ThreadingHTTPServer):
    """The status server, bound so that a second pipeline cannot share its port. http.server sets
    SO_REUSEADDR, which on Windows lets two processes bind one port: a second pipeline started while one
    ran bound 8766 too, never reached "cannot bind", and answered the HLTV tab with its own counts."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_handler(pipeline: Pipeline):
    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers",
                             self.headers.get("Access-Control-Request-Headers") or "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")

        def do_OPTIONS(self):  # noqa: N802 - http.server naming
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] != "/pending":
                self.send_response(404)
                self._cors()
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            with pipeline.lock:
                body = json.dumps(pipeline.status).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            return

    return Handler


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.handlers.RotatingFileHandler(LOG_DIR / "pipeline.log", maxBytes=5_000_000, backupCount=3,
                                              encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if sys.stderr is not None:  # pythonw.exe has no console
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        log.addHandler(sh)
    log.setLevel(logging.INFO)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="CS2 demo pipeline")
    ap.add_argument("--once", action="store_true", help="exit once nothing is pending, downloading or running")
    ap.add_argument("--retry-failed", action="store_true", help="also process RARs in failed/")
    a = ap.parse_args(argv)
    if DOWNLOADS is None:
        ap.error("set CS2_DEMO_DOWNLOADS to the folder the browser saves HLTV demo archives to")
    if COPIES_MODE not in download_copies.MODES:
        ap.error(f"CS2_PIPELINE_DOWNLOAD_COPIES is {COPIES_MODE!r}; use one of {', '.join(download_copies.MODES)}")
    if MAX_WORKERS_ERROR:
        ap.error(MAX_WORKERS_ERROR)
    python, _ = worker_python()
    if not Path(python).is_file():
        ap.error(f"the interpreter parse workers run, {python} (this venv's base Python), does not exist; "
                 "reinstall that Python or recreate the venv")
    try:
        # everything the pipeline writes (tables, ledgers, logs, failed archives) lives under DATA_ROOT
        check_output(DATA_ROOT, private=True, what="the pipeline's data folder (tables, ledgers, logs)")
    except OutputRefused as e:
        ap.error(str(e))
    setup_logging()
    # An earlier instance died without a log line; leave evidence of any future death.
    import atexit
    import faulthandler
    faulthandler.enable(open(LOG_DIR / "faults.log", "a", encoding="utf-8"))
    sys.excepthook = lambda *e: log.critical("uncaught exception", exc_info=e)
    threading.excepthook = lambda h: log.critical("uncaught exception in thread %s", h.thread,
                                                  exc_info=(h.exc_type, h.exc_value, h.exc_traceback))
    atexit.register(lambda: log.info("process exiting (pid %d)", os.getpid()))
    try:
        psutil.Process().nice(psutil.IDLE_PRIORITY_CLASS)
    except (AttributeError, psutil.Error) as e:
        log.warning("could not set idle priority: %s", e)
    for d in (DEMOS_DIR, WORK_DIR, FAILED_DIR):
        d.mkdir(parents=True, exist_ok=True)

    freeze_code()
    copies = None
    if COPIES_MODE != "off":
        try:
            copies = download_copies.check_folder(download_copies.downloads_folder(), DATA_ROOT, DOWNLOADS)
            log.info("Downloads copies of finished archives: %s in %s, logged to %s", COPIES_MODE, copies, COPIES_LOG)
        except download_copies.Refused as e:
            log.error("leaving the browser's Downloads copies alone: %s", e)
    pipeline = Pipeline(retry_failed=a.retry_failed, copies_folder=copies)
    try:
        server = StatusServer((HOST, PORT), make_handler(pipeline))
    except OSError as e:
        log.error("cannot bind %s:%d (another pipeline running?): %s", HOST, PORT, e)
        return 2
    try:
        bind_children_to_this_process()
    except OSError as e:
        log.error("NO KILL-ON-CLOSE JOB (%s): if this process is killed, its workers and 7-Zip outlive it and keep "
                  "writing; a normal stop still kills each one with its children", e)
    # Leftovers from an interrupted run: extraction folders past the stale age (an archive that is
    # picked up again re-extracts into a clean folder) and partial outputs. Their RARs are still in
    # place and get processed again.
    pipeline.sweep_work(force=True)
    tidy_demos()
    for rec in list(pipeline.ledger.values()):  # copies of archives finished before a restart
        pipeline.clean_copies(rec)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # The venv's pythonw.exe is a launcher stub; this pid is the real interpreter to stop.
    (LOG_DIR / "pipeline.pid").write_text(str(os.getpid()), encoding="utf-8")
    log.info("pipeline started (pid %d); status on http://%s:%d/pending", os.getpid(), HOST, PORT)

    try:
        while True:
            try:
                pipeline.step()
            except Exception:  # noqa: BLE001 - keep the long-running loop alive; the error is logged
                log.exception("pipeline step failed")
            if a.once and pipeline.idle() and time.time() - pipeline.started > STABLE_SECONDS + 3 * POLL_S:
                log.info("idle; exiting (--once)")
                break
            time.sleep(POLL_S)
    except KeyboardInterrupt:
        log.info("stopping")
    except BaseException as e:
        log.critical("main loop ended by %r", e, exc_info=True)
        raise
    finally:
        pipeline.shutdown()
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
