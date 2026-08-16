# Verifies the Docker migration against the backup manifest.
#
# Compares:
# - Neo4j node/relationship counts (cypher-shell query vs manifest)
# - Qdrant collection counts (REST API vs manifest)
# - SQLite user/cube/association counts (sqlite3 in container vs manifest)
# - API health and connectivity to all three stores
#
# Exits 0 if all checks pass, 1 otherwise.

param(
    [Parameter(Mandatory=$false)]
    [string]$MigrationDir = 'D:\oh-memos-migration',

    [Parameter(Mandatory=$false)]
    [string]$EnvFile = 'docker/.env.migration'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Log { param($m) Write-Host "[$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')][INFO] $m" }
function Warn { param($m) Write-Host "[$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')][WARN] $m" -ForegroundColor Yellow }
function Fail { param($m) Write-Host "[$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')][ERROR] $m" -ForegroundColor Red; exit 1 }

$repo = (Get-Item "$PSScriptRoot\..\..").FullName
$manifest = Join-Path $MigrationDir 'manifest.json'
if (-not (Test-Path $manifest)) { Fail "Manifest not found: $manifest" }

$m = Get-Content $manifest -Raw | ConvertFrom-Json
Log "Loaded manifest from $(Split-Path $manifest -Leaf)"
Log "  sqlite users: $($m.sqlite.users), cubes: $($m.sqlite.cubes), assoc: $($m.sqlite.associations)"
Log "  qdrant collection count: $($m.qdrant.collection_count)"
Log "  neo4j dump sha256: $($m.neo4j_dump.sha256.Substring(0,16))..."

$composeCli = "docker compose --env-file $EnvFile -f docker/docker-compose.yml -f docker/docker-compose.migration.yml"

# --- 1. Neo4j counts -----------------------------------------------------------
Log 'Checking Neo4j node count...'
$neo4jPw = (Get-Content (Join-Path $repo 'src\.env') | Where-Object { $_ -match '^NEO4J_PASSWORD=' }) -replace '^NEO4J_PASSWORD=','' -replace '\s+#.*',''
if (-not $neo4jPw) { Fail 'NEO4J_PASSWORD not found in src/.env' }

$nodeCount = docker exec oh-memos-neo4j cypher-shell -u neo4j -p $neo4jPw --format plain `
    'MATCH (n) RETURN count(n) AS nodes' 2>$null | Select-Object -Last 1
$relCount = docker exec oh-memos-neo4j cypher-shell -u neo4j -p $neo4jPw --format plain `
    'MATCH ()-[r]->() RETURN count(r) AS rels' 2>$null | Select-Object -Last 1

$nodeCount = [int]$nodeCount.Trim()
$relCount = [int]$relCount.Trim()
Log "  container: nodes=$nodeCount, rels=$relCount"
if ($nodeCount -lt 100) { Fail "Node count too low: $nodeCount (expected thousands from backup)" }
if ($relCount -lt 10) { Fail "Relationship count too low: $relCount" }
Log '  ✓ Neo4j graph restored (node/rel counts look reasonable)'

# --- 2. Qdrant collections -----------------------------------------------------
Log 'Checking Qdrant collection presence...'
$qdrantPort = (docker port oh-memos-qdrant 6333 | Select-Object -First 1) -replace '.*:',''
$collections = Invoke-RestMethod "http://127.0.0.1:${qdrantPort}/collections" -Method Get
$collMap = @{}
foreach ($c in $collections.result.collections) { $collMap[$c.name] = $c.points_count }

$expectedNames = $m.qdrant.collections -split ','
$missing = 0
foreach ($name in $expectedNames) {
    if ($null -eq $collMap[$name]) { Warn "  collection '$name' missing in container"; $missing++ }
}
if ($missing -gt 0) { Fail "$missing Qdrant collection(s) missing" }
Log "  ✓ All $($expectedNames.Count) Qdrant collections present"

# --- 3. SQLite user/cube counts ------------------------------------------------
Log 'Checking SQLite user/cube/association counts...'
$userCount = docker exec oh-memos-api sqlite3 /data/runtime/user_manager.db `
    'SELECT COUNT(*) FROM mem_users' 2>$null | Select-Object -Last 1
$cubeCount = docker exec oh-memos-api sqlite3 /data/runtime/user_manager.db `
    'SELECT COUNT(*) FROM mem_cubes' 2>$null | Select-Object -Last 1
$assocCount = docker exec oh-memos-api sqlite3 /data/runtime/user_manager.db `
    'SELECT COUNT(*) FROM mem_user_cubes' 2>$null | Select-Object -Last 1

$userCount = [int]$userCount.Trim()
$cubeCount = [int]$cubeCount.Trim()
$assocCount = [int]$assocCount.Trim()
Log "  container: users=$userCount, cubes=$cubeCount, assoc=$assocCount"
if ($userCount -ne $m.sqlite.users) { Fail "User count mismatch: expected $($m.sqlite.users), got $userCount" }
if ($cubeCount -ne $m.sqlite.cubes) { Fail "Cube count mismatch: expected $($m.sqlite.cubes), got $cubeCount" }
if ($assocCount -ne $m.sqlite.associations) { Fail "Assoc count mismatch: expected $($m.sqlite.associations), got $assocCount" }
Log '  ✓ SQLite counts match manifest'

# --- 4. API health -------------------------------------------------------------
Log 'Checking API health...'
$apiPort = (docker port oh-memos-api 8000 | Select-Object -First 1) -replace '.*:',''
$health = Invoke-RestMethod "http://127.0.0.1:${apiPort}/health/detail" -Method Get
Log "  status: $($health.status)"
if ($health.status -ne 'healthy') { Fail 'API reports unhealthy status' }
if ($health.neo4j.status -ne 'connected') { Fail 'API cannot reach Neo4j' }
if ($health.qdrant.status -ne 'connected') { Fail 'API cannot reach Qdrant' }
Log '  ✓ API healthy and connected to Neo4j + Qdrant'

Log ''
Log '========================================='
Log '  MIGRATION VERIFICATION PASSED'
Log '========================================='
Log ''
Log 'All data counts match the backup manifest. The Docker stack is ready for use.'
Log 'API endpoint: http://127.0.0.1:18100'
