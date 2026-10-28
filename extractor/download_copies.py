"""Delete the second copy of a downloaded archive that the browser saves to the user's Downloads folder.

The HLTV tab's browser saves each archive twice: into its own download folder, which the pipeline watches
(CS2_DEMO_DOWNLOADS) and empties as archives finish, and into Windows Downloads under the archive's HLTV name.
Nothing the browser records links the two (its copy traces carry no paths), and its settings cannot turn the
copy off, so a copy is matched by what the pipeline measured of the download: a .rar file with the same size, the
same SHA-256, and a creation time within COPY_WINDOW_S of the moment the pipeline saw the download reach its final
size.

Identical bytes cannot tell the browser's copy from a file the user saved, so a copy is deleted only when it is
the one file in the folder that matches. With two or more, or with one plus a candidate that could not be checked,
none is deleted and each is logged as ambiguous. One case remains, and no matching on bytes and times can rule it
out without a provenance record from the browser: if the browser's copy is missing and the user saved the same bytes
as a .rar within COPY_WINDOW_S of the download finishing, the user's file is deleted. That residual is accepted, so
deletion is off by default (dry-run, demo_pipeline.COPIES_MODE). Setting CS2_PIPELINE_DOWNLOAD_COPIES to delete
turns it on, and that is the user's choice to make with this case in view.

A candidate is opened with no sharing, so nothing can write, rename or delete it while it is checked. Every
check reads that handle: one hard link, no reparse point, the size, the creation time, the folder it resolves
to, and the SHA-256. The deletion goes through the same handle, so the file deleted is the file checked. Its log
row is written, flushed and synced before the deletion, and its outcome after, so a crash cannot leave a deletion
unlogged.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

# A copy is created within COPY_WINDOW_S of the download's last size change, taken as the first poll that saw the
# final size. Evidence: the live pipeline logged "pending archive" 10.8 to 13.3 s after the creation of each of the
# 12 newest copies. That line comes 10 s (STABLE_SECONDS) after the first poll at the final size, plus at most
# one loop (2 s of sleep plus the step), so each copy was created between 3.3 s before that poll and 1.2 s
# plus one step's run time after it. 5 s leaves a margin on both sides; there are only 12 samples. It is far
# below the 250 s between the two different archives of identical size seen so far, and the SHA-256 must match too.
COPY_WINDOW_S = 5.0
MODES = ("off", "dry-run", "delete")

FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
FOLDERID_DOWNLOADS = uuid.UUID("374DE290-123F-4565-9164-39C4925E467B")
FOLDERID_DESKTOP = uuid.UUID("B4BFCC3A-DB2C-424C-B029-7FE99A87C641")
FOLDERID_DOCUMENTS = uuid.UUID("FDD39AD0-238F-46AF-ADB4-6C85480369C7")


class Refused(Exception):
    """The folder is not one copies may be deleted from."""


@dataclass(frozen=True)
class Download:
    """What the pipeline measured of one downloaded archive."""
    id: str
    size: int
    sha256: str
    finished: float  # epoch seconds of the first poll that saw the final size


@dataclass(frozen=True)
class FileInfo:
    """What GetFileInformationByHandle and GetFinalPathNameByHandle report for an open file."""
    attributes: int
    links: int
    size: int
    created: float  # epoch seconds
    final_path: str


def _norm(p: Path | str) -> str:
    return os.path.normcase(os.path.realpath(p))


def _within(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives
        return False


def check_folder(folder: Path, data_root: Path, watched: Path | None) -> Path:
    """The folder, resolved, if copies may be deleted from it. Refuses a missing folder, a drive root, and any folder
    inside or containing the data folder or the folder the pipeline watches (where the archives themselves are)."""
    real = _norm(folder)
    if not os.path.isdir(real):
        raise Refused(f"{folder} is not a folder")
    if os.path.dirname(real) == real:
        raise Refused(f"{folder} is a drive root")
    for what, other in (("the data folder", data_root), ("the folder the pipeline watches", watched)):
        if other is None:
            continue
        o = _norm(other)
        if _within(real, o) or _within(o, real):
            raise Refused(f"{folder} is inside or contains {what} ({other})")
    return Path(os.path.realpath(folder))


def not_plain(info: FileInfo) -> str | None:
    """Why an open file is not one plain file whose deletion frees its data; None if it is."""
    if info.attributes & FILE_ATTRIBUTE_DIRECTORY:
        return "is a folder"
    if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT:
        return "is a reparse point (a link, or a cloud placeholder)"
    if info.links != 1:
        return f"has {info.links} hard links; another name would keep the data"
    return None


def refusal(info: FileInfo, d: Download, folder: Path) -> str | None:
    """Why an open file is not the copy of d in folder, from its handle's facts; None if every check passes. The
    SHA-256 is checked after this, through the same handle."""
    if why := not_plain(info):
        return why
    if info.size != d.size:
        return f"size {info.size} is not {d.size}"
    if abs(info.created - d.finished) > COPY_WINDOW_S:
        return f"created {info.created - d.finished:+.1f} s from the download's last size change"
    if os.path.normcase(os.path.dirname(info.final_path)) != os.path.normcase(str(folder)):
        return f"resolves to {info.final_path}, outside {folder}"
    return None


def delete_verified(path: Path, size: int, sha256: str) -> str | None:
    """Delete path only if it is the file described: one plain file of this size and SHA-256. It is opened with no
    sharing, every check reads that handle, and the deletion goes through it, so the file deleted is the file
    checked; nothing can replace it in between. Returns why the file was kept, or None once it is deleted. Raises
    OSError if it cannot be opened alone or the deletion is refused (on other systems than Windows, always)."""
    h = _open(path)
    try:
        info = _info(h)
        why = not_plain(info) or (f"size {info.size} is not {size}" if info.size != size else None)
        if why is None and _sha256(h) != sha256:
            why = "SHA-256 differs"
        if why is None:
            _mark_deleted(h)
        return why
    finally:
        _close(h)


def candidates(folder: Path, d: Download) -> list[Path]:
    """Plain .rar files (any case) directly in folder whose size and creation time could make them d's copy. Read
    from the folder listing, before anything is opened; clean() checks size and time again through the handle."""
    out = []
    with os.scandir(folder) as it:
        for e in it:
            if not e.name.lower().endswith(".rar") or not e.is_file(follow_symlinks=False):
                continue
            st = e.stat(follow_symlinks=False)
            created = getattr(st, "st_birthtime", st.st_ctime)
            if st.st_size == d.size and abs(created - d.finished) <= COPY_WINDOW_S:
                out.append(Path(e.path))
    return sorted(out)


def _log(log_path: Path, rows: list[dict]) -> None:
    """Append rows, flushed and synced to disk before returning."""
    if not rows:
        return
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
        f.flush()
        os.fsync(f.fileno())


def clean(folder: Path, d: Download, delete: bool, log_path: Path) -> list[dict]:
    """Delete d's copy from folder when exactly one file there is it (with delete False, say it would be). Every
    candidate's outcome is logged to log_path and returned: deleted (after a deleting row written first),
    would_delete, ambiguous (more than one file could be the copy; none deleted) or kept, with the reason."""
    def row(path, outcome, reason=None):
        return dict(time=time.strftime("%Y-%m-%dT%H:%M:%S%z"), archive=d.id, path=str(path), size=d.size,
                    sha256=d.sha256, download_finished=d.finished, outcome=outcome, reason=reason)

    rows: list[dict] = []
    matches: list[tuple[Path, object]] = []  # open handles of files that pass every check
    unverified: list[tuple[Path, str]] = []  # same size and time, but not checked through: could be the copy
    try:
        for path in candidates(folder, d):
            try:
                h = _open(path)
            except OSError as e:
                unverified.append((path, f"could not open it alone: {e}"))
                continue
            try:
                info = _info(h)
                if info.size != d.size or abs(info.created - d.finished) > COPY_WINDOW_S:
                    why, kind = refusal(info, d, folder), "kept"
                elif refusal(info, d, folder):
                    why, kind = refusal(info, d, folder), "unverified"
                elif _sha256(h) != d.sha256:
                    why, kind = "SHA-256 differs", "kept"
                else:
                    why, kind = None, "match"
            except BaseException:
                _close(h)
                raise
            if kind == "match":
                matches.append((path, h))
                continue
            _close(h)
            if kind == "unverified":
                unverified.append((path, why))
            else:
                rows.append(row(path, "kept", why))
        if matches and len(matches) + len(unverified) > 1:
            paths = [str(x) for x, _ in matches] + [str(x) for x, _ in unverified]
            for x, _ in matches:
                rows.append(row(x, "ambiguous", f"{len(paths)} files could be the browser's copy: {paths}; none deleted"))
            for x, why in unverified:
                rows.append(row(x, "ambiguous", f"{why}; {len(paths)} files could be the browser's copy: {paths}"))
        else:
            rows += [row(x, "kept", why) for x, why in unverified]
            if matches and not delete:
                rows.append(row(matches[0][0], "would_delete"))
            elif matches:
                path, h = matches.pop()
                rows.append(row(path, "deleting"))
                _log(log_path, rows)  # the intent is on disk before the file goes
                logged, rows = list(rows), []
                # The outcome is the handle's own: the file it names is marked for deletion, and goes when this, its
                # only handle, closes. A check of the path afterwards could see a file someone made there since.
                try:
                    _mark_deleted(h)
                    failed = None
                except OSError as e:
                    failed = f"deletion failed: {e}"
                finally:
                    _close(h)
                rows.append(row(path, "kept" if failed else "deleted", failed))
                _log(log_path, rows)
                return logged + rows
    finally:
        for _, h in matches:
            _close(h)
    _log(log_path, rows)
    return rows


# ---------------------------------------------------------------------------
# Win32
# ---------------------------------------------------------------------------

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _shell32 = ctypes.WinDLL("shell32")
    _ole32 = ctypes.WinDLL("ole32")

    class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [("dwFileAttributes", wintypes.DWORD), ("ftCreationTime", wintypes.FILETIME),
                    ("ftLastAccessTime", wintypes.FILETIME), ("ftLastWriteTime", wintypes.FILETIME),
                    ("dwVolumeSerialNumber", wintypes.DWORD), ("nFileSizeHigh", wintypes.DWORD),
                    ("nFileSizeLow", wintypes.DWORD), ("nNumberOfLinks", wintypes.DWORD),
                    ("nFileIndexHigh", wintypes.DWORD), ("nFileIndexLow", wintypes.DWORD)]

    class _FILE_DISPOSITION_INFO(ctypes.Structure):
        _fields_ = [("DeleteFile", wintypes.BOOLEAN)]

    _GENERIC_READ, _DELETE = 0x80000000, 0x00010000
    _OPEN_EXISTING = 3
    _FILE_FLAG_OPEN_REPARSE_POINT, _FILE_FLAG_SEQUENTIAL_SCAN = 0x00200000, 0x08000000
    _FILE_DISPOSITION_INFO_CLASS = 4  # FileDispositionInfo
    _INVALID = wintypes.HANDLE(-1).value

    _k32.CreateFileW.restype = wintypes.HANDLE
    _k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _k32.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(_BY_HANDLE_FILE_INFORMATION)]
    _k32.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    _k32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    _k32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                              wintypes.LPVOID]
    _k32.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _shell32.SHGetKnownFolderPath.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.HANDLE,
                                              ctypes.POINTER(ctypes.c_void_p)]
    _shell32.SHGetKnownFolderPath.restype = ctypes.c_long  # an HRESULT, checked here
    _ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]

    def _fail(what: str) -> OSError:
        err = ctypes.get_last_error()
        return OSError(0, f"{what}: {ctypes.FormatError(err).strip()}", None, err)

    def _epoch(ft) -> float:
        return ((ft.dwHighDateTime << 32) | ft.dwLowDateTime) / 1e7 - 11644473600.0

    def _open(path: Path):
        # No sharing: until the handle closes, no one else can open, write, rename or delete the file. The final
        # component is opened as itself, never followed if it is a link, so refusal() sees its reparse attribute.
        h = _k32.CreateFileW(str(path), _GENERIC_READ | _DELETE, 0, None, _OPEN_EXISTING,
                             _FILE_FLAG_OPEN_REPARSE_POINT | _FILE_FLAG_SEQUENTIAL_SCAN, None)
        if h == _INVALID or h is None:
            raise _fail("CreateFileW")
        return h

    def _close(h) -> None:
        _k32.CloseHandle(h)

    def _info(h) -> FileInfo:
        bhfi = _BY_HANDLE_FILE_INFORMATION()
        if not _k32.GetFileInformationByHandle(h, ctypes.byref(bhfi)):
            raise _fail("GetFileInformationByHandle")
        buf = ctypes.create_unicode_buffer(32768)
        n = _k32.GetFinalPathNameByHandleW(h, buf, len(buf), 0)
        if not n or n >= len(buf):
            raise _fail("GetFinalPathNameByHandleW")
        final = buf.value[4:] if buf.value.startswith("\\\\?\\") else buf.value
        return FileInfo(attributes=bhfi.dwFileAttributes, links=bhfi.nNumberOfLinks,
                        size=(bhfi.nFileSizeHigh << 32) | bhfi.nFileSizeLow, created=_epoch(bhfi.ftCreationTime),
                        final_path=final)

    def _sha256(h) -> str:
        sha, buf, got = hashlib.sha256(), ctypes.create_string_buffer(1 << 22), wintypes.DWORD()
        while True:
            if not _k32.ReadFile(h, buf, len(buf), ctypes.byref(got), None):
                raise _fail("ReadFile")
            if got.value == 0:
                return sha.hexdigest()
            sha.update(memoryview(buf)[:got.value])

    def _mark_deleted(h) -> None:
        info = _FILE_DISPOSITION_INFO(True)
        if not _k32.SetFileInformationByHandle(h, _FILE_DISPOSITION_INFO_CLASS, ctypes.byref(info),
                                               ctypes.sizeof(info)):
            raise _fail("SetFileInformationByHandle(FileDispositionInfo)")

    def known_folder(folder_id: uuid.UUID) -> Path:
        """A Known Folder's path from the Known Folder API: it follows a moved or redirected folder, which a path
        under the user profile does not."""
        guid = (ctypes.c_byte * 16).from_buffer_copy(folder_id.bytes_le)
        p = ctypes.c_void_p()
        hr = _shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(p))
        try:
            if hr != 0:
                raise Refused(f"SHGetKnownFolderPath({folder_id}) failed: HRESULT {hr & 0xFFFFFFFF:#010x}")
            return Path(ctypes.wstring_at(p.value))
        finally:
            _ole32.CoTaskMemFree(p)  # the API allocates the string even when it fails

    def downloads_folder() -> Path:
        """The user's Downloads folder (known_folder)."""
        return known_folder(FOLDERID_DOWNLOADS)

    def known_folders() -> list[Path]:
        """The user's Desktop, Documents and Downloads folders, wherever they are."""
        return [known_folder(f) for f in (FOLDERID_DESKTOP, FOLDERID_DOCUMENTS, FOLDERID_DOWNLOADS)]
else:
    def _unsupported(*_a):
        raise OSError("the browser's Downloads copies are handled on Windows only")

    _open = _close = _info = _sha256 = _mark_deleted = _unsupported

    def downloads_folder() -> Path:
        raise Refused("the Downloads known folder is read on Windows only")

    def known_folders() -> list[Path]:
        home = Path.home()
        return [home / "Desktop", home / "Documents", home / "Downloads"]
