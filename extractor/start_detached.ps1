# Start-Detached: start a command at Idle priority outside the caller's process tree (Win32_Process.Create,
# so no shell time limit applies), with this session's whole environment passed as a block. Every value then
# arrives byte for byte; a cmd.exe "set" string expanded %VAR% inside values (C:\data\100%TEMP%\x was
# mangled). Returns the started process id. Dot-source it: . .\start_detached.ps1
function Start-Detached([string]$CommandLine, [string]$Directory) {
    $block = [string[]](Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
        PriorityClass = [uint32]64
        EnvironmentVariables = $block
    }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $CommandLine
        CurrentDirectory = $Directory
        ProcessStartupInformation = $startup
    }
    if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($r.ReturnValue)" }
    $r.ProcessId
}
