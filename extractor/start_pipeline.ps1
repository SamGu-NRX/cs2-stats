# Starts demo_pipeline.py at Idle priority, detached from the calling console
# (Win32_Process.Create puts it outside the caller's process tree, so no shell time limit applies).
# Log: cs2-stats-data\logs\pipeline.log. Status: http://127.0.0.1:8766/pending.
# Stop: Stop-Process -Id (Get-Content <cs2-stats-data>\logs\pipeline.pid). The pid printed below is
# cmd.exe that starts it; the pipeline writes its real pid to that file.
# Settings come from this session's environment: CS2_DEMO_DOWNLOADS (required), CS2_STATS_DATA,
# CS2_PIPELINE_MAX_GB and CS2_PIPELINE_MAX_WORKERS. Win32_Process.Create does not pass the caller's
# environment on (a probe saw none of a session's CS2_ variables), so cmd.exe sets them for the pipeline.
$root = $PSScriptRoot
$py = Join-Path $root '.venv\Scripts\pythonw.exe'
$script = Join-Path $root 'demo_pipeline.py'
if (-not $env:CS2_DEMO_DOWNLOADS) { throw "set CS2_DEMO_DOWNLOADS to the folder the browser saves HLTV demo archives to" }
$sets = foreach ($n in 'CS2_DEMO_DOWNLOADS', 'CS2_STATS_DATA', 'CS2_PIPELINE_MAX_GB', 'CS2_PIPELINE_MAX_WORKERS') {
    $v = [Environment]::GetEnvironmentVariable($n)
    if ($v) { "set `"$n=$v`"&& " }
}
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ PriorityClass = [uint32]64 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "cmd.exe /d /s /c `"$(-join $sets)`"$py`" -I `"$script`" $args`""
    CurrentDirectory = $root
    ProcessStartupInformation = $startup
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($r.ReturnValue)" }
"started launcher pid $($r.ProcessId); real pid goes to cs2-stats-data\logs\pipeline.pid"
