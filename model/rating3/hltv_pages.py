"""Every saved HLTV map page the fits read, one per HLTV map."""
from __future__ import annotations

import json
from pathlib import Path


def hltv_pages(hltv: Path) -> list[Path]:
    """The HLTV map pages in hltv, sorted: map_*.json (saved by the HLTV tab) and ocs_map_*.json (saved for the
    OpenCS2 demos), the same v3 page format. One page per mapstatsid: when both kinds hold one HLTV map, the
    map_*.json page is kept. A page without a mapstatsid raises ValueError, as two of them could not be told apart."""
    pages: dict[str, Path] = {}
    for pattern in ("map_*.json", "ocs_map_*.json"):
        for path in sorted(hltv.glob(pattern)):
            msid = json.loads(path.read_text(encoding="utf-8")).get("mapstatsid")
            if not msid:
                raise ValueError(f"{path.name}: no mapstatsid, so it cannot be told apart from another page of its map")
            pages.setdefault(str(msid), path)
    return sorted(pages.values())
