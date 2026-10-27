import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import download_copies as dc  # noqa: E402

windows = pytest.mark.skipif(sys.platform != "win32", reason="the handle checks and deletion use Win32 calls")


def _download(path: Path, finished: float | None = None, data: bytes | None = None) -> dc.Download:
    data = path.read_bytes() if data is None else data
    created = path.stat().st_birthtime if hasattr(path.stat(), "st_birthtime") else path.stat().st_ctime
    return dc.Download(id="a1", size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                       finished=created if finished is None else finished)


def _info(folder: Path, **kw) -> dc.FileInfo:
    base = dict(attributes=0x20, links=1, size=100, created=1000.0, final_path=str(folder / "x.rar"))
    return dc.FileInfo(**{**base, **kw})


# --- folder refusals (pure) -----------------------------------------------------

def _folders(tmp_path):
    data, watched, downloads = tmp_path / "data", tmp_path / "browser" / "downloads", tmp_path / "Downloads"
    for d in (data, watched, downloads):
        d.mkdir(parents=True)
    return data, watched, downloads


def test_the_downloads_folder_is_accepted_when_apart_from_the_pipelines_folders(tmp_path):
    data, watched, downloads = _folders(tmp_path)
    assert dc.check_folder(downloads, data, watched) == Path(os.path.realpath(downloads))


def test_a_drive_root_is_refused(tmp_path):
    data, watched, _ = _folders(tmp_path)
    with pytest.raises(dc.Refused, match="drive root"):
        dc.check_folder(Path(Path(tmp_path).anchor), data, watched)


def test_a_missing_folder_is_refused(tmp_path):
    data, watched, _ = _folders(tmp_path)
    with pytest.raises(dc.Refused, match="not a folder"):
        dc.check_folder(tmp_path / "nowhere", data, watched)


@pytest.mark.parametrize("where", ["inside", "same", "containing"])
def test_a_folder_inside_or_containing_the_data_folder_is_refused(tmp_path, where):
    data, watched, _ = _folders(tmp_path)
    folder = {"inside": data / "logs", "same": data, "containing": tmp_path}[where]
    folder.mkdir(exist_ok=True)
    with pytest.raises(dc.Refused, match="data folder"):
        dc.check_folder(folder, data, None)


@pytest.mark.parametrize("where", ["inside", "same", "containing"])
def test_a_folder_inside_or_containing_the_watched_folder_is_refused(tmp_path, where):
    data, watched, _ = _folders(tmp_path)
    folder = {"inside": watched / "393260a0", "same": watched, "containing": watched.parent}[where]
    folder.mkdir(exist_ok=True)
    with pytest.raises(dc.Refused, match="pipeline watches"):
        dc.check_folder(folder, data, watched)


# --- file refusals from the handle's facts (pure) ---------------------------------

def test_a_file_that_passes_every_check_has_no_refusal(tmp_path):
    d = dc.Download(id="a1", size=100, sha256="0" * 64, finished=1000.0 + dc.COPY_WINDOW_S)
    assert dc.refusal(_info(tmp_path), d, tmp_path) is None


@pytest.mark.parametrize("facts, reason", [
    (dict(attributes=0x10), "is a folder"),
    (dict(attributes=0x20 | 0x400), "reparse point"),
    (dict(links=2), "2 hard links"),
    (dict(size=99), "size 99 is not 100"),
    (dict(created=1000.0 + dc.COPY_WINDOW_S + 0.1), "created +5.1 s"),
    (dict(created=1000.0 - 250), "created -250.0 s"),
])
def test_each_handle_fact_that_rules_out_a_copy(tmp_path, facts, reason):
    d = dc.Download(id="a1", size=100, sha256="0" * 64, finished=1000.0)
    assert reason in dc.refusal(_info(tmp_path, **facts), d, tmp_path)


def test_a_file_that_resolves_outside_the_folder_is_refused(tmp_path):
    d = dc.Download(id="a1", size=100, sha256="0" * 64, finished=1000.0)
    got = dc.refusal(_info(tmp_path, final_path=str(tmp_path / "elsewhere" / "x.rar")), d, tmp_path)
    assert "outside" in got


# --- the real file system (Windows) -----------------------------------------------

@windows
def test_the_downloads_known_folder_is_an_absolute_folder():
    p = dc.downloads_folder()
    assert p.is_absolute() and p.is_dir()


@windows
def test_a_matching_copy_is_deleted_through_its_handle_and_logged(tmp_path):
    copy = tmp_path / "event-a-vs-b-bo3-xyz.rar"
    copy.write_bytes(b"Rar!\x1a\x07\x01\x00" + b"p" * 5000)
    d, log = _download(copy), tmp_path / "logs" / "copies.jsonl"
    rows = dc.clean(tmp_path, d, delete=True, log_path=log)
    assert [r["outcome"] for r in rows] == ["deleting", "deleted"] and not copy.exists()
    logged = [json.loads(x) for x in log.read_text(encoding="utf-8").splitlines()]
    assert [(r["outcome"], r["path"], r["sha256"]) for r in logged] == [("deleting", str(copy), d.sha256),
                                                                       ("deleted", str(copy), d.sha256)]


@windows
def test_dry_run_keeps_the_copy_and_logs_what_it_would_delete(tmp_path):
    copy = tmp_path / "c.rar"
    copy.write_bytes(b"x" * 3000)
    rows = dc.clean(tmp_path, _download(copy), delete=False, log_path=tmp_path / "log.jsonl")
    assert [r["outcome"] for r in rows] == ["would_delete"] and copy.exists()


@windows
def test_a_file_of_the_same_size_with_other_content_is_kept(tmp_path):
    copy = tmp_path / "c.rar"
    copy.write_bytes(b"x" * 3000)
    d = _download(copy, data=b"y" * 3000)
    rows = dc.clean(tmp_path, d, delete=True, log_path=tmp_path / "log.jsonl")
    assert [(r["outcome"], r["reason"]) for r in rows] == [("kept", "SHA-256 differs")] and copy.exists()


@windows
def test_a_copy_created_outside_the_window_is_not_a_candidate(tmp_path):
    copy = tmp_path / "c.rar"
    copy.write_bytes(b"x" * 3000)
    d = _download(copy)
    late = dc.Download(id=d.id, size=d.size, sha256=d.sha256, finished=d.finished + dc.COPY_WINDOW_S + 1)
    assert dc.clean(tmp_path, late, delete=True, log_path=tmp_path / "log.jsonl") == [] and copy.exists()


@windows
def test_a_file_with_a_second_hard_link_is_kept(tmp_path):
    copy = tmp_path / "c.rar"
    copy.write_bytes(b"x" * 3000)
    (tmp_path / "other").mkdir()
    os.link(copy, tmp_path / "other" / "same-data.rar")
    rows = dc.clean(tmp_path, _download(copy), delete=True, log_path=tmp_path / "log.jsonl")
    assert [r["outcome"] for r in rows] == ["kept"] and "2 hard links" in rows[0]["reason"] and copy.exists()


@windows
def test_a_file_another_process_has_open_is_kept(tmp_path):
    copy = tmp_path / "c.rar"
    copy.write_bytes(b"x" * 3000)
    d = _download(copy)
    with open(copy, "rb"):  # shares read and write but not exclusive access
        rows = dc.clean(tmp_path, d, delete=True, log_path=tmp_path / "log.jsonl")
    assert [r["outcome"] for r in rows] == ["kept"] and "could not open it alone" in rows[0]["reason"]
    assert copy.exists()


def test_only_rar_files_are_candidates(tmp_path):
    # Same bytes, size and creation time, but not .rar: never opened, never deleted.
    data = b"x" * 3000
    for name in ("copy.RAR", "copy.zip", "copy.rar.txt", "copy"):
        (tmp_path / name).write_bytes(data)
    d = _download(tmp_path / "copy.RAR")
    assert [p.name for p in dc.candidates(tmp_path, d)] == ["copy.RAR"]


@windows
def test_two_files_that_could_be_the_copy_are_both_kept_as_ambiguous(tmp_path):
    # The browser's copy and a file the user saved with the same bytes: which is which cannot be told.
    for name in ("browser-copy.rar", "users-own.rar"):
        (tmp_path / name).write_bytes(b"x" * 3000)
    rows = dc.clean(tmp_path, _download(tmp_path / "browser-copy.rar"), delete=True, log_path=tmp_path / "log.txt")
    assert [r["outcome"] for r in rows] == ["ambiguous", "ambiguous"]
    assert all("2 files could be the browser's copy" in r["reason"] for r in rows)
    assert (tmp_path / "browser-copy.rar").exists() and (tmp_path / "users-own.rar").exists()


@windows
def test_a_match_beside_a_file_that_could_not_be_checked_is_ambiguous(tmp_path):
    for name in ("a.rar", "b.rar"):
        (tmp_path / name).write_bytes(b"x" * 3000)
    d = _download(tmp_path / "a.rar")
    with open(tmp_path / "b.rar", "rb"):  # open elsewhere: its bytes cannot be checked
        rows = dc.clean(tmp_path, d, delete=True, log_path=tmp_path / "log.txt")
    assert sorted(r["outcome"] for r in rows) == ["ambiguous", "ambiguous"] and (tmp_path / "a.rar").exists()


@windows
def test_the_deletion_is_logged_before_the_file_goes(tmp_path, monkeypatch):
    # A crash between the deletion and its log row would leave a deletion no log shows.
    copy = tmp_path / "c.rar"
    copy.write_bytes(b"x" * 3000)
    log = tmp_path / "logs" / "copies.jsonl"

    def crash(h):
        raise KeyboardInterrupt

    monkeypatch.setattr(dc, "_mark_deleted", crash)
    with pytest.raises(KeyboardInterrupt):
        dc.clean(tmp_path, _download(copy), delete=True, log_path=log)
    assert [json.loads(x)["outcome"] for x in log.read_text(encoding="utf-8").splitlines()] == ["deleting"]


@windows
def test_a_symbolic_link_is_kept(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    real = target / "c.rar"
    real.write_bytes(b"x" * 3000)
    folder = tmp_path / "Downloads"
    folder.mkdir()
    try:
        os.symlink(real, folder / "c.rar")
    except OSError as e:  # needs Developer Mode or the symlink privilege
        pytest.skip(f"cannot create a symbolic link here: {e}")
    d = dc.Download(id="a1", size=0, sha256="", finished=0.0)  # unused: a link is not a candidate at all
    assert dc.candidates(folder, d) == []
    # Opened anyway, the handle is the link itself and refusal() names it.
    h = dc._open(folder / "c.rar")
    try:
        info = dc._info(h)
    finally:
        dc._close(h)
    assert info.attributes & dc.FILE_ATTRIBUTE_REPARSE_POINT
    assert "reparse point" in dc.refusal(info, dc.Download("a1", info.size, "", info.created), folder)
    assert real.exists()
