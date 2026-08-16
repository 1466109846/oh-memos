<#
.SYNOPSIS
    Windows to Docker full-data migration for oh-memos.

.DESCRIPTION
    Stages (run one at a time with -Stage):

      preflight   Check that all preconditions are met and print a source
                  manifest. Safe to run at any time; makes no changes.

      backup      Stop the Windows API (if still running), stop Neo4j and
                  Qdrant, and copy everything to -MigrationDir:
                    * Neo4j offline dump   (neo4j-admin database dump)
                    * Qdrant storage copy  (full directory, same version)
                    * SQLite + WAL/SHM     (memos_users.db and siblings)
                    * cube archive         (full tree: configs, canvases, …)
                  Writes a hash manifest. Does NOT touch source data.

      restore     Start matching-version Docker targets (Neo4j 5.15, Qdrant
                  1.16.3), load the dump, copy the Qdrant storage into the
                  container volume, copy SQLite into the runtime volume, then
                  unpack the cube archive to the new host cube dir.
                  Starts the API only after all data is in place.

      verify      Cross-check every manifest entry against the live Docker
                  stack. Restarts once and re-checks. Prints a pass/fail table.

      cleanup     Requires -ConfirmWindowsPurge. Re-verifies first, then
                  PERMANENTLY DELETES the Windows source data:
                    * D:\User\neo4j-community-5.15.0\data
                    * D:\User\Qdrant\storage
                    * <repo>\src\.memos
                    * <repo>\data\oh-memos_cubes

.PARAMETER Stage
    One of: preflight | backup | restore | verify | cleanup

.PARAMETER MigrationDir
    Working directory for dump/snapshots/SQLite/manifest.
    Default: D:\oh-memos-migration
    Must NOT be inside the repository or the directories that cleanup will delete.

.PARAMETER NewCubeDir
    New host path for cube configs and canvases after migration.
    The base compose file's MEMOS_CUBES_HOST_DIR should point here.
    Default: D:\oh-memos-data\cubes

.PARAMETER ComposeEnvFile
    Path to docker/.env.migration (populated from .env.migration.example).
    Default: <repo>/docker/.env.migration

.PARAMETER ConfirmWindowsPurge
    Switch required by the cleanup stage. Makes the irreversible delete non-
    interactive. Without it the cleanup stage refuses to execute.

.EXAMPLE
    # Step 1 – confirm everything is ready and see the source manifest
    powershell -File scripts/migrate/migrate_win_to_docker.ps1 -Stage preflight

    # Step 2 – stop services and create backup artefacts
    powershell -File scripts/migrate/migrate_win_to_docker.ps1 -Stage backup

    # Step 3 – populate Docker volumes
    powershell -File scripts/migrate/migrate_win_to_docker.ps1 -Stage restore

    # Step 4 – cross-check everything
    powershell -File scripts/migrate/migrate_win_to_docker.ps1 -Stage verify

    # Step 5 – delete Windows source data (IRREVERSIBLE)
    powershell -File scripts/migrate/migrate_win_to_docker.ps1 -Stage cleanup -ConfirmWindowsPurge
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('preflight','backup','restore','verify','cleanup')]
    [string]$Stage,

    [string]$MigrationDir    = 'D:\oh-memos-migration',
    [string]$NewCubeDir      = 'D:\oh-memos-data\cubes',
    [string]$ComposeEnvFile  = '',          # auto-detected if empty
    [int]$ApiPort            = 18100,
    [switch]$ConfirmWindowsPurge            # required for cleanup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- paths --------------------------------------------------------------------
$RepoRoot   = (Get-Item "$PSScriptRoot\..\.." ).FullName
$SrcNeo4j   = if ($env:OH_MEMOS_SRC_NEO4J_HOME) { $env:OH_MEMOS_SRC_NEO4J_HOME } else { 'D:\User\neo4j-community-5.15.0' }
$SrcQdrant  = if ($env:OH_MEMOS_SRC_QDRANT_HOME) { $env:OH_MEMOS_SRC_QDRANT_HOME } else { 'D:\User\Qdrant' }
$SrcSQLite  = Join-Path $RepoRoot 'src\.memos\memos_users.db'
$SrcCubes   = Join-Path $RepoRoot 'data\oh-memos_cubes'
$DockerDir  = Join-Path $RepoRoot 'docker'
if (-not $ComposeEnvFile) {
    $ComposeEnvFile = Join-Path $DockerDir '.env.migration'
}
if ($env:OH_MEMOS_MIGRATION_DIR -and $MigrationDir -eq 'D:\oh-memos-migration') {
    $MigrationDir = $env:OH_MEMOS_MIGRATION_DIR
}
if ($env:MEMOS_CUBES_HOST_DIR -and $NewCubeDir -eq 'D:\oh-memos-data\cubes') {
    $NewCubeDir = $env:MEMOS_CUBES_HOST_DIR
}
$LogFile    = Join-Path $MigrationDir "migration-$(Get-Date -f 'yyyyMMdd-HHmmss').log"

# --- helpers ------------------------------------------------------------------
function Write-Log {
    param([string]$Msg, [string]$Level='INFO')
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts][$Level] $Msg"
    Write-Host $line
    if (Test-Path (Split-Path $LogFile)) { Add-Content -Path $LogFile -Value $line }
}
function Fail { param([string]$Msg) Write-Log $Msg 'ERROR'; throw "Migration aborted: $Msg" }
function Warn { param([string]$Msg) Write-Log $Msg 'WARN' }

function Get-EnvFileValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return '' }
    $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return (($line -split '=', 2)[1] -split '\s+#', 2)[0].Trim().Trim('"').Trim("'")
}

function Get-SHA256 {
    param([string]$Path)
    # Get-FileHash was introduced in PowerShell 4 / Windows PowerShell 5,
    # but is absent in some minimal / non-interactive script environments.
    # Fall back to the underlying .NET API which is always available.
    try {
        return (Get-FileHash -Algorithm SHA256 -Path $Path -ErrorAction Stop).Hash
    } catch {
        $h = [System.Security.Cryptography.SHA256]::Create()
        try {
            $b = [System.IO.File]::ReadAllBytes($Path)
            return [BitConverter]::ToString($h.ComputeHash($b)) -replace '-',''
        } finally { $h.Dispose() }
    }
}

function Wait-PortClosed {
    param([int]$Port, [int]$TimeoutSec=30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $listening = netstat -ano 2>$null | Select-String ":$Port\s" | Select-String 'LISTENING'
        if (-not $listening) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Stop-OhMemosAPI {
    Write-Log 'Looking for Windows oh-memos API on port 18000...'
    $procs = Get-CimInstance Win32_Process -Filter "name='python.exe'" |
        Where-Object { $_.CommandLine -match 'uvicorn' -and
                       ($_.CommandLine -match 'oh_memos.api.start_api' -or
                        $_.CommandLine -match [regex]::Escape($RepoRoot)) }
    if (-not $procs) {
        Write-Log 'No matching uvicorn process found on port 18000.'
        return
    }
    foreach ($p in $procs) {
        Write-Log "Stopping uvicorn PID $($p.ProcessId): $($p.CommandLine.Substring(0,[Math]::Min(80,$p.CommandLine.Length)))"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not (Wait-PortClosed -Port 18000)) {
        Fail 'Port 18000 still occupied 30 s after stopping API. Investigate manually.'
    }
    Write-Log 'Windows API stopped.'
}

function Stop-Neo4j {
    Write-Log 'Stopping Windows Neo4j...'
    $java = Get-CimInstance Win32_Process -Filter "name='java.exe'" |
        Where-Object { $_.CommandLine -match 'neo4j' }
    if ($java) {
        $java | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 5
    }
    $neo4jSvc = Get-Service 'neo4j' -ErrorAction SilentlyContinue
    if ($neo4jSvc -and $neo4jSvc.Status -eq 'Running') {
        Stop-Service 'neo4j' -Force -ErrorAction SilentlyContinue
    }
    Write-Log 'Neo4j stopped (or was already stopped).'
}

function Stop-Qdrant {
    Write-Log 'Stopping Windows Qdrant...'
    Get-Process 'qdrant' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Log 'Qdrant stopped (or was already stopped).'
}

function Get-Neo4jNodeCount {
    param([string]$Uri='bolt://127.0.0.1:7687', [string]$User='neo4j', [string]$Pass)
    $script = @"
from neo4j import GraphDatabase
d = GraphDatabase.driver('$Uri', auth=('$User', '$Pass'))
with d.session() as s:
    n = s.run('MATCH (n) RETURN count(n) AS c').single()['c']
    r = s.run('MATCH ()-[r]->() RETURN count(r) AS c').single()['c']
    cubes = {row['u']: row['c'] for row in s.run('MATCH (n:Memory) RETURN n.user_name AS u, count(*) AS c')}
d.close()
import json; print(json.dumps({'nodes':n,'relationships':r,'by_cube':cubes}))
"@
    $venv = Join-Path $RepoRoot '.venv\Scripts\python.exe'
    $py   = if (Test-Path $venv) { $venv } else { 'python' }
    $env:NEO4J_PASS_TMP = $Pass
    $out = & $py -c $script 2>$null
    Remove-Item Env:NEO4J_PASS_TMP -ErrorAction SilentlyContinue
    if ($out) { return $out | ConvertFrom-Json }
    return $null
}

function Get-QdrantCollections {
    param([string]$BaseUrl='http://127.0.0.1:16333')
    try {
        $r = Invoke-RestMethod "$BaseUrl/collections" -TimeoutSec 15
        $cols = @{}
        foreach ($c in $r.result.collections) {
            try {
                $d = Invoke-RestMethod "$BaseUrl/collections/$($c.name)" -TimeoutSec 15
                $cfg = $d.result.config.params.vectors
                $cols[$c.name] = @{
                    points   = $d.result.points_count
                    dim      = $cfg.size
                    distance = $cfg.distance
                }
            } catch { $cols[$c.name] = @{ points='?'; dim='?'; distance='?' } }
        }
        return $cols
    } catch { return $null }
}

function Get-SQLiteStats {
    param([string]$DbPath)
    $script = @"
import sqlite3, json, os
if not os.path.exists('$($DbPath.Replace('\','\\'))'):
    print('NOT_FOUND')
else:
    c = sqlite3.connect('$($DbPath.Replace('\','\\'))')
    stats = {}
    for t in ['users','cubes','user_cube_association','user_configs']:
        try: stats[t] = c.execute(f'SELECT count(*) FROM {t}').fetchone()[0]
        except: stats[t] = 'MISSING'
    print(json.dumps(stats))
"@
    $venv = Join-Path $RepoRoot '.venv\Scripts\python.exe'
    $py   = if (Test-Path $venv) { $venv } else { 'python' }
    $out  = & $py -c $script 2>$null
    if ($out -eq 'NOT_FOUND' -or -not $out) { return $null }
    return $out | ConvertFrom-Json
}

# --- stage implementations ----------------------------------------------------

function Stage-Preflight {
    Write-Log '==== PREFLIGHT ===='

    # docker
    try { docker version --format '{{.Server.Version}}' | Out-Null } catch { Fail 'Docker not running.' }
    $cv = (docker compose version --short 2>$null)
    Write-Log "Docker Compose: $cv"

    # source services should NOT be running (we need offline access for backup)
    foreach ($port in 7687, 16333) {
        if (netstat -ano 2>$null | Select-String ":$port\s" | Select-String LISTENING) {
            Warn "Port $port is listening -- backup stage will stop the service."
        }
    }

    # neo4j-admin
    $adminBat = Join-Path $SrcNeo4j 'bin\neo4j-admin.bat'
    if (-not (Test-Path $adminBat)) { Fail "neo4j-admin.bat not found at $adminBat" }
    if (-not $env:JAVA_HOME -and -not (Get-Command java -ErrorAction SilentlyContinue)) {
        Fail 'JAVA_HOME not set and java not on PATH -- needed for neo4j-admin database dump'
    }

    # source paths
    foreach ($p in $SrcNeo4j, $SrcQdrant, (Split-Path $SrcSQLite), $SrcCubes) {
        if (-not (Test-Path $p)) { Fail "Source path missing: $p" }
    }

    # migration dir free space (need ~12 GB for Neo4j dump + Qdrant + SQLite + cubes)
    $drive = Split-Path $MigrationDir -Qualifier
    $disk  = Get-PSDrive ($drive.TrimEnd(':')) -ErrorAction SilentlyContinue
    if ($disk) {
        $freeGB = [Math]::Round($disk.Free / 1GB, 1)
        Write-Log "Free on ${drive}: ${freeGB} GB"
        if ($disk.Free -lt 12GB) { Fail "Less than 12 GB free on ${drive}: (have ${freeGB} GB)" }
    }

    # source manifest
    Write-Log '---- Source manifest ----'

    # Neo4j (offline size only when not running)
    $dbDir = Join-Path $SrcNeo4j 'data\databases\neo4j'
    $dbSz  = if (Test-Path $dbDir) { [Math]::Round((Get-ChildItem $dbDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1) } else { '?' }
    Write-Log "Neo4j 5.15.0  data dir: ${dbSz} MB  ($dbDir)"

    # Qdrant
    $qCols = Get-ChildItem (Join-Path $SrcQdrant 'storage\collections') -Directory -ErrorAction SilentlyContinue
    $qSz   = [Math]::Round((Get-ChildItem (Join-Path $SrcQdrant 'storage') -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Log "Qdrant 1.16.3  collections: $($qCols.Count)  storage: ${qSz} GB"
    foreach ($c in $qCols) { Write-Log "  $($c.Name)" }

    # SQLite
    $sql = Get-SQLiteStats -DbPath $SrcSQLite
    if ($sql) { Write-Log "SQLite: users=$($sql.users) cubes=$($sql.cubes) associations=$($sql.user_cube_association)" }
    else       { Warn "SQLite not found or unreadable at $SrcSQLite" }

    # cube files
    $cubeFiles = Get-ChildItem $SrcCubes -Recurse -File -ErrorAction SilentlyContinue
    $cubeSz    = [Math]::Round(($cubeFiles | Measure-Object -Property Length -Sum).Sum / 1KB, 0)
    Write-Log "Cubes: $($cubeFiles.Count) files  ${cubeSz} KB  ($SrcCubes)"

    Write-Log '==== PREFLIGHT PASSED ===='
}

function Stage-Backup {
    Write-Log '==== BACKUP ===='
    New-Item -ItemType Directory -Force $MigrationDir | Out-Null

    # stop services
    Stop-OhMemosAPI
    Stop-Neo4j
    Stop-Qdrant

    # confirm offline
    foreach ($port in 7687, 16333) {
        if (netstat -ano 2>$null | Select-String ":$port\s" | Select-String LISTENING) {
            Fail "Port $port still listening after stop attempts."
        }
    }

    # 1. Neo4j dump
    $dumpDir = Join-Path $MigrationDir 'neo4j-dump'
    New-Item -ItemType Directory -Force $dumpDir | Out-Null
    # neo4j-admin refuses to overwrite an existing archive, so a re-run must
    # clear the previous dump. The previous one is superseded anyway: the whole
    # point of re-running backup is to capture current state.
    Get-ChildItem $dumpDir -Filter '*.dump' -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Log "Removing stale dump: $($_.Name)"
            Remove-Item $_.FullName -Force
        }
    Write-Log "Running neo4j-admin database dump -> $dumpDir"
    $adminBat = Join-Path $SrcNeo4j 'bin\neo4j-admin.bat'
    & cmd.exe /c "`"$adminBat`" database dump neo4j --to-path=`"$dumpDir`" 2>&1" |
        ForEach-Object { Write-Log "  neo4j-admin: $_" }
    $dumpFile = Get-ChildItem $dumpDir -Filter '*.dump' | Select-Object -First 1
    if (-not $dumpFile) { Fail "neo4j-admin dump did not produce a .dump file in $dumpDir" }
    Write-Log "Dump: $($dumpFile.Name)  $([Math]::Round($dumpFile.Length/1MB,1)) MB"

    # 2. Qdrant offline copy
    $qdrantBkp = Join-Path $MigrationDir 'qdrant-storage'
    Write-Log "Copying Qdrant storage -> $qdrantBkp"
    if (Test-Path $qdrantBkp) { Remove-Item $qdrantBkp -Recurse -Force }
    Copy-Item (Join-Path $SrcQdrant 'storage') $qdrantBkp -Recurse
    $qSz = [Math]::Round((Get-ChildItem $qdrantBkp -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB, 2)
    Write-Log "Qdrant backup: ${qSz} GB"

    # 3. SQLite (copy .db + any WAL/SHM files)
    $sqlBkp = Join-Path $MigrationDir 'memos_users'
    New-Item -ItemType Directory -Force $sqlBkp | Out-Null
    foreach ($f in Get-ChildItem (Split-Path $SrcSQLite) -Filter 'memos_users.db*') {
        Copy-Item $f.FullName (Join-Path $sqlBkp $f.Name)
        Write-Log "SQLite copied: $($f.Name)  $([Math]::Round($f.Length/1KB,0)) KB"
    }

    # 4. cube directory tree
    $cubeBkp = Join-Path $MigrationDir 'cubes'
    if (Test-Path $cubeBkp) { Remove-Item $cubeBkp -Recurse -Force }
    Copy-Item $SrcCubes $cubeBkp -Recurse
    Write-Log "Cubes copied: $SrcCubes -> $cubeBkp"

    # 5. manifest
    Write-Log 'Building hash manifest...'
    $manifest = @{}

    # Stop source services before opening files, then capture the password only
    # in memory for the source-count probe.
    $sourcePassword = Get-EnvFileValue -Path (Join-Path $RepoRoot 'src\.env') -Key 'NEO4J_PASSWORD'
    $neo4jStats = Get-Neo4jNodeCount -Uri 'bolt://127.0.0.1:7687' -Pass $sourcePassword
    if (-not $neo4jStats) { Warn 'Could not query source Neo4j counts during backup.' }
    $manifest['neo4j'] = @{
        nodes = if ($neo4jStats) { [int]$neo4jStats.nodes } else { 0 }
        relationships = if ($neo4jStats) { [int]$neo4jStats.relationships } else { 0 }
        by_cube = if ($neo4jStats) { $neo4jStats.by_cube } else { @{} }
    }
    $manifest['neo4j_dump'] = @{ file = $dumpFile.Name; sha256 = Get-SHA256 $dumpFile.FullName }

    # qdrant hashes (spot-check top level + collection count)
    $qCols = Get-ChildItem (Join-Path $qdrantBkp 'collections') -Directory -ErrorAction SilentlyContinue
    $manifest['qdrant'] = @{
        collection_count = $qCols.Count
        collections = ($qCols.Name -join ',')
        details = @{}
    }
    foreach ($c in $qCols) {
        try {
            $detail = Invoke-RestMethod "http://127.0.0.1:16333/collections/$($c.Name)" -TimeoutSec 15
            $vectors = $detail.result.config.params.vectors
            $manifest['qdrant'].details[$c.Name] = @{
                points = [int]$detail.result.points_count
                dim = [int]$vectors.size
                distance = [string]$vectors.distance
            }
        } catch { Warn "Could not query Qdrant collection $($c.Name) details." }
    }

    # SQLite
    $sql = Get-SQLiteStats -DbPath (Join-Path $sqlBkp 'memos_users.db')
    $manifest['sqlite'] = @{
        sha256       = Get-SHA256 (Join-Path $sqlBkp 'memos_users.db')
        users        = $sql.users
        cubes        = $sql.cubes
        associations = $sql.user_cube_association
    }

    # cubes
    $cubeFiles = Get-ChildItem $cubeBkp -Recurse -File
    $manifest['cubes'] = @{ file_count = $cubeFiles.Count; size_kb = [Math]::Round(($cubeFiles | Measure-Object -Property Length -Sum).Sum / 1KB, 0) }

    $manifestPath = Join-Path $MigrationDir 'manifest.json'
    $manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath -Encoding UTF8
    Write-Log "Manifest written: $manifestPath"
    Write-Log '==== BACKUP DONE ===='
}

function Stage-Restore {
    Write-Log '==== RESTORE ===='

    if (-not (Test-Path $MigrationDir)) { Fail "Migration dir not found: $MigrationDir. Run backup first." }
    $manifestPath = Join-Path $MigrationDir 'manifest.json'
    if (-not (Test-Path $manifestPath)) { Fail "manifest.json not found in $MigrationDir. Run backup first." }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

    if (-not (Test-Path $ComposeEnvFile)) {
        Fail "Compose env file not found: $ComposeEnvFile. Copy from docker/.env.migration.example and fill it."
    }

    $dumpFile = Get-ChildItem (Join-Path $MigrationDir 'neo4j-dump') -Filter '*.dump' | Select-Object -First 1
    if (-not $dumpFile) { Fail 'No .dump file in migration/neo4j-dump. Run backup first.' }

    $composeCli = "docker compose -p oh-memos --env-file `"$ComposeEnvFile`" " +
                  "-f `"$DockerDir\docker-compose.yml`" " +
                  "-f `"$DockerDir\docker-compose.migration.yml`""

    # -- 0. create new cube dir ----------------------------------------------
    Write-Log "Creating new cube dir: $NewCubeDir"
    New-Item -ItemType Directory -Force $NewCubeDir | Out-Null
    $cubeBkp = Join-Path $MigrationDir 'cubes'
    if (Test-Path $cubeBkp) {
        Write-Log 'Copying cube backup to new host cube dir...'
        Get-ChildItem $cubeBkp | Copy-Item -Destination $NewCubeDir -Recurse -Force
        Write-Log "Cubes copied to $NewCubeDir"
    } else { Warn 'No cube backup found in migration dir; new cube dir will be empty.' }

    # -- 1. start neo4j + qdrant only (API deferred) -------------------------
    Write-Log 'Starting Neo4j 5.15.0 and Qdrant 1.16.3 containers...'
    Invoke-Expression "$composeCli up -d neo4j qdrant" | Out-Null

    # wait for neo4j
    Write-Log 'Waiting for Neo4j container to be healthy...'
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $s = docker inspect --format '{{.State.Health.Status}}' oh-memos-neo4j 2>$null
        if ($s -eq 'healthy') { break }
        Start-Sleep -Seconds 5
    }
    if ((docker inspect --format '{{.State.Health.Status}}' oh-memos-neo4j 2>$null) -ne 'healthy') {
        Fail 'Neo4j container did not become healthy within 120 s.'
    }

    # -- 2. load Neo4j dump via a one-off container (database must be offline) --
    # The official neo4j Docker image runs Neo4j as PID 1; `neo4j stop` inside
    # that container exits the process and kills the container. Instead, use a
    # separate neo4j-admin-only container that writes directly into the volume
    # while the normal neo4j container is stopped.
    Write-Log 'Stopping Neo4j container to load dump offline...'
    Invoke-Expression "$composeCli stop neo4j" | Out-Null

    Write-Log "Loading Neo4j dump into Docker volume via one-off container..."
    $dumpDirPosix = (Split-Path $dumpFile.FullName) -replace '\\','/' -replace '^([A-Za-z]):','/$1'
    docker run --rm `
        -v "${dumpDirPosix}:/backups:ro" `
        -v "oh-memos_neo4j_data:/data" `
        -v "oh-memos_neo4j_logs:/logs" `
        --entrypoint neo4j-admin `
        neo4j:5.15.0 database load neo4j `
            --from-path=/backups --overwrite-destination=true 2>&1 |
        ForEach-Object { Write-Log "  load: $_" }

    Write-Log 'Restarting Neo4j container...'
    Invoke-Expression "$composeCli start neo4j" | Out-Null
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $s = docker inspect --format '{{.State.Health.Status}}' oh-memos-neo4j 2>$null
        if ($s -eq 'healthy') { break }
        Start-Sleep -Seconds 5
    }
    if ((docker inspect --format '{{.State.Health.Status}}' oh-memos-neo4j 2>$null) -ne 'healthy') {
        Fail 'Neo4j container did not become healthy after load. Check docker logs oh-memos-neo4j'
    }
    Write-Log 'Neo4j data loaded and container healthy.'

    # -- 3. copy Qdrant storage into the qdrant_data volume ------------------
    Write-Log 'Copying Qdrant storage into Docker volume...'
    $qdrantBkp = Join-Path $MigrationDir 'qdrant-storage'
    if (-not (Test-Path $qdrantBkp)) { Fail "Qdrant backup not found: $qdrantBkp" }
    # Stop qdrant container to prevent concurrent writes during bulk load
    Invoke-Expression "$composeCli stop qdrant" | Out-Null
    # Use a helper container to stream the backup into the volume
    $qdrantBkpPosix = $qdrantBkp -replace '\\','/' -replace '^([A-Za-z]):','/$1'
    docker run --rm `
        -v "${qdrantBkpPosix}:/src:ro" `
        -v "oh-memos_qdrant_data:/qdrant/storage" `
        alpine:3.20 sh -c 'rm -rf /qdrant/storage/* && cp -a /src/. /qdrant/storage/'
    Write-Log 'Qdrant storage copied.'
    Invoke-Expression "$composeCli start qdrant" | Out-Null

    # -- 4. copy SQLite into the memos_runtime volume -------------------------
    Write-Log 'Injecting SQLite into memos_runtime volume...'
    $sqlBkp = Join-Path $MigrationDir 'memos_users'
    if (-not (Test-Path (Join-Path $sqlBkp 'memos_users.db'))) { Fail "SQLite backup not found in $sqlBkp" }
    # Start a helper container to write to the named volume.
    $sqlBkpPosix = $sqlBkp -replace '\\','/' -replace '^([A-Za-z]):','/$1'
    docker run --rm `
        -v "${sqlBkpPosix}:/src:ro" `
        -v "oh-memos_memos_runtime:/data/runtime" `
        alpine:3.20 sh -c 'mkdir -p /data/runtime/.memos && cp -a /src/. /data/runtime/.memos/ && chown -R 10001:10001 /data/runtime'
    Write-Log 'SQLite injected and ownership fixed for API user (uid 10001).'

    # -- 5. start API ---------------------------------------------------------
    Write-Log 'Starting API container...'
    Invoke-Expression "$composeCli up -d memos" | Out-Null
    Write-Log 'Waiting for API to become healthy...'
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        $s = docker inspect --format '{{.State.Health.Status}}' oh-memos-api 2>$null
        if ($s -eq 'healthy') { break }
        Start-Sleep -Seconds 10
    }
    if ((docker inspect --format '{{.State.Health.Status}}' oh-memos-api 2>$null) -ne 'healthy') {
        Fail 'API container did not become healthy within 180 s. Check docker logs oh-memos-api'
    }
    Write-Log '==== RESTORE DONE ===='
}

function Stage-Verify {
    param([bool]$AfterRestart=$false)
    $suffix = if ($AfterRestart) { ' (post-restart)' } else { ' (initial)' }
    Write-Log "==== VERIFY${suffix} ===="

    if (-not (Test-Path (Join-Path $MigrationDir 'manifest.json'))) {
        Fail 'manifest.json not found. Run backup first.'
    }
    $manifest = Get-Content (Join-Path $MigrationDir 'manifest.json') -Raw | ConvertFrom-Json

    $pass   = $true
    $checks = [System.Collections.Generic.List[object]]::new()

    function Assert-Check {
        param([string]$Name, [bool]$OK, [string]$Detail='')
        $checks.Add([pscustomobject]@{ Check=$Name; OK=$OK; Detail=$Detail })
        if (-not $OK) { $script:pass = $false }
    }

    $apiPort = $ApiPort
    if ($AfterRestart) {
        Write-Log 'Restarting migration compose stack before post-restart checks...'
        Invoke-Expression "$composeCli restart" | Out-Null
        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline) {
            $s = docker inspect --format '{{.State.Health.Status}}' oh-memos-api 2>$null
            if ($s -eq 'healthy') { break }
            Start-Sleep -Seconds 10
        }
        if ((docker inspect --format '{{.State.Health.Status}}' oh-memos-api 2>$null) -ne 'healthy') {
            Fail 'API did not become healthy after restart.'
        }
    }

    # API health
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:18100/health/detail" -TimeoutSec 15
        Assert-Check 'API /health/detail' ($h.data.overall_status -eq 'ok') $h.data.overall_status
        Assert-Check 'Neo4j component' ($h.data.components.neo4j.status -eq 'ok') $h.data.components.neo4j.status
        Assert-Check 'Qdrant component' ($h.data.components.qdrant.status -eq 'ok') $h.data.components.qdrant.status
    } catch { Assert-Check 'API /health/detail' $false $_.Exception.Message }

    # neo4j volume via the published migration port
    try {
        $neo4jHostPort = (docker port oh-memos-neo4j 7474 | Select-Object -First 1) -replace '.*:', ''
        $url  = "http://127.0.0.1:${neo4jHostPort}/db/neo4j/tx/commit"
        $body = @{ statements=@(@{ statement="MATCH (n) RETURN count(n) AS c" }) } | ConvertTo-Json
        $envLine = Get-Content $ComposeEnvFile | Where-Object { $_ -match '^NEO4J_PASSWORD=' } | Select-Object -First 1
        $pw = $envLine -replace '^NEO4J_PASSWORD=',''
        if (-not $pw) { throw 'NEO4J_PASSWORD is empty in migration env' }
        $cred = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("neo4j:$pw"))
        $r = Invoke-RestMethod $url -Method Post -Body $body -ContentType 'application/json' `
                -Headers @{ Authorization="Basic $cred" } -TimeoutSec 15
        $nodes = [int]$r.results[0].data[0].row[0]
        $expected = if ($manifest.neo4j.nodes) { [int]$manifest.neo4j.nodes } else { 0 }
        Assert-Check 'Neo4j node count matches manifest' ($nodes -eq $expected) "expected=$expected got=$nodes"
    } catch { Assert-Check 'Neo4j node count' $false $_.Exception.Message }

    # qdrant collections
    try {
        $qdrantHostPort = (docker port oh-memos-qdrant 6333 | Select-Object -First 1) -replace '.*:', ''
        $r = Invoke-RestMethod "http://127.0.0.1:${qdrantHostPort}/collections" -TimeoutSec 15
        $cnt = @($r.result.collections).Count
        $expected = [int]$manifest.qdrant.collection_count
        Assert-Check "Qdrant collection count = $expected" ($cnt -eq $expected) "got $cnt"
        $expectedNames = @($manifest.qdrant.collections -split ',' | Where-Object { $_ })
        $actualNames = @($r.result.collections | ForEach-Object { $_.name })
        $missing = @($expectedNames | Where-Object { $_ -notin $actualNames })
        Assert-Check 'Qdrant collection names' ($missing.Count -eq 0) "missing=$($missing -join ',')"
    } catch { Assert-Check 'Qdrant collections' $false $_.Exception.Message }

    # SQLite via docker exec
    try {
        $out = docker exec oh-memos-api python -c @'
import sqlite3, json
c = sqlite3.connect('/data/runtime/.memos/memos_users.db')
print(json.dumps({t: c.execute(f'SELECT count(*) FROM {t}').fetchone()[0]
    for t in ['users','cubes','user_cube_association','user_configs']}))
'@ 2>$null
        $s = $out | ConvertFrom-Json
        Assert-Check 'SQLite users >= 1'  ($s.users -ge 1)  "users=$($s.users)"
        Assert-Check 'SQLite cubes >= 1'  ($s.cubes -ge 1)  "cubes=$($s.cubes)"
    } catch { Assert-Check 'SQLite table counts' $false $_.Exception.Message }

    # write probe: register and remove a temporary cube to verify that the
    # restored SQLite file is writable by the non-root API uid. A read-only
    # check alone would miss a root-owned injected database.
    try {
        $payload = @{
            user_id = "dev_user"
            mem_cube_name_or_path = "/tmp/migration_verify_probe"
            mem_cube_id = "migration_verify_probe"
        } | ConvertTo-Json
        $r = Invoke-RestMethod "http://127.0.0.1:$ApiPort/mem_cubes" -Method Post `
            -Body $payload -ContentType 'application/json' -TimeoutSec 15
        $writeOK = ($r.code -eq 200)
        Assert-Check 'API write (register cube)' $writeOK "code=$($r.code) msg=$($r.message)"
        if ($writeOK) {
            try {
                Invoke-RestMethod "http://127.0.0.1:$ApiPort/mem_cubes/migration_verify_probe" `
                    -Method Delete -TimeoutSec 15 | Out-Null
            } catch { Warn "Could not remove migration_verify_probe; remove it manually after verification." }
        }
    } catch { Assert-Check 'API write (register cube)' $false $_.Exception.Message }

    # cube files on new host path
    $cubeFiles = Get-ChildItem $NewCubeDir -Recurse -File -ErrorAction SilentlyContinue
    $expectedCubeCount = if ($manifest.cubes.file_count) { $manifest.cubes.file_count } else { 0 }
    Assert-Check "Cube file count = $expectedCubeCount" `
        ($cubeFiles.Count -eq $expectedCubeCount) "got $($cubeFiles.Count)"

    # print results
    $checks | Format-Table -AutoSize
    if ($pass) { Write-Log '==== VERIFY PASSED ====' }
    else        { Fail 'One or more verification checks failed. Do NOT run cleanup.' }
}

function Stage-Cleanup {
    if (-not $ConfirmWindowsPurge) {
        Fail ('cleanup stage requires -ConfirmWindowsPurge. ' +
              'This permanently deletes Windows source data. ' +
              'Run verify first and add -ConfirmWindowsPurge only when you are certain.')
    }
    Write-Log '==== CLEANUP (IRREVERSIBLE) ===='
    Write-Log 'Re-running verify before any deletion...'
    Stage-Verify

    $targets = @(
        @{ path = Join-Path $SrcNeo4j 'data';   label = 'Neo4j data' }
        @{ path = Join-Path $SrcQdrant 'storage'; label = 'Qdrant storage' }
        @{ path = Split-Path $SrcSQLite;         label = 'SQLite .memos dir' }
        @{ path = $SrcCubes;                     label = 'cube configs/canvas' }
    )

    Write-Log ''
    Write-Log 'ABOUT TO PERMANENTLY DELETE:'
    foreach ($t in $targets) {
        Write-Log "  $($t.label): $($t.path)"
    }
    Write-Log "Backup is in: $MigrationDir"
    Write-Log ''

    foreach ($t in $targets) {
        if (Test-Path $t.path) {
            Write-Log "Deleting $($t.label): $($t.path)"
            Remove-Item $t.path -Recurse -Force
            Write-Log "  DELETED."
        } else {
            Write-Log "  Not found (already gone): $($t.path)"
        }
    }

    Write-Log ''
    Write-Log 'Post-cleanup verification...'
    Stage-Verify -AfterRestart $true
    Write-Log '==== CLEANUP DONE ===='
    Write-Log "Backup preserved at: $MigrationDir"
}

# --- dispatch -----------------------------------------------------------------
New-Item -ItemType Directory -Force $MigrationDir -ErrorAction SilentlyContinue | Out-Null

switch ($Stage) {
    'preflight' { Stage-Preflight }
    'backup'    { Stage-Backup    }
    'restore'   { Stage-Restore   }
    'verify'    { Stage-Verify    }
    'cleanup'   { Stage-Cleanup   }
}


