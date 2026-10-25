"""Resolve extractor demo folders and their legacy table aliases."""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import TypeVar


T = TypeVar("T")


_CURRENT_NAME = re.compile(r"v-[0-9A-Za-z.+_]+-[0-9a-f]{8}\Z")


class IncompleteDemoVersion(ValueError):
    """A CURRENT target whose completion manifest does not match its files."""


@dataclass(frozen=True)
class DemoLayout:
    """A validated map folder and the table names it contains."""

    directory: Path
    format: str

    def table(self, name: str) -> Path:
        aliases = {
            "match": "meta" if self.format == "legacy" else "match",
            "player_rounds": "economy" if self.format == "legacy" else "player_rounds",
        }
        filename = aliases.get(name, name) + ".parquet"
        path = self.directory / filename
        if not path.exists():
            raise FileNotFoundError(f"{self.format} demo folder lacks {filename}: {self.directory}")
        return path


def _map_directory(root: Path, demo: str | Path) -> Path:
    path = Path(demo)
    return path if path.is_absolute() else root / path


def _complete_reason(directory: Path) -> str | None:
    manifest = directory / "COMPLETE"
    if not manifest.is_file():
        return "missing COMPLETE"
    try:
        entries = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return f"invalid COMPLETE: {error}"
    if not isinstance(entries, dict):
        return "invalid COMPLETE: expected a filename-to-size object"
    if not entries:
        return "invalid COMPLETE: empty manifest"
    for filename, expected_size in entries.items():
        if not isinstance(filename, str) or Path(filename).name != filename:
            return f"invalid COMPLETE filename: {filename!r}"
        if isinstance(expected_size, bool) or not isinstance(expected_size, int) or expected_size < 0:
            return f"invalid COMPLETE size for {filename!r}: {expected_size!r}"
        path = directory / filename
        if not path.is_file():
            return f"COMPLETE file missing: {filename}"
        if path.stat().st_size != expected_size:
            return f"COMPLETE size mismatch for {filename}: expected {expected_size}, got {path.stat().st_size}"
    return None


def resolve_demo_dir(root: Path, demo: str | Path) -> Path:
    """Resolve a complete CURRENT version, or return a flat legacy folder."""
    map_dir = _map_directory(root, demo)
    if (map_dir / "RETIRED").exists():
        raise ValueError(f"demo folder is retired: {map_dir}")
    current = map_dir / "CURRENT"
    if not current.exists():
        return map_dir
    target = current.read_text(encoding="utf-8").strip()
    if not _CURRENT_NAME.fullmatch(target):
        raise ValueError(f"invalid CURRENT pointer in {current}: {target!r}")
    resolved = map_dir / target
    if not resolved.is_dir():
        raise IncompleteDemoVersion(f"incomplete CURRENT target {target}: folder does not exist")
    reason = _complete_reason(resolved)
    if reason is not None:
        raise IncompleteDemoVersion(f"incomplete CURRENT target {target}: {reason}")
    return resolved


def demo_layout(root: Path, demo: str | Path) -> DemoLayout:
    """Resolve and validate one map as schema v1 or the legacy format."""
    directory = resolve_demo_dir(root, demo)
    if (directory / "match.parquet").exists() and (directory / "player_rounds.parquet").exists():
        return DemoLayout(directory, "schema_v1")
    if (directory / "meta.parquet").exists() and (directory / "economy.parquet").exists():
        return DemoLayout(directory, "legacy")
    raise ValueError(
        f"demo folder is neither schema v1 (match.parquet + player_rounds.parquet) "
        f"nor legacy (meta.parquet + economy.parquet): {directory}"
    )


def _current_target(root: Path, demo: str | Path) -> str | None:
    current = _map_directory(root, demo) / "CURRENT"
    try:
        if not current.is_file():
            return None
        return current.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None


def load_demo_tables(
    root: Path,
    demo: str | Path,
    names: Iterable[str],
    read_table: Callable[[Path], T],
) -> tuple[DemoLayout, dict[str, T]]:
    """Load every table from one layout, retrying once after a CURRENT republish.

    A publish can retire the resolved version while a consumer is opening its
    next table. The failed attempt is discarded so callers never combine tables
    from two versions of one map.
    """
    table_names = tuple(names)
    for attempt in range(2):
        try:
            layout = demo_layout(root, demo)
            target = _current_target(root, demo)
            tables = {name: read_table(layout.table(name)) for name in table_names}
        except FileNotFoundError:
            if attempt == 1:
                raise
            continue
        if _current_target(root, demo) != target:
            if attempt == 1:
                raise FileNotFoundError(f"demo was republished while loading: {demo}")
            continue
        return layout, tables
    raise AssertionError("load_demo_tables exhausted without returning or raising")


def iter_demo_roots(root: Path):
    """Yield complete map-folder paths, skipping incomplete CURRENT versions."""
    demos = root / "demos"
    if not demos.exists():
        return
    for archive in sorted(path for path in demos.iterdir() if path.is_dir()):
        for map_dir in sorted(path for path in archive.iterdir() if path.is_dir()):
            if (map_dir / "RETIRED").exists():
                continue
            markers = ("CURRENT", "match.parquet", "meta.parquet", "player_rounds.parquet", "economy.parquet")
            if not any((map_dir / marker).exists() for marker in markers):
                continue
            relative = map_dir.relative_to(root)
            try:
                layout = demo_layout(root, relative)
            except IncompleteDemoVersion:
                continue
            yield relative, layout
