# Cleans up the Windows-side Neo4j/Qdrant data after successful migration.
#
# DANGER: This deletes the Windows Neo4j graph database and all Qdrant storage.
# Only run this after verify_migration.ps1 reports PASSED and you have confirmed
# the Docker stack is serving correct data.
#
# This script:
# 1. Stops the Windows Neo4j service (if running)
# 2. Deletes the Neo4j data/logs directories
# 3. Deletes the Qdrant storage directory
# 4. Leaves cube files untouched (they are now shared via bind mount)
#
# The SQLite user_manager.db stays in src/oh_memos/data/runtime/ for reference,
# but is no longer used — the container has its own copy in the runtime volume.

param(
    [Parameter(Mandatory=$false)]
    [string]$Neo4jDataDir = 'D:\neo4j-community-5.15.0\data',

    [Parameter(Mandatory=$false)]
    [string]$Neo4jLogsDir = 'D:\neo4j-community-5.15.0\logs',

    [Parameter(Mandatory=$false)]
    [string]$QdrantStorageDir = 'G:\test\oh-memos\data\qdrant_storage',

    [Parameter(Mandatory=$false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Log { param($m) Write-Host "[$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')][INFO] $m" }
function Warn { param($m) Write-Host "[$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')][WARN] $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "[$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')][ERROR] $m" -ForegroundColor Red; exit 1 }

if (-not $Force) {
    Write-Host ''
    Write-Host '=========================================' -ForegroundColor Red
    Write-Host '  WARNING: DESTRUCTIVE OPERATION' -ForegroundColor Red
    Write-Host '=========================================' -ForegroundColor Red
    Write-Host ''
    Write-Host 'This will DELETE:' -ForegroundColor Yellow
    Write-Host "  - Neo4j data:    $Neo4jDataDir"
    Write-Host "  - Neo4j logs:    $Neo4jLogsDir"
    Write-Host "  - Qdrant storage: $QdrantStorageDir"
    Write-Host ''
    Write-Host 'Before proceeding, confirm that:' -ForegroundColor Yellow
    Write-Host '  1. verify_migration.ps1 reported PASSED'
    Write-Host '  2. You have tested the Docker API at http://127.0.0.1:18100'
    Write-Host '  3. You have a backup in D:\oh-memos-migration if you need to roll back'
    Write-Host ''
    $confirm = Read-Host 'Type YES to proceed'
    if ($confirm -ne 'YES') { Log 'Aborted.'; exit 0 }
}

# --- 1. Stop Neo4j Windows service if running ---------------------------------
Log 'Checking for running Neo4j service...'
$neo4jSvc = Get-Service -Name 'neo4j' -ErrorAction SilentlyContinue
if ($neo4jSvc -and $neo4jSvc.Status -eq 'Running') {
    Log 'Stopping Neo4j service...'
    Stop-Service -Name 'neo4j' -Force
    Start-Sleep -Seconds 3
}

# --- 2. Delete Neo4j data and logs ---------------------------------------------
if (Test-Path $Neo4jDataDir) {
    Log "Deleting Neo4j data: $Neo4jDataDir"
    Remove-Item -Recurse -Force $Neo4jDataDir
    Log '  ✓ Neo4j data deleted'
} else {
    Warn "  Neo4j data dir not found: $Neo4jDataDir (already deleted?)"
}

if (Test-Path $Neo4jLogsDir) {
    Log "Deleting Neo4j logs: $Neo4jLogsDir"
    Remove-Item -Recurse -Force $Neo4jLogsDir
    Log '  ✓ Neo4j logs deleted'
} else {
    Warn "  Neo4j logs dir not found: $Neo4jLogsDir (already deleted?)"
}

# --- 3. Delete Qdrant storage --------------------------------------------------
if (Test-Path $QdrantStorageDir) {
    Log "Deleting Qdrant storage: $QdrantStorageDir"
    Remove-Item -Recurse -Force $QdrantStorageDir
    Log '  ✓ Qdrant storage deleted'
} else {
    Warn "  Qdrant storage dir not found: $QdrantStorageDir (already deleted?)"
}

Log ''
Log '========================================='
Log '  WINDOWS DATA CLEANUP COMPLETE'
Log '========================================='
Log ''
Log 'The Windows-side Neo4j and Qdrant data have been deleted.'
Log 'Cube files remain at their original location and are now shared via Docker bind mount.'
Log ''
Log 'To start the Docker stack:'
Log '  docker compose --env-file docker/.env.migration \'
Log '    -f docker/docker-compose.yml \'
Log '    -f docker/docker-compose.migration.yml up -d'
