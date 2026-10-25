"""Turn downloaded HLTV demo archives into per-map parquet tables, then delete the demos.

Watches the browser's download folder for RAR archives, extracts their .dem
files with 7-Zip, parses each demo in its own worker process (extract.py), and
deletes the .dem files and the RAR once every map of that archive is written
and validated. A failed archive keeps its RAR, moved to failed/ with the reason.
Status is served on http://127.0.0.1:8766/pending for the HLTV tab that paces
downloads.

Run:  .venv\\Scripts\\python.exe -I demo_pipeline.py            (runs until stopped)
      .venv\\Scripts\\python.exe -I demo_pipeline.py --once     (exit when idle)
      add --retry-failed to also pick up RARs in failed/
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import shutil
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
import extract  # noqa: E402

DOWNLOADS = Path(r"C:\Users\<user>\.t3\userdata\server-browser\downloads")
DATA_ROOT = Path(r"C:\Users\<user>\Programming Projects\cs2-stats-data")  # data; holds no code
DEMOS_DIR = DATA_ROOT / "demos"
WORK_DIR = DATA_ROOT / "work"
FAILED_DIR = DATA_ROOT / "failed"
LOG_DIR = DATA_ROOT / "logs"
# awpy-data release 2000935 was built from CS2 1.41.9.2 (Steam build 26144732), the build installed
# locally; extract.py withholds mesh visibility for any map whose mesh disagrees with the demo.
MAPDATA = DATA_ROOT / "mapdata" / "2000935"
MANIFEST = DEMOS_DIR / "manifest.jsonl"
LEDGER = DEMOS_DIR / "archives.jsonl"  # one line per finished archive, done or failed
DROPPED = DEMOS_DIR / "failed_dropped.jsonl"  # failed archives deleted because failed/ was full
# Maps written by an older extractor; a re-downloaded copy extracted now replaces the old folder.
NEEDS_REEXTRACT = DEMOS_DIR / "needs_reextract.jsonl"

RAR_MAGIC = b"Rar!\x1a\x07"  # shared prefix of RAR 4 (…\x00) and RAR 5 (…\x01\x00) signatures
PARTIAL_SUFFIXES = (".crdownload", ".part", ".partial", ".download", ".tmp")
STABLE_SECONDS = 10.0
# Disk budget (set by the user, who has limited disk): no new extraction when free space is
# below MIN_FREE_GB or when our own data (demos + work + waiting downloads) exceeds MAX_OUR_GB.
# failed/ has its own cap: each failed archive is kept with its failing .dem files and their validation
# reports so the failure can be diagnosed, up to MAX_FAILED_GB; beyond that the oldest is logged and deleted.
MIN_FREE_GB = 45.0
MAX_OUR_GB = 12.0
MAX_FAILED_GB = 8.0
TRUNCATED = "truncated_demo"  # fail_reason of a demo nothing can read to a complete round; never retried
STALE_WORK_S = 2 * 3600
WORK_SWEEP_S = 600
BUDGET_CACHE_S = 10.0
MAX_EXTRACTED = 2  # archives whose .dem files are on disk (extracting or parsing)
MAX_WORKERS = 4
GAMING_WORKERS = 1
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

    def observe(self, path: Path, size: int, now: float) -> bool:
        prev = self._seen.get(path)
        if prev is None or prev[0] != size:
            self._seen[path] = (size, now)
            return False
        return size > 0 and now - prev[1] >= self.stable_seconds

    def forget(self, path: Path) -> None:
        self._seen.pop(path, None)

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
    proc: subprocess.Popen | None = None
    extract_log: Path | None = None
    size_at_extract: int = 0
    t_extract: float = 0.0
    t_extract_s: float = 0.0


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
    killed: str | None = None


def slug_for(dem_names: list[str], archive_id: str) -> str:
    for n in dem_names:
        t1, t2 = extract.teams_from_filename(Path(n))
        if t1:
            prefix = f"{t1}-vs-{t2}-"
            # A RAR retried from failed/ is already named by its slug.
            return archive_id if archive_id.startswith(prefix) else f"{prefix}{archive_id[:8]}"
    return archive_id


def list_archive(rar: Path) -> dict[str, dict]:
    """Names, sizes and mtimes of the .dem files inside the archive (7z -slt listing)."""
    out = subprocess.run([SEVEN_ZIP, "l", "-slt", "-ba", "--", str(rar)], capture_output=True, text=True,
                         creationflags=IDLE | NO_WINDOW, timeout=120, encoding="utf-8", errors="replace")
    entries, cur = {}, {}
    for line in out.stdout.splitlines() + [""]:
        if not line.strip():
            if cur.get("Path", "").lower().endswith(".dem") and cur.get("Folder") != "+":
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


def free_gb(path: Path = DATA_ROOT) -> float:
    return shutil.disk_usage(path).free / 1e9


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
    for root in (DATA_ROOT.resolve(), DOWNLOADS.resolve()):
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


def replace_old_extractions(results: dict, new_dirs: set[Path]) -> None:
    """Delete the listed old folder of each map this archive re-extracted (same demo name and size)."""
    if not NEEDS_REEXTRACT.exists():
        return
    rows = read_jsonl(NEEDS_REEXTRACT)
    sizes = {(r.get("dem_file"), r.get("dem_bytes")) for r in results.values() if r.get("ok")}
    keep = []
    for row in rows:
        if (row["dem_file"], row["dem_bytes"]) in sizes:
            rel = Path(row["out_dir"])
            if rel.is_absolute() or ".." in rel.parts:
                log.error("needs_reextract row with an unsafe out_dir %r; not deleting anything", row["out_dir"])
                keep.append(row)
                continue
            old = DATA_ROOT / rel
            if old.exists() and old.resolve() not in new_dirs:
                # Retired at once (readers stop resolving it); files a reader still has open go at a later start.
                left = extract.retire_map(_deletable(old))
                log.info("replaced %s with its re-extraction%s", row["out_dir"],
                         f"; {len(left)} entries still open, deleted at a later start" if left else "")
            continue
        keep.append(row)
    if len(keep) != len(rows):
        NEEDS_REEXTRACT.write_text("".join(json.dumps(r) + "\n" for r in keep), encoding="utf-8")


def tidy_demos() -> None:
    """At startup: finish folder swaps that extractors before 1.5.0 left half done, then prune every map
    folder (old versions, partial writes, retired maps). Whatever a reader still has open waits for the next
    start; one map that cannot be tidied is logged and skipped."""
    for d in DEMOS_DIR.glob("*/*.tmp"):  # pre-1.5.0 partial output beside its map
        safe_rmtree(d, ignore_errors=True)
    for d in DEMOS_DIR.glob("*/*.old"):  # a pre-1.5.0 folder swap a crash interrupted
        extract.recover_output(_deletable(d.with_name(d.name.removesuffix(".old"))))
    for m in sorted(DEMOS_DIR.glob("*/*")):
        if not m.is_dir():
            continue
        try:
            left = extract.prune_map(_deletable(m))
        except (OSError, ValueError, RuntimeError) as e:
            log.error("could not tidy %s: %s", m, e)
            continue
        if left:
            log.warning("%s: %d old entries are still open; retrying at the next start", m, len(left))


# Workers run a copy of the extractor taken at startup. Running the repo files directly let edits made
# while the pipeline ran reach live workers, which failed 13 maps on half-edited code.
RUN_CODE = Path(tempfile.gettempdir()) / "cs2-stats-pipeline" / str(os.getpid())
CODE_FILES = ("extract.py", "engagements.py", "schema_v1.py", "prices_cs2_1.41.9.2.json")


def freeze_code() -> None:
    RUN_CODE.mkdir(parents=True, exist_ok=True)
    for name in CODE_FILES:
        shutil.copy2(ROOT / name, RUN_CODE / name)
    log.info("workers run extractor %s copied to %s", extract.EXTRACTOR_VERSION, RUN_CODE)


def read_ledger() -> dict[str, dict]:
    return {rec["id"]: rec for rec in read_jsonl(LEDGER)}


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

class Pipeline:
    def __init__(self, retry_failed: bool = False):
        self.retry_failed = retry_failed
        self.tracker = CompletenessTracker()
        self.archives: dict[str, Archive] = {}
        self.jobs: deque[Job] = deque()
        self.running: list[Job] = []
        self.ledger = read_ledger()
        self.lock = threading.Lock()
        self.status: dict = {}
        self.ignored: set[Path] = set()
        self.retried: set[Path] = set()  # --retry-failed tries each failed RAR once per process run
        self.started = time.time()
        self.last_sweep = 0.0
        self._budget: tuple[float, float, bool] = (0.0, 0.0, True)  # (computed_at, ourGB, capacity)

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
            done = self.ledger.get(aid, {}).get("status") == "done"
            if done or (self.ledger.get(aid, {}).get("status") == "failed" and not in_failed):
                continue
            if in_failed and f in self.retried:
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
            self.tracker.forget(f)
            if not is_rar(f):
                self.ignored.add(f)
                log.info("ignoring complete non-RAR file %s", f)
                continue
            self.archives[aid] = Archive(rar=f, id=aid)
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
            # Archives still extracting hold the rest of their listed size: their demos are not on disk yet.
            our, held = self.our_bytes() / 1e9, self.reserved_bytes() / 1e9
            free = free_gb()
            if our + held + expand > MAX_OUR_GB or free - held - expand < MIN_FREE_GB:
                log.warning("disk budget: ours %.2f + %.2f GB held by running extractions + %.2f GB of demos "
                            "(max %.0f), free %.1f GB (min %.0f after extracting); %s waits", our, held, expand,
                            MAX_OUR_GB, free, MIN_FREE_GB, a.id)
                return
            a.slug = slug_for(sorted(a.listing), a.id)
            a.work = WORK_DIR / a.slug
            if a.work.exists():
                safe_rmtree(a.work)
            a.work.mkdir(parents=True)
            a.extract_log = LOG_DIR / f"7z-{a.slug}.log"
            a.size_at_extract = a.rar.stat().st_size
            # e: flat extraction (no stored paths, so no traversal); only *.dem, recursively.
            cmd = [SEVEN_ZIP, "e", "-y", "-bd", "-r", f"-o{a.work}", "--", str(a.rar), "*.dem"]
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
            a.dems = sorted(a.work.glob("*.dem"))
            if not a.dems:
                self.fail_archive(a, "7z extracted no .dem files")
                continue
            safe_unlink(a.extract_log, missing_ok=True)
            a.state = "parsing"
            keys: set[str] = set()
            for dem in a.dems:
                key = extract.map_key_for(dem, dem.stem)
                while key in keys:
                    key += "_dup"
                keys.add(key)
                jd = LOG_DIR / "jobs"
                jd.mkdir(parents=True, exist_ok=True)
                self.jobs.append(Job(archive=a, dem=dem, out_dir=DEMOS_DIR / a.slug / key, map_key=key,
                                     result_path=a.work / f"{dem.stem}.result.json",
                                     log_path=jd / f"{a.slug}-{key}.log"))
            log.info("extracted %s in %.1fs: %s", a.id, a.t_extract_s, [d.name for d in a.dems])

    # --- parsing
    def worker_limit(self) -> int:
        return GAMING_WORKERS if cs2_running() else MAX_WORKERS

    def dispatch(self) -> None:
        while self.jobs:
            # Re-check before each job: one worker while CS2 runs, otherwise up to four.
            if len(self.running) >= self.worker_limit():
                return
            j = self.jobs.popleft()
            listing = j.archive.listing.get(j.dem.name, {})
            meta = dict(archive_rar=str(j.archive.rar), archive_slug=j.archive.slug,
                        dem_modified_in_archive=listing.get("modified"), dem_size_in_archive=listing.get("size"),
                        download_folder=j.archive.rar.parent.name)
            cmd = [sys.executable, "-I", str(RUN_CODE / "extract.py"), str(j.dem), str(j.out_dir), "--source", "hltv",
                   "--mapdata", str(MAPDATA), "--archive", j.archive.id, "--meta", json.dumps(meta),
                   "--result", str(j.result_path)]
            env = dict(os.environ, RAYON_NUM_THREADS="4", POLARS_MAX_THREADS="4", PYTHONIOENCODING="utf-8")
            j.out_dir.parent.mkdir(parents=True, exist_ok=True)
            with open(j.log_path, "w", encoding="utf-8") as lf:
                j.proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                          cwd=str(DATA_ROOT), env=env, creationflags=IDLE | NO_WINDOW)
            j.t0 = time.time()
            self.running.append(j)
            log.info("parsing %s/%s (%d running)", j.archive.slug, j.map_key, len(self.running))

    def poll_workers(self) -> None:
        for j in list(self.running):
            rc = j.proc.poll()
            if rc is None:
                try:
                    rss = psutil.Process(j.proc.pid).memory_info().rss / 1e9
                except psutil.Error:
                    rss = 0.0
                if rss > WORKER_RSS_LIMIT_GB:
                    j.killed = f"killed: worker RSS {rss:.2f} GB > {WORKER_RSS_LIMIT_GB} GB"
                elif time.time() - j.t0 > WORKER_TIMEOUT_S:
                    j.killed = f"killed: worker ran longer than {WORKER_TIMEOUT_S} s"
                if j.killed:
                    log.error("%s/%s %s", j.archive.slug, j.map_key, j.killed)
                    j.proc.kill()
                    j.proc.wait()
                else:
                    continue
            self.running.remove(j)
            self.finish_job(j, j.proc.returncode)

    def finish_job(self, j: Job, rc: int) -> None:
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
        log.info("%s/%s %s in %.0fs%s", j.archive.slug, j.map_key, "OK" if line["ok"] else "FAILED",
                 time.time() - j.t0, "" if line["ok"] else f": {res.get('errors')}")

    # --- completion
    def finish_archives(self) -> None:
        for a in [a for a in self.archives.values() if a.state == "parsing"]:
            if len(a.results) < len(a.dems):
                continue
            bad = {n: r.get("errors") for n, r in a.results.items() if not r.get("ok")}
            if bad:
                self.fail_archive(a, json.dumps(bad, default=str)[:4000])
                continue
            replace_old_extractions(a.results, {(DEMOS_DIR / a.slug / (r.get("map") or "")).resolve()
                                                for r in a.results.values()})
            # Every map is written and validated: the inputs can go.
            safe_rmtree(a.work, ignore_errors=True)
            if a.work.exists():
                log.error("could not remove %s; keeping RAR %s", a.work, a.rar)
                continue
            if a.rar.parent.parent == FAILED_DIR:
                safe_rmtree(a.rar.parent)  # a retried failure: its kept demos and reports go too
            else:
                safe_unlink(a.rar)
            rec = dict(id=a.id, status="done", slug=a.slug, maps=sorted(r.get("map") or "" for r in a.results.values()),
                       finished_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            append_jsonl(LEDGER, rec)
            self.ledger[a.id] = rec
            del self.archives[a.id]
            log.info("archive %s done; deleted %d dem files and %s", a.slug, len(a.dems), a.rar)

    def fail_archive(self, a: Archive, reason: str) -> None:
        """Keep a failed archive with its failing .dem files and validation reports in failed/<slug>/."""
        log.error("archive %s failed: %s", a.id, reason[:500])
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
        for name, res in bad.items():
            dem = a.work / name if a.work else None
            if dem and dem.exists():
                shutil.move(str(dem), dest / name)
            (dest / f"{Path(name).stem}.result.json").write_text(json.dumps(res, default=str, indent=1),
                                                                 encoding="utf-8")
        (dest / "reason.json").write_text(json.dumps(dict(id=a.id, original_path=str(a.rar), slug=a.slug,
                                                          dems=sorted(a.listing), reason=reason, failed_utc=now),
                                                     default=str, indent=1), encoding="utf-8")
        if a.work and a.work.exists():
            safe_rmtree(a.work, ignore_errors=True)
        self.retried.add(dest / "archive.rar")  # a fresh failure is not retried again in this run
        self._record_failure(a, reason, kept=str(dest), retry=True, ledger_id=dest.name if retried else a.id)
        self.enforce_failed_cap()

    def _record_failure(self, a: Archive, reason: str, kept: str | None, retry: bool, ledger_id: str | None = None):
        rec = dict(id=ledger_id or a.id, status="failed", slug=a.slug, reason=reason[:2000], kept=kept, retry=retry,
                   finished_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        append_jsonl(LEDGER, rec)
        self.ledger[a.id] = rec
        self.archives.pop(a.id, None)

    def enforce_failed_cap(self) -> None:
        """Delete the oldest kept failures while failed/ holds more than MAX_FAILED_GB, logging each."""
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
    def our_bytes(self) -> int:
        waiting = sum(a.rar.stat().st_size for a in self.archives.values()
                      if a.rar.exists() and a.rar.parent.parent != FAILED_DIR)
        downloading = 0
        for f in self.tracker.tracked():
            try:
                downloading += f.stat().st_size
            except OSError:
                continue
        return tree_bytes(DEMOS_DIR) + tree_bytes(WORK_DIR) + waiting + downloading

    def reserved_bytes(self) -> int:
        """Listed .dem bytes of each archive still extracting, minus what its work folder already holds."""
        held = 0
        for a in self.archives.values():
            if a.state == "extracting" and a.listing:
                listed = sum(int(e.get("size") or 0) for e in a.listing.values())
                held += max(0, listed - (tree_bytes(a.work) if a.work else 0))
        return held

    def budget(self, fresh: bool = False) -> tuple[float, bool]:
        t, our, ok = self._budget
        if fresh or time.time() - t > BUDGET_CACHE_S:
            our = self.our_bytes() / 1e9
            held = self.reserved_bytes() / 1e9
            ok = our + held <= MAX_OUR_GB and free_gb() - held >= MIN_FREE_GB
            self._budget = (time.time(), our, ok)
        return our, ok

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
        return {
            # The HLTV feeder downloads only while pending + extracting < 2, so without capacity
            # pending reports at least 2 to stop it; pendingActual is the real count.
            "pending": pending if capacity else max(pending, 2), "pendingActual": pending,
            "extracting": st.count("extracting"), "parsing": st.count("parsing"),
            "done": statuses.count("done"), "failed": statuses.count("failed"),
            "freeGB": round(free_gb(), 1), "ourGB": round(our, 2), "capacity": capacity,
            "failedGB": round(tree_bytes(FAILED_DIR) / 1e9, 2),
            "downloading": downloading, "workers": len(self.running), "queuedDems": len(self.jobs),
            "cs2Running": cs2_running()}

    def idle(self) -> bool:
        return not self.archives and not self.jobs and not self.running and not self.tracker.tracked()

    def step(self) -> None:
        now = time.time()
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
        for j in self.running:
            if j.proc and j.proc.poll() is None:
                j.proc.kill()
        for a in self.archives.values():
            if a.proc and a.proc.poll() is None:
                a.proc.kill()


# ---------------------------------------------------------------------------
# HTTP status endpoint
# ---------------------------------------------------------------------------

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
    pipeline = Pipeline(retry_failed=a.retry_failed)
    try:
        server = ThreadingHTTPServer((HOST, PORT), make_handler(pipeline))
    except OSError as e:
        log.error("cannot bind %s:%d (another pipeline running?): %s", HOST, PORT, e)
        return 2
    try:
        bind_children_to_this_process()
    except OSError as e:
        log.warning("workers will outlive this process if it is killed: %s", e)
    # Leftovers from an interrupted run: extraction folders past the stale age (an archive that is
    # picked up again re-extracts into a clean folder) and partial outputs. Their RARs are still in
    # place and get processed again.
    pipeline.sweep_work(force=True)
    tidy_demos()
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
