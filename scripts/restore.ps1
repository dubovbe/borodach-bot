# RESTORE_ARCHIVE is explicit; never select latest or modify the source database.
$ErrorActionPreference = 'Stop'
try {
    $node = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }
    & $node (Join-Path $PSScriptRoot 'backup-ops.ts') 'restore' 2>$null
    if ($LASTEXITCODE -ne 0) { exit 1 }
    exit 0
} catch {
    Write-Output '{"ok":false,"code":"RESTORE_FAILED"}'
    exit 1
}
