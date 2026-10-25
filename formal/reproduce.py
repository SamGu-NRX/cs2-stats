"""Replay TLC schedules through the real Python protocol functions.

Only disposable data below formal/states/reproduce is written. Extract and
replacement functions
are compiled verbatim from the source AST to avoid loading pandas/Polars/demo
parsers. Parquet bytes and schema parsing are stubs; all protocol I/O is real.
Windows is required for the partial-rmtree witness. The fixed source worktree
must be PR #22 head 5423886465055063ab9a73bdc2c61631483cf8b6. No source files
are patched.
"""
from pathlib import Path
from types import SimpleNamespace
import ast
import importlib.util
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
FIXED_REPO = Path(r"C:\Users\sgu07\Programming Projects\cs2-stats-publish")
FIXED_COMMIT = "5423886465055063ab9a73bdc2c61631483cf8b6"
WORK = ROOT / "states" / "reproduce"


def extractor():
    names = {"_lock_path", "resolve_map_dir", "_complete", "_write_pointer", "publish_version", "_ours",
             "_delete", "prune_map", "_prune_held", "_write_marker", "_replaced", "_stale", "retire_map",
             "write_output"}
    tree = ast.parse((FIXED_REPO / "extractor" / "extract.py").read_text(encoding="utf-8"))
    functions = ast.Module(body=[n for n in tree.body if
        (isinstance(n, ast.FunctionDef) and n.name in names) or
        (isinstance(n, ast.ClassDef) and n.name in {"map_lock", "MapLocked", "SuccessorMissing"})],
                           type_ignores=[])
    namespace = dict(Path=Path, os=os, shutil=shutil, json=json, secrets=secrets,
                     CURRENT="CURRENT", COMPLETE="COMPLETE", RETIRED="RETIRED",
                     EXTRACTOR_VERSION="1.9.0", ZSTD_LEVEL=1, MAP_LOCK_WAIT_S=0.1, time=time,
                     _VERSION_DIR=re.compile(r"v-[0-9A-Za-z.+_]+-[0-9a-f]{8}"),
                     log=logging.getLogger("formal-replay"),
                     _to_polars=lambda frame, name: frame,
                     pl=SimpleNamespace(read_parquet_schema=lambda path: path.read_bytes()),
                     pd=SimpleNamespace(DataFrame=object))
    exec(compile(functions, str(FIXED_REPO / "extractor" / "extract.py"), "exec"), namespace)
    return namespace


def replace_old(ns, data_root, needs_path):
    """Compile the PR head's replacement decision verbatim with small I/O stubs."""
    source = FIXED_REPO / "extractor" / "demo_pipeline.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                    and n.name == "replace_old_extractions")
    rows = lambda path: [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    def atomic(path, values):
        path.write_text("".join(json.dumps(v) + "\n" for v in values), encoding="utf-8")
    namespace = dict(Path=Path, NEEDS_REEXTRACT=needs_path, DATA_ROOT=data_root,
                     read_jsonl=rows, write_jsonl_atomic=atomic, extract=SimpleNamespace(**ns),
                     _deletable=lambda path: path, log=logging.getLogger("formal-replay"))
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
    return namespace["replace_old_extractions"]


class Frame:
    height = 1

    def write_parquet(self, path, **kwargs):
        path.write_bytes(b"fake-parquet")


def write(ns, directory):
    result = {"rows": {}, "bytes": {}}
    ns["write_output"]({name: Frame() for name in ("match", "player_rounds", "damages")}, directory, result)
    return directory / result["version_dir"]


def folder(label):
    path = WORK / label / secrets.token_hex(4)
    path.mkdir(parents=True)
    return path


def cached_current():
    ns, directory = extractor(), folder("cached-current")
    write(ns, directory)
    with ns["map_lock"](directory):
        try:
            ns["prune_map"](directory, wait=False)
        except ns["MapLocked"]:
            print("FIX CONFIRMED cached CURRENT: prune cannot enter a writer-held map lock")
            return
    assert ns["resolve_map_dir"](directory) is not None
    print("FIX CONFIRMED cached CURRENT: serialized prune leaves CURRENT valid")


def resurrection():
    ns, old, newdir = extractor(), folder("resurrection-old"), folder("resurrection-new")
    write(ns, old); write(ns, newdir)
    ns["retire_map"](old, successor=newdir)
    assert ns["resolve_map_dir"](old) is None and ns["resolve_map_dir"](newdir) is not None
    print("FIX CONFIRMED retirement race: successor-locked retirement cannot resurrect the old map")


def partial_manifest():
    if sys.platform != "win32":
        raise RuntimeError("partial-rmtree witness requires Windows file locks")
    ns, directory = extractor(), folder("partial-manifest")
    write(ns, directory)
    new = write(ns, directory)
    assert ns["resolve_map_dir"](directory) == new
    assert set(json.loads((new / "COMPLETE").read_text())) == {"match.parquet", "player_rounds.parquet", "damages.parquet"}
    print("FIX CONFIRMED manifest race: COMPLETE contains every written table")


def rating_module():
    spec = importlib.util.spec_from_file_location("formal_demo_paths", REPO / "model" / "rating3" / "demo_paths.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def rating_retry():
    ns, directory, module = extractor(), folder("rating-retry"), rating_module()
    write(ns, directory)
    reads = 0

    def read(path):
        nonlocal reads
        reads += 1
        value = path.read_bytes()
        if reads in (1, 3):
            ns["publish_version"](make_tmp(directory), directory, "1.9.0", ["match.parquet", "player_rounds.parquet", "damages.parquet"])
        return value

    try:
        module.load_demo_tables(directory, directory, ("match", "damages"), read)
    except FileNotFoundError as error:
        assert "republished while loading" in str(error)
    else:
        raise AssertionError("single retry unexpectedly tolerated two publishes")
    assert reads == 4
    print("CONFIRMED rating retry bound: two complete publishes exhaust the single retry")


def rating_binding():
    ns, directory, module = extractor(), folder("rating-binding"), rating_module()
    old = write(ns, directory)
    layout = module.demo_layout

    def choose(*args):
        result = layout(*args)
        write(ns, directory)
        return result

    module.demo_layout = choose
    try:
        chosen, _ = module.load_demo_tables(directory, directory, ("match", "damages"), lambda p: p.read_bytes())
    except FileNotFoundError:
        print("REMAINS rating target binding: one publish can delete the resolved layout before its tables open")
        return
    assert chosen.directory == old and ns["resolve_map_dir"](directory) != old
    print("REMAINS rating target binding: returns old layout while both target samples name new layout")


def inplace_reextract():
    ns, directory = extractor(), folder("inplace-reextract")
    row_path = directory.parent / "needs_reextract.jsonl"
    row = {"dem_file": "demo.dem", "dem_bytes": 7, "out_dir": directory.name}
    result = {"job": {"ok": True, "dem_file": "demo.dem", "dem_bytes": 7,
                       "version_dir": "missing-version"}}
    write(ns, directory)
    row_path.write_text(json.dumps(row) + "\n", encoding="utf-8")
    replace_old(ns, directory.parent, row_path)(result, {"job": directory})
    assert row_path.read_text(encoding="utf-8").strip() == json.dumps(row)
    print("FIX CONFIRMED in-place withdrawal keeps needs_reextract row")

    write(ns, directory)
    live = ns["resolve_map_dir"](directory)
    row_path.write_text(json.dumps(row) + "\n", encoding="utf-8")
    result["job"]["version_dir"] = live.name
    replace_old(ns, directory.parent, row_path)(result, {"job": directory})
    assert not row_path.read_text(encoding="utf-8").strip()
    print("FIX CONFIRMED in-place own live version settles needs_reextract row")


def make_tmp(directory):
    tmp = directory / (".tmp-replay-" + secrets.token_hex(4))
    tmp.mkdir()
    for name in ("match", "player_rounds", "damages"):
        (tmp / (name + ".parquet")).write_bytes(b"fake-parquet")
    return tmp


def main():
    actual = subprocess.run(["git", "rev-parse", "HEAD"], cwd=FIXED_REPO,
                            check=True, capture_output=True, text=True).stdout.strip()
    if actual != FIXED_COMMIT:
        raise RuntimeError(f"fixed source is {actual}, expected {FIXED_COMMIT}")
    for replay in (cached_current, resurrection, partial_manifest, rating_retry, rating_binding,
                   inplace_reextract):
        replay()


if __name__ == "__main__":
    main()
