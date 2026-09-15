# Vendor setup: oxc + tsgolint (+ nested typescript-go) as cyberluke forks, wired as git submodules.
# Idempotent, visible, bounded. No build/test/lint/typecheck is invoked.
param(
  [string]$OxcSrc = 'C:\git\oxc',
  [string]$TsgSrc = 'C:\git\tsgolint'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tsDir = Join-Path $TsgSrc 'typescript-go'

Write-Host '[vendor] start'
Write-Host "[vendor] workspace=$root"
Write-Host "[vendor] oxc=$OxcSrc tsgolint=$TsgSrc typescript-go=$tsDir"

function Append-Ignore([string]$file, [string[]]$rules) {
  $have = @()
  if (Test-Path -LiteralPath $file) { $have = @(Get-Content -LiteralPath $file) }
  $add = @($rules | Where-Object { $have -notcontains $_ })
  if ($add.Count) {
    Add-Content -LiteralPath $file -Value $add
    Write-Host "[vendor] ignore+$($file): $($add -join ', ')"
  } else {
    Write-Host "[vendor] ignore=$file ok"
  }
}

function Ensure-Repo([string]$name) {
  $info = (& gh repo view "cyberluke/$name" --json name 2>&1) -join ''
  if ($info -match '"name"') {
    Write-Host "[vendor] repo cyberluke/$name exists"
  } else {
    & gh api -X POST /user/repos -f name=$name | Out-Null
    Write-Host "[vendor] created repo cyberluke/$name"
  }
}

function Commit([string]$dir, [string]$message) {
  Push-Location $dir
  git config user.name 'cyberluke' | Out-Null
  git config user.email 'cyberluke@users.noreply.github.com' | Out-Null
  git config core.longpaths true | Out-Null
  & git reset --quiet
  & git add -A
  & git commit --quiet -m $message
  Write-Host "[vendor] commit $dir -> $((git rev-parse HEAD))"
  Pop-Location
}

function Push-Fork([string]$dir, [string]$name, [string]$upstream) {
  Push-Location $dir
  if ($upstream) {
    if (-not ((git remote) | Where-Object { $_ -eq 'upstream' })) { & git remote add upstream $upstream | Out-Null }
    if ((git rev-parse --is-shallow-repository) -eq 'true') {
      Write-Host "[vendor] $name shallow -> fetching full history"
      & git fetch --quiet --unshallow upstream
    }
  }
  Ensure-Repo $name
  & git remote set-url origin "https://github.com/cyberluke/$name.git"
  & git push --porcelain --follow-tags origin main | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Push-Branch (Get-Location).Path $name }
  Write-Host "[vendor] pushed $name -> $((git rev-parse HEAD))"
  Pop-Location
}

function Push-Branch([string]$dir, [string]$name) {
  Push-Location $dir
  $try = 0
  while ($true) {
    $try += 1
    & git push --porcelain origin main | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) { break }
    if ($try -ge 3) { throw "push $name failed after $try attempts" }
    Write-Host "[vendor] push $name attempt $try failed, retrying"
    Start-Sleep -Seconds 2
  }
  Write-Host "[vendor] pushed $name -> $((git rev-parse HEAD))"
  Pop-Location
}

# --- phase 1: ignore rules -------------------------------------------------------
Append-Ignore (Join-Path $OxcSrc '.gitignore') @('**/*.profraw', 'target*/')
Append-Ignore (Join-Path $TsgSrc '.gitignore') @('*.exe')

# --- phase 2: nested typescript-go on its own branch -----------------------------
Push-Location $tsDir
git config user.name 'cyberluke' | Out-Null
git config user.email 'cyberluke@users.noreply.github.com' | Out-Null
git config core.longpaths true | Out-Null
if ((git rev-parse --is-shallow-repository) -eq 'true') {
  & git fetch --quiet --unshallow https://github.com/microsoft/typescript-go
}
& git checkout -B main (git rev-parse HEAD) | Out-Null
Write-Host "[vendor] typescript-go head $((git rev-parse HEAD))"
Pop-Location

# --- phase 3: local commits -----------------------------------------------------
Commit $OxcSrc 'railgun: agent format, quiet default, daemon pipe, PGO body'
Commit $TsgSrc 'railgun: nested typescript-go fork, PGO corpus, shim module'

# --- phase 4: forks on github.com/cyberluke -------------------------------------
Push-Fork $OxcSrc 'oxc' 'https://github.com/oxc-project/oxc.git'
Push-Fork $TsgSrc 'tsgolint' 'https://github.com/oxc-project/tsgolint.git'
Push-Fork $tsDir 'typescript-go' $null

# tsgolint points its nested submodule at the cyberluke fork.
$tsgModules = Join-Path $TsgSrc '.gitmodules'
& git -C $TsgSrc config -f $tsgModules submodule.typescript-go.url https://github.com/cyberluke/typescript-go.git
Commit $TsgSrc 'chore: nested typescript-go via cyberluke fork' | Out-Null
Push-Branch $TsgSrc 'tsgolint'

# --- phase 5: submodules inside the workspace -----------------------------------
Push-Location $root
$modulesFile = Join-Path $root '.gitmodules'
foreach ($entry in @(
    @{ path = 'oxc'; url = 'https://github.com/cyberluke/oxc.git' },
    @{ path = 'tsgolint'; url = 'https://github.com/cyberluke/tsgolint.git' }
  )) {
  $dir = Join-Path $root $entry.path
  $stored = Join-Path $root ".git/modules/$($entry.path)"
  $pattern = "(?m)^\s*path\s*=\s*$([regex]::Escape($entry.path))\s*$"
  $registered = (Test-Path -LiteralPath $modulesFile) -and
    ((Get-Content -LiteralPath $modulesFile -Raw) -match $pattern)
  $staged = -not [string]::IsNullOrEmpty(((git ls-files -s -- $entry.path) -join ''))
  if (-not $registered) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    if (Test-Path -LiteralPath $stored) { Remove-Item -LiteralPath $stored -Recurse -Force }
    if ($staged) {
      Write-Host "[vendor] $($entry.path) staged in index -> populating"
      & git submodule update --init --recursive $entry.path
    } else {
      Write-Host "[vendor] adding submodule $($entry.path)"
      & git submodule add $entry.url $entry.path
    }
  } else {
    Write-Host "[vendor] submodule $($entry.path) registered"
    if (-not (Test-Path -LiteralPath $dir)) { & git submodule update --init --recursive $entry.path }
  }
}
& git submodule sync --recursive
foreach ($path in 'oxc', 'tsgolint') {
  $dir = Join-Path $root $path
  Push-Location $dir
  & git fetch --quiet origin
  $tip = (git rev-parse origin/main)
  & git checkout --quiet $tip
  Write-Host "[vendor] $path checked out $tip"
  Pop-Location
}
# stage the new gitlinks first so the recursive update uses them
& git add oxc tsgolint
# second sync: nested .gitmodules only carries the cyberluke url after the checkout above
& git submodule sync --recursive
& git submodule update --init --recursive
& git config core.longpaths true
foreach ($path in 'oxc', 'tsgolint') {
  Push-Location (Join-Path $root $path)
  & git config core.longpaths true
  & git -C typescript-go config core.longpaths true 2>$null
  & git -C typescript-go\_submodules\TypeScript config core.longpaths true 2>$null
  Pop-Location
}
Write-Host '[vendor] .gitmodules (workspace)'
Get-Content -LiteralPath $modulesFile | ForEach-Object { Write-Host "  $_" }
Write-Host '[vendor] .gitmodules (tsgolint)'
Get-Content -LiteralPath $tsgModules | ForEach-Object { Write-Host "  $_" }
Write-Host '[vendor] submodule status'
& git submodule status --recursive | ForEach-Object { Write-Host "  $_" }
& git status --short | ForEach-Object { Write-Host "  $_" }
Pop-Location
Write-Host '[vendor] complete'
