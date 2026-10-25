"""Replay TLC schedules through the real Python protocol functions.

Only disposable data below formal/states/reproduce is written. Extract functions
are compiled verbatim from the source AST to avoid loading pandas/Polars/demo
parsers. Parquet bytes and schema parsing are stubs; all protocol I/O is real.
Windows is required for the partial-rmtree witness. No source files are patched.
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
import sys
import threading

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
WORK = ROOT / "states" / "reproduce"


def extractor():
    names = {"resolve_map_dir", "_complete", "_write_pointer", "publish_version", "_ours",
             "_delete", "prune_map", "_write_marker", "_replaced", "_stale", "retire_map", "write_output"}
    tree = ast.parse((REPO / "extractor" / "extract.py").read_text(encoding="utf-8"))
    functions = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names],
                           type_ignores=[])
    namespace = dict(Path=Path, os=os, shutil=shutil, json=json, secrets=secrets,
                     CURRENT="CURRENT", COMPLETE="COMPLETE", RETIRED="RETIRED",
                     EXTRACTOR_VERSION="1.9.0", ZSTD_LEVEL=1,
                     _VERSION_DIR=re.compile(r"v-[0-9A-Za-z.+_]+-[0-9a-f]{8}"),
                     log=logging.getLogger("formal-replay"),
                     _to_polars=lambda frame, name: frame,
                     pl=SimpleNamespace(read_parquet_schema=lambda path: path.read_bytes()),
                     pd=SimpleNamespace(DataFrame=object))
    exec(compile(functions, str(REPO / "extractor" / "extract.py"), "exec"), namespace)
    return namespace


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
    resolve = ns["resolve_map_dir"]

    def cached(path):
        old = resolve(path)
        ns["resolve_map_dir"] = resolve
        write(ns, directory)  # outer pruner has already cached the previous path
        return old

    ns["resolve_map_dir"] = cached
    ns["prune_map"](directory)
    assert resolve(directory) is None and (directory / "CURRENT").exists()
    print("CONFIRMED cached CURRENT: prune deleted the newly published pointer target")


def resurrection():
    ns, directory = extractor(), folder("resurrection")
    write(ns, directory)
    marked, resume = threading.Event(), threading.Event()
    original_marker, publish = ns["_write_marker"], ns["publish_version"]
    errors = []

    def marker(path, text):
        original_marker(path, text)
        marked.set()
        if not resume.wait(10):
            raise TimeoutError("retirement replay was not resumed")

    def retire():
        try:
            ns["retire_map"](directory)
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=retire)
    ns["_write_marker"] = marker

    def publishing(*args):
        result = publish(*args)
        thread.start()
        if not marked.wait(10):
            raise TimeoutError("retirement did not install RETIRED")
        return result

    ns["publish_version"] = publishing
    try:
        new = write(ns, directory)
        assert ns["resolve_map_dir"](directory) == new
    finally:
        resume.set()
        thread.join(10)
    assert not thread.is_alive() and not errors
    assert ns["resolve_map_dir"](directory) == new
    print("CONFIRMED retirement race: withdrawn version resolves even after retire_map returns")


def partial_manifest():
    if sys.platform != "win32":
        raise RuntimeError("partial-rmtree witness requires Windows file locks")
    ns, directory = extractor(), folder("partial-manifest")
    write(ns, directory)
    original = ns["pl"].read_parquet_schema
    checked = set()

    def schema(path):
        result = original(path)
        checked.add(path.name)
        if len(checked) == 3:
            with (path.parent / "match.parquet").open("rb"), (path.parent / "player_rounds.parquet").open("rb"):
                assert path.parent in ns["prune_map"](directory)
            assert not (path.parent / "damages.parquet").exists()
        return result

    ns["pl"].read_parquet_schema = schema
    new = write(ns, directory)
    assert ns["resolve_map_dir"](directory) == new
    assert json.loads((new / "COMPLETE").read_text()) == {"match.parquet": 12, "player_rounds.parquet": 12}
    assert not (new / "damages.parquet").exists()
    print("CONFIRMED partial manifest: successful write and resolve omit an intended table")


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
            ns["publish_version"](make_tmp(directory), directory, "1.9.0")
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
        ns["publish_version"](make_tmp(directory), directory, "1.9.0")
        return result

    module.demo_layout = choose
    chosen, _ = module.load_demo_tables(directory, directory, ("match", "damages"), lambda p: p.read_bytes())
    assert chosen.directory == old
    assert ns["resolve_map_dir"](directory) != old
    print("CONFIRMED rating target binding: returns old layout while both target samples name new layout")


def make_tmp(directory):
    tmp = directory / (".tmp-replay-" + secrets.token_hex(4))
    tmp.mkdir()
    for name in ("match", "player_rounds", "damages"):
        (tmp / (name + ".parquet")).write_bytes(b"fake-parquet")
    return tmp


def main():
    for replay in (cached_current, resurrection, partial_manifest, rating_retry, rating_binding):
        replay()


if __name__ == "__main__":
    main()
