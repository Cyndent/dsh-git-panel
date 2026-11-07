# Move the desktop profile from the C: pnpm store to the D: pnpm store.
#
# What it does:
#   1. backs up package.json / pnpm-lock.yaml / .modules.yaml
#   2. renames node_modules to node_modules.bak-store-move-<timestamp>
#   3. writes profile .npmrc with store-dir=D:\.pnpm-store\v11
#   4. runs the bundled pnpm install --frozen-lockfile
#   5. verifies .modules.yaml points at D:
#   6. rolls back automatically if install or verification fails
#
# Close the DSH desktop app first. The script refuses to run while the
# profile's node_modules cannot be renamed.
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File .\scripts\migrate-store-to-d.ps1 -DryRun
#   pwsh -ExecutionPolicy Bypass -File .\scripts\migrate-store-to-d.ps1

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProfileDir = 'D:\GodotProject\TOOLS\.dsh\profiles\desktop',
  [string]$StoreDir = 'D:\.pnpm-store\v11',
  [string]$NodePath = 'D:\GodotProject\TOOLS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe',
  [string]$PnpmPath = 'D:\GodotProject\TOOLS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "[store-move] $Message" }
function Fail([string]$Message) { throw "[store-move] $Message" }

function Read-JsonFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return $text | ConvertFrom-Json
}

function Write-TextFile([string]$Path, [string[]]$Lines) {
  [System.IO.File]::WriteAllLines($Path, $Lines, [System.Text.UTF8Encoding]::new($false))
}

function Set-NpmrcStore([string]$Path, [string]$Store) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
  }
  $out = New-Object System.Collections.Generic.List[string]
  $sawStore = $false
  $sawImport = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*store-dir\s*=') {
      $out.Add("store-dir=$Store")
      $sawStore = $true
    } elseif ($line -match '^\s*package-import-method\s*=') {
      $out.Add('package-import-method=hardlink')
      $sawImport = $true
    } else {
      $out.Add($line)
    }
  }
  if (-not $sawStore) { $out.Add("store-dir=$Store") }
  if (-not $sawImport) { $out.Add('package-import-method=hardlink') }
  Write-TextFile $Path $out.ToArray()
}

function Get-ModulesStore([string]$Path) {
  $modules = Read-JsonFile $Path
  return [pscustomobject]@{
    storeDir = [string]$modules.storeDir
    virtualStoreDir = [string]$modules.virtualStoreDir
  }
}

$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$StoreDir = [System.IO.Path]::GetFullPath($StoreDir)
$pkgPath = Join-Path $ProfileDir 'package.json'
$lockPath = Join-Path $ProfileDir 'pnpm-lock.yaml'
$npmrcPath = Join-Path $ProfileDir '.npmrc'
$nodeModules = Join-Path $ProfileDir 'node_modules'
$modulesPath = Join-Path $nodeModules '.modules.yaml'

if (-not (Test-Path -LiteralPath $pkgPath)) { Fail "missing profile package.json: $pkgPath" }
if (-not (Test-Path -LiteralPath $nodeModules)) { Fail "missing node_modules: $nodeModules" }
if (-not (Test-Path -LiteralPath $StoreDir)) { Fail "D store does not exist: $StoreDir" }
if (-not (Test-Path -LiteralPath $modulesPath)) { Fail "missing .modules.yaml: $modulesPath" }
if (-not (Test-Path -LiteralPath $NodePath)) { Fail "missing node: $NodePath" }
if (-not (Test-Path -LiteralPath $PnpmPath)) { Fail "missing pnpm: $PnpmPath" }

$before = Get-ModulesStore $modulesPath
$stamp = Get-Date -Format yyyyMMddHHmmss
$backupDir = Join-Path $ProfileDir "store-move-backup-$stamp"
$nodeModulesBackup = Join-Path $ProfileDir "node_modules.bak-store-move-$stamp"

Write-Step "profile: $ProfileDir"
Write-Step "old storeDir: $($before.storeDir)"
Write-Step "old virtualStoreDir: $($before.virtualStoreDir)"
Write-Step "new storeDir: $StoreDir"
Write-Step "node_modules backup: $nodeModulesBackup"

if ($DryRun) {
  Write-Step 'DRY RUN: would back up package.json / lockfile / .modules.yaml'
  Write-Step "DRY RUN: would rename node_modules -> $nodeModulesBackup"
  Write-Step "DRY RUN: would write $npmrcPath (store-dir=$StoreDir, package-import-method=hardlink)"
  Write-Step "DRY RUN: would run: node $PnpmPath install --dir $ProfileDir --frozen-lockfile"
  Write-Step 'DRY RUN: no files changed'
  return
}

# 1. Backup manifests and metadata.
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $pkgPath -Destination (Join-Path $backupDir 'package.json')
if (Test-Path -LiteralPath $lockPath) { Copy-Item -LiteralPath $lockPath -Destination (Join-Path $backupDir 'pnpm-lock.yaml') }
Copy-Item -LiteralPath $modulesPath -Destination (Join-Path $backupDir '.modules.yaml')
$npmrcBackup = $null
if (Test-Path -LiteralPath $npmrcPath) {
  $npmrcBackup = Join-Path $backupDir '.npmrc'
  Copy-Item -LiteralPath $npmrcPath -Destination $npmrcBackup
}
Write-Step "backup written: $backupDir"

# 2. Rename node_modules. A running DSH will make this fail.
try {
  Rename-Item -LiteralPath $nodeModules -NewName (Split-Path -Leaf $nodeModulesBackup)
} catch {
  Fail "could not rename node_modules (close DSH first): $($_.Exception.Message)"
}
Write-Step 'node_modules renamed'

$rolledBack = $false
function Rollback {
  if ($script:rolledBack) { return }
  $script:rolledBack = $true
  Write-Step 'ROLLBACK: restoring node_modules and manifests'
  if (Test-Path -LiteralPath $nodeModules) {
    Remove-Item -LiteralPath $nodeModules -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $nodeModulesBackup) {
    Rename-Item -LiteralPath $nodeModulesBackup -NewName 'node_modules' -ErrorAction SilentlyContinue
  }
  Copy-Item -LiteralPath (Join-Path $backupDir 'package.json') -Destination $pkgPath -Force
  if (Test-Path -LiteralPath (Join-Path $backupDir 'pnpm-lock.yaml')) {
    Copy-Item -LiteralPath (Join-Path $backupDir 'pnpm-lock.yaml') -Destination $lockPath -Force
  }
  if ($null -ne $npmrcBackup) {
    Copy-Item -LiteralPath $npmrcBackup -Destination $npmrcPath -Force
  } elseif (Test-Path -LiteralPath $npmrcPath) {
    Remove-Item -LiteralPath $npmrcPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  # 3. Point pnpm at the D store.
  Set-NpmrcStore $npmrcPath $StoreDir
  Write-Step "wrote $npmrcPath"

  # 4. Fresh install from the D store; fetch only what is missing.
  Write-Step 'running pnpm install --frozen-lockfile'
  & $NodePath $PnpmPath install --dir $ProfileDir --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed with exit code $LASTEXITCODE"
  }

  # 5. Verify.
  $after = Get-ModulesStore (Join-Path $ProfileDir 'node_modules\.modules.yaml')
  Write-Step "new storeDir: $($after.storeDir)"
  Write-Step "new virtualStoreDir: $($after.virtualStoreDir)"
  if ([string]::IsNullOrWhiteSpace($after.storeDir) -or -not $after.storeDir.Equals($StoreDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "verification failed: storeDir is still $($after.storeDir)"
  }
  if ([string]::IsNullOrWhiteSpace($after.virtualStoreDir) -or -not $after.virtualStoreDir.StartsWith($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "verification failed: virtualStoreDir is $($after.virtualStoreDir)"
  }
  foreach ($pkg in @('dsh-game-material-master', 'dsh-whale-widget')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir "node_modules\$pkg\package.json"))) {
      throw "verification failed: missing node_modules\$pkg"
    }
  }
} catch {
  Write-Step "FAILED: $($_.Exception.Message)"
  Rollback
  Fail "store move failed; original node_modules restored. Backup kept at $backupDir"
}

Write-Step 'SUCCESS: profile now uses the D store.'
Write-Step "Backup kept at: $backupDir"
Write-Step "Old node_modules kept at: $nodeModulesBackup"
Write-Step 'Next: start DSH once to verify existing plugins, then install dsh-git-panel.'
