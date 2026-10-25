$ErrorActionPreference = 'Stop'
$DesktopRoot = $PSScriptRoot
$PinPath = Join-Path $DesktopRoot 'upstream-pin.txt'
$EnvFile = Join-Path $DesktopRoot 'windows.env'
$BuildRoot = 'C:\dsh-src'

if (-not (Test-Path -LiteralPath $PinPath)) { throw "missing $PinPath" }
$pin = @{}
foreach ($line in (Get-Content -LiteralPath $PinPath -Encoding UTF8)) {
  $pair = $line.Split('=', 2)
  if ($pair.Count -eq 2) { $pin[$pair[0].Trim()] = $pair[1].Trim() }
}
foreach ($name in @('tag', 'commit', 'url')) {
  if (-not $pin[$name]) { throw "upstream-pin.txt has no $name" }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'git is required. Install Git for Windows, then run this script again.'
}

$RepoRoot = Split-Path -Parent $DesktopRoot
$gitDir = Join-Path $BuildRoot '.git'
if (-not (Test-Path -LiteralPath $gitDir)) {
  if (Test-Path -LiteralPath $BuildRoot) {
    throw 'C:\dsh-src exists but is not a git checkout. Move that folder aside, then run this script again.'
  }
  Write-Output "cloning $($pin['tag']) into $BuildRoot"
  & git clone --depth 1 --branch $pin['tag'] $pin['url'] $BuildRoot
  if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit $LASTEXITCODE" }
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $BuildRoot '.dsh-mom-root'), "$RepoRoot`n", $utf8)

& (Join-Path $DesktopRoot 'shell-sync.ps1') -Mode apply
if ($LASTEXITCODE -ne 0) { throw "shell sync failed with exit $LASTEXITCODE" }

$envDest = Join-Path $BuildRoot 'apps\desktop\.env.windows'
if (-not (Test-Path -LiteralPath $envDest)) {
  Copy-Item -LiteralPath $EnvFile -Destination $envDest
  Write-Output "wrote $envDest"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw 'Node.js is required (^22.19.0 or >=24). Install it, then run this script again.'
}
Write-Output "node $(node -v)"

$modules = Join-Path $BuildRoot 'node_modules'
if (-not (Test-Path -LiteralPath $modules)) {
  Write-Output 'installing desktop dependencies'
  & corepack enable
  if ($LASTEXITCODE -ne 0) { throw "corepack enable failed with exit $LASTEXITCODE" }
  & corepack prepare pnpm@11.28.5 --activate
  if ($LASTEXITCODE -ne 0) { throw "corepack prepare failed with exit $LASTEXITCODE" }
  Push-Location $BuildRoot
  try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit $LASTEXITCODE" }
  }
  finally { Pop-Location }
}

Write-Output 'overlay applied'
