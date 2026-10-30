$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot '.runtime\preview.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output '没有本项目记录的预览进程。'; exit 0 }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
if ($null -eq $proc) { Remove-Item -LiteralPath $pidFile; Write-Output '预览进程已退出。'; exit 0 }
if ($proc.Name -ne 'node.exe' -or -not $proc.CommandLine.Contains($record.server) -or -not $proc.CommandLine.Contains('--mock')) { throw 'PID 已被其他进程复用，拒绝停止。' }
$live = Get-Process -Id $record.pid
$recordedStart = if ($record.startedAt -is [datetime]) { $record.startedAt.ToUniversalTime() } else { [datetimeoffset]::Parse($record.startedAt).UtcDateTime }
if ([Math]::Abs(($live.StartTime.ToUniversalTime() - $recordedStart).TotalSeconds) -gt 2) { throw '进程启动时间不匹配，拒绝停止。' }
Stop-Process -Id $record.pid
Remove-Item -LiteralPath $pidFile
Write-Output '已停止本项目的本地模拟预览。'
