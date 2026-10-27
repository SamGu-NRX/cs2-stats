"""start_detached.ps1, which start_pipeline.ps1 starts the pipeline with: settings reach the process byte for byte."""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(os.name != "nt" or not shutil.which("powershell.exe"), reason="Windows PowerShell only")
def test_settings_reach_the_detached_process_byte_for_byte(tmp_path):
    # Review of PR 55: the settings went through a cmd.exe "set" string, which expanded %VAR% inside a value
    # (C:\data\100%TEMP%\pipeline was mangled) and would have split on & and quotes.
    tricky = 'C:\\data\\100%TEMP%\\pipe & "q" ^ !x! = end \u00fc\u2713\u4e2d'
    probe, out = tmp_path / "probe.py", tmp_path / "out.json"
    probe.write_text("import json, os, sys\n"
                     "json.dump({k: v for k, v in os.environ.items() if k.startswith('CS2_')},"
                     " open(sys.argv[1], 'w', encoding='utf-8'))\n", encoding="utf-8")
    command = f'"{sys.executable}" -I "{probe}" "{out}"'.replace("'", "''")
    ps = f". '{ROOT / 'start_detached.ps1'}'; Start-Detached -CommandLine '{command}' -Directory '{tmp_path}'"
    subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], check=True,
                   env=dict(os.environ, CS2_TRICKY=tricky), capture_output=True, timeout=60)
    deadline = time.time() + 30
    while not (out.exists() and out.stat().st_size) and time.time() < deadline:
        time.sleep(0.2)
    assert json.loads(out.read_text(encoding="utf-8"))["CS2_TRICKY"] == tricky
