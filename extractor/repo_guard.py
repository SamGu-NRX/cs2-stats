"""Where the extractor's and the model's outputs may land, the Python side of app/tools/outputs.ts.

Private outputs hold what must never be published: SteamIDs and player names (every extracted table,
from every source), the user's own SteamID, HLTV's rows, or values derived from the private HLTV
win-probability pack. They are refused anywhere inside the repository, compared on real paths and
without case on Windows, so no flag, path spelling, link or junction can put one in the tree. A public
output may land in the repository only at the one path it declares (`in_repo`), as
model/rating3/params.json does.

Private JSON gets PRIVATE_KEY set to PRIVATE_VALUE as its first key, and any other private file a
`.private.` name, so scripts/check-public-tree finds one that was committed anyway.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# The pipeline runs workers from a copy of this folder under %TEMP% (demo_pipeline.freeze_code), with FROZEN_MARKER
# beside it. There __file__ says nothing about the repository, so the pipeline names it in REPO_ENV; a frozen copy
# without it refuses every output instead of guarding %TEMP%'s parent.
FROZEN_MARKER = "FROZEN_COPY"
REPO_ENV = "CS2_STATS_REPO"


def repo_root() -> Path:
    """The repository this code guards: the folder above this file, or REPO_ENV in the pipeline's frozen copy."""
    here = Path(__file__).resolve().parent
    if not (here / FROZEN_MARKER).exists():
        return here.parent
    named = os.environ.get(REPO_ENV)
    if not named:
        raise OutputRefused(f"this is the pipeline's frozen copy of the extractor ({here}); {REPO_ENV} must name the "
                            "repository it was copied from, and is not set")
    return Path(named)


REPO_ROOT = None if (Path(__file__).resolve().parent / FROZEN_MARKER).exists() else Path(__file__).resolve().parent.parent
PRIVATE_KEY = "_private"
PRIVATE_VALUE = "do not commit"


class OutputRefused(ValueError):
    """An output that may not land where it was asked to."""


def real_path(p: Path | str) -> Path:
    """The real path of p: its nearest existing ancestor resolved (links, junctions, real case), then the
    segments that do not exist yet, so a file about to be written has a real path too."""
    cur = Path(os.path.abspath(p))
    rest: list[str] = []
    while not cur.exists() and cur.parent != cur:
        rest.insert(0, cur.name)
        cur = cur.parent
    return cur.resolve().joinpath(*rest)


def is_inside(child: Path | str, parent: Path | str) -> bool:
    """Whether child is parent or inside it, on real paths; normcase ignores case on Windows."""
    c, p = os.path.normcase(str(real_path(child))), os.path.normcase(str(real_path(parent)))
    try:
        return os.path.commonpath([c, p]) == p
    except ValueError:  # different drives
        return False


def check_output(path: Path | str, *, private: bool, what: str, in_repo: Path | str | None = None,
                 repo: Path | str | None = None) -> Path:
    """Path, after refusing a private output anywhere in the repository (repo, or repo_root()), or a public one in
    the repository anywhere but its declared in_repo path. Raises OutputRefused naming both."""
    path = Path(path)
    repo = repo if repo is not None else repo_root()
    if not is_inside(path, repo):
        return path
    if private:
        raise OutputRefused(f"refusing to write {what} to {path}: it is private and must stay outside the repository ({repo})")
    if in_repo is None or os.path.normcase(str(real_path(path))) != os.path.normcase(str(real_path(in_repo))):
        where = f"its only place in the repository is {in_repo}" if in_repo is not None else "it has no place in the repository"
        raise OutputRefused(f"refusing to write {what} to {path}: {where}")
    return path


def check_text_output(path: Path | str, *, private: bool, what: str, in_repo: Path | str | None = None,
                      repo: Path | str | None = None) -> Path:
    """check_output for a file that cannot hold the JSON marker: a private one must also be named
    *.private.*, so the name carries the marker instead."""
    path = check_output(path, private=private, what=what, in_repo=in_repo, repo=repo)
    if private and ".private." not in Path(path).name:
        raise OutputRefused(f"refusing to write {what} to {path}: a private file that is not JSON must be named *.private.*")
    return path


def write_text(path: Path | str, text: str, *, private: bool, what: str, in_repo: Path | str | None = None,
               repo: Path | str | None = None) -> Path:
    """Checks where path may go (check_text_output), then writes text."""
    path = check_text_output(path, private=private, what=what, in_repo=in_repo, repo=repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path | str, obj: dict, *, private: bool, what: str, in_repo: Path | str | None = None,
               repo: Path | str | None = None, **dump) -> Path:
    """Checks where path may go, then writes obj as JSON, with the private marker first when private."""
    path = check_output(path, private=private, what=what, in_repo=in_repo, repo=repo)
    if private:
        obj = {PRIVATE_KEY: PRIVATE_VALUE, **obj}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, **dump) + "\n", encoding="utf-8")
    return path
