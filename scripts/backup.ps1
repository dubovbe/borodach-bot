# Thin entry point: explicit environment only; no dot sourcing or connection arguments.
$ErrorActionPreference = 'Stop'
try {
    $node = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }
    & $node (Join-Path $PSScriptRoot 'backup-ops.ts') 'backup' 2>$null
    if ($LASTEXITCODE -eq 2) { exit 2 }
    if ($LASTEXITCODE -ne 0) { exit 1 }
    exit 0
} catch {
    Write-Output '{"ok":false,"code":"BACKUP_FAILED"}'
    exit 1
}
