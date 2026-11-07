# Install dsh-git-panel into a DSH desktop profile.
#
# The profile lives on D:, while its pnpm store metadata points at C:.
# "manual" mode avoids pnpm entirely: it creates a junction in the profile's
# node_modules and records the bundle in package.json.
#
# Run from an elevated/normal PowerShell with access to the profile:
#   pwsh -File .\scripts\install-profile.ps1 -Mode manual
#
# Use -DryRun first to see what would change.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProfileDir = 'D:\GodotProject\TOOLS\.dsh\profiles\desktop',
  [string]$PluginDir = '',
  [ValidateSet('auto', 'manual', 'pnpm')]
  [string]$Mode = 'auto',
  [string]$ProfileName = 'desktop',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PluginDir)) {
  $scriptDir = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { Split-Path -Parent $PSCommandPath } else { $PSScriptRoot }
  $PluginDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
}

function Read-JsonFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return $text | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Write-Step([string]$Message) {
  Write-Host "[dsh-git-panel] $Message"
}

$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
$pkgPath = Join-Path $ProfileDir 'package.json'
$pluginPkgPath = Join-Path $PluginDir 'package.json'

if (-not (Test-Path -LiteralPath $pkgPath)) { throw "Profile package.json not found: $pkgPath" }
if (-not (Test-Path -LiteralPath $pluginPkgPath)) { throw "Plugin package.json not found: $pluginPkgPath" }

$profilePkg = Read-JsonFile $pkgPath
$pluginPkg = Read-JsonFile $pluginPkgPath
if ($pluginPkg.name -ne 'dsh-git-panel') {
  throw "Unexpected plugin package name: $($pluginPkg.name)"
}
if ($null -eq $pluginPkg.dsh -or $null -eq $pluginPkg.dsh.bundle) {
  throw 'Plugin package does not declare dsh.bundle; it cannot be activated as a bundle.'
}

if ($Mode -eq 'auto') {
  $dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
  $Mode = if ($null -ne $dshCommand) { 'pnpm' } else { 'manual' }
  Write-Step "auto mode selected: $Mode"
}

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($Mode -eq 'pnpm' -and $null -eq $dsh) {
  throw 'dsh CLI was not found in PATH. Use -Mode manual, or install through the DSH plugin manager UI.'
}

$npmrcPath = Join-Path $ProfileDir '.npmrc'
$storeDir = 'C:\Users\cynde\AppData\Local\pnpm\store\v11'
if ($Mode -eq 'pnpm') {
  Write-Step "profile: $ProfileDir"
  Write-Step "plugin:  $PluginDir"
  Write-Step "pnpm store-dir: $storeDir (copy import; profile is on D:)"
  if (-not $DryRun) {
    $lines = @()
    if (Test-Path -LiteralPath $npmrcPath) {
      $lines = @(Get-Content -LiteralPath $npmrcPath -Encoding UTF8)
    }
    if (-not ($lines -match '^store-dir\s*=')) { $lines += "store-dir=$storeDir" }
    if (-not ($lines -match '^package-import-method\s*=')) { $lines += 'package-import-method=copy' }
    [System.IO.File]::WriteAllLines($npmrcPath, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Step 'running: dsh plugin add'
    & $dsh.Source plugin --profile $ProfileName add $PluginDir
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }
  } else {
    Write-Step "DRY RUN: would write $npmrcPath"
    Write-Step "DRY RUN: would run dsh plugin --profile $ProfileName add $PluginDir"
  }
} else {
  Write-Step "manual link mode: $ProfileDir"
  $linkPath = Join-Path $ProfileDir 'node_modules\dsh-git-panel'
  $bundles = @($profilePkg.dsh.profile.bundles)
  $dependency = 'link:D:/Git/DSH-plugin/dsh-git-panel'
  Write-Step "junction: $linkPath -> $PluginDir"
  Write-Step "dependency: dsh-git-panel = $dependency"
  Write-Step "bundle list contains dsh-git-panel: $($bundles -contains 'dsh-git-panel')"
  if ($DryRun) {
    Write-Step 'DRY RUN: no profile files changed'
    return
  }

  $backup = "$pkgPath.bak-git-panel-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item -LiteralPath $pkgPath -Destination $backup
  Write-Step "backup: $backup"

  if ($null -eq $profilePkg.dependencies) {
    $profilePkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
  }
  $profilePkg.dependencies | Add-Member -NotePropertyName 'dsh-git-panel' -NotePropertyValue $dependency -Force
  if ($bundles -notcontains 'dsh-git-panel') {
    $profilePkg.dsh.profile.bundles = @($bundles + 'dsh-git-panel')
  }
  Write-JsonFile $pkgPath $profilePkg

  $linkParent = Split-Path -Parent $linkPath
  if (-not (Test-Path -LiteralPath $linkParent)) {
    New-Item -ItemType Directory -Path $linkParent -Force | Out-Null
  }
  if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $targets = @($item.Target)
    if ($item.LinkType -ne 'Junction' -or -not ($targets -contains $PluginDir)) {
      throw "Existing path is not the expected junction: $linkPath"
    }
    Write-Step 'junction already exists'
  } else {
    New-Item -ItemType Junction -Path $linkPath -Target $PluginDir | Out-Null
    Write-Step 'junction created'
  }
}

Write-Step 'Done. Restart the DSH host process, then refresh the browser page.'
