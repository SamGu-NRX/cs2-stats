# Starts demo_pipeline.py at Idle priority, detached from the calling console (Start-Detached in
# start_detached.ps1: outside the caller's process tree, so no shell time limit applies).
# Log: cs2-stats-data\logs\pipeline.log. Status: http://127.0.0.1:8766/pending.
# Stop: Stop-Process -Id (Get-Content <cs2-stats-data>\logs\pipeline.pid). The pid printed below is the venv
# launcher stub; the pipeline writes its real pid to that file.
# Settings come from this session's environment, passed on byte for byte: CS2_DEMO_DOWNLOADS (required),
# CS2_STATS_DATA, CS2_PIPELINE_MAX_GB, CS2_PIPELINE_MAX_WORKERS and CS2_PIPELINE_DOWNLOAD_COPIES.
$root = $PSScriptRoot
. (Join-Path $root 'start_detached.ps1')
$py = Join-Path $root '.venv\Scripts\pythonw.exe'
$script = Join-Path $root 'demo_pipeline.py'
if (-not $env:CS2_DEMO_DOWNLOADS) { throw "set CS2_DEMO_DOWNLOADS to the folder the browser saves HLTV demo archives to" }
$launcher = Start-Detached -CommandLine "`"$py`" -I `"$script`" $args" -Directory $root
"started launcher pid $launcher; real pid goes to cs2-stats-data\logs\pipeline.pid"
