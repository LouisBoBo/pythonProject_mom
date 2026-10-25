param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('apply', 'capture')]
  [string] $Mode
)

$ErrorActionPreference = 'Stop'
$DesktopRoot = $PSScriptRoot
$Overlay = Join-Path $DesktopRoot 'shell'
$ManifestPath = Join-Path $DesktopRoot 'shell-manifest.txt'
$PinPath = Join-Path $DesktopRoot 'upstream-pin.txt'
$BuildRoot = 'C:\dsh-src'

if (-not (Test-Path -LiteralPath $PinPath)) { throw "missing $PinPath" }
$pin = @{}
foreach ($line in (Get-Content -LiteralPath $PinPath -Encoding UTF8)) {
  $pair = $line.Split('=', 2)
  if ($pair.Count -eq 2) { $pin[$pair[0].Trim()] = $pair[1].Trim() }
}
$ExpectedCommit = $pin['commit']
if (-not $ExpectedCommit) { throw 'upstream-pin.txt has no commit' }

if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "missing $ManifestPath" }
$paths = @(Get-Content -LiteralPath $ManifestPath -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($paths.Count -eq 0) { throw 'shell-manifest.txt is empty' }

$gitDir = Join-Path $BuildRoot '.git'
if (-not (Test-Path -LiteralPath $gitDir)) {
  throw 'C:\dsh-src is missing. Clone tag dsh-v0.2.1-rc.2 there, then run apply again.'
}

$head = (git -C $BuildRoot rev-parse HEAD).Trim()
if ($head -ne $ExpectedCommit) {
  throw "C:\dsh-src HEAD is $head, expected $ExpectedCommit (tag dsh-v0.2.1-rc.2)."
}

foreach ($relative in $paths) {
  $normalized = $relative.Replace('\', '/')
  if ($normalized.StartsWith('/') -or $normalized.Contains('../') -or $normalized.Contains(':')) {
    throw "illegal manifest path: $relative"
  }
  $overlayFile = Join-Path $Overlay ($normalized.Replace('/', '\'))
  $buildFile = Join-Path $BuildRoot ($normalized.Replace('/', '\'))
  if ($Mode -eq 'apply') {
    $source = $overlayFile
    $target = $buildFile
  }
  else {
    $source = $buildFile
    $target = $overlayFile
  }
  if (-not (Test-Path -LiteralPath $source)) { throw "missing $source" }
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $target -Force
}

Write-Output "$Mode ok, $($paths.Count) files. Source of truth: $Overlay"
