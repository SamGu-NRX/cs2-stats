"""When the extractor's own modules or their dependencies (demoparser2, awpy, polars, ...) cannot be imported
here, every test file is one skipped test that says why, instead of an error while collecting. A review run whose
environment lacked a Rust temp path got collection errors and no result at all."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_WHY = None
try:
    import demo_pipeline  # noqa: E402,F401  (imports extract, and through it every dependency)
except Exception as e:  # noqa: BLE001 - any failure to import means nothing here can run
    _WHY = f"the extractor's modules do not import here ({type(e).__name__}: {e})"

if _WHY:
    class _Skipped(pytest.Item):
        def runtest(self):
            pytest.skip(_WHY)

    class _Unimportable(pytest.File):
        def collect(self):
            yield _Skipped.from_parent(self, name="dependencies")

    def pytest_pycollect_makemodule(module_path, parent):
        return _Unimportable.from_parent(parent, path=module_path)
