"""Where the extractor's and the model's outputs may land, the Python side of app/tools/outputs.ts.

Private outputs hold what must never be published: SteamIDs and player names (every extracted table,
from every source), the user's own SteamID, HLTV's rows, or values derived from the private HLTV
win-probability pack. They are refused anywhere inside the repository, compared on real paths and
without case on Windows, so no flag, path spelling, link or junction can put one in the tree. A public
output may land in the repository only at the one path it declares (`in_repo`), as
model/rating3/params.json does.

Private JSON gets a top-level "_private": "do not commit" key, and any other private file a
`.private.` name, so scripts/check-public-tree finds one that was committed anyway.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
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
                 repo: Path | str = REPO_ROOT) -> Path:
    """Path, after refusing a private output anywhere in the repository, or a public one in the
    repository anywhere but its declared in_repo path. Raises OutputRefused naming both."""
    path = Path(path)
    if not is_inside(path, repo):
        return path
    if private:
        raise OutputRefused(f"refusing to write {what} to {path}: it is private and must stay outside the repository ({repo})")
    if in_repo is None or os.path.normcase(str(real_path(path))) != os.path.normcase(str(real_path(in_repo))):
        where = f"its only place in the repository is {in_repo}" if in_repo is not None else "it has no place in the repository"
        raise OutputRefused(f"refusing to write {what} to {path}: {where}")
    return path


def write_json(path: Path | str, obj: dict, *, private: bool, what: str, in_repo: Path | str | None = None,
               repo: Path | str = REPO_ROOT, **dump) -> Path:
    """Checks where path may go, then writes obj as JSON, with the private marker first when private."""
    path = check_output(path, private=private, what=what, in_repo=in_repo, repo=repo)
    if private:
        obj = {PRIVATE_KEY: PRIVATE_VALUE, **obj}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, **dump) + "\n", encoding="utf-8")
    return path
