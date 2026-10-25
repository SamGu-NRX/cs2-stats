# Starts demo_pipeline.py at Idle priority, detached from the calling console
# (Win32_Process.Create puts it outside the caller's process tree, so no shell time limit applies).
# Log: cs2-stats-data\logs\pipeline.log. Status: http://127.0.0.1:8766/pending.
# Stop: Stop-Process -Id (Get-Content <cs2-stats-data>\logs\pipeline.pid). The pid printed below is
# the venv launcher stub; the pipeline writes its real pid to that file.
$root = $PSScriptRoot
$py = Join-Path $root '.venv\Scripts\pythonw.exe'
$script = Join-Path $root 'demo_pipeline.py'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ PriorityClass = [uint32]64 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "`"$py`" -I `"$script`" $args"
    CurrentDirectory = $root
    ProcessStartupInformation = $startup
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($r.ReturnValue)" }
"started launcher pid $($r.ProcessId); real pid goes to cs2-stats-data\logs\pipeline.pid"
