param([ValidateRange(1024,65535)][int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$pidFile = Join-Path $runtimeRoot 'preview.json'
if (Test-Path -LiteralPath $pidFile) {
    $old = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if (Get-Process -Id $old.pid -ErrorAction SilentlyContinue) { throw '预览进程仍存在；请先使用 stop-preview.ps1，避免重复启动。' }
}
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$serverFile = Join-Path $projectRoot 'src\server.mjs'
$child = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverFile + '"', '--mock', '--port', $Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'preview.log') -RedirectStandardError (Join-Path $runtimeRoot 'preview-error.log') -PassThru
@{ pid = $child.Id; server = $serverFile; port = $Port; startedAt = $child.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8
Write-Output "本地模拟预览：http://127.0.0.1:$Port （仅回环；不连接服务器）"
