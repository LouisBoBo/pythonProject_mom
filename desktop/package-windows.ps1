$ErrorActionPreference = 'Stop'
$DesktopRoot = $PSScriptRoot
$RepoRoot = Split-Path -Parent $DesktopRoot
$BuildRoot = 'C:\dsh-src'

& (Join-Path $DesktopRoot 'prepare-windows.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

Push-Location $BuildRoot
try {
  & pnpm run package:desktop:win:x64:unsigned
  if ($LASTEXITCODE -ne 0) { throw "official package failed with exit $LASTEXITCODE" }
}
finally {
  Pop-Location
}

$artifactDir = Join-Path $BuildRoot 'apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts'
$installer = Get-ChildItem -LiteralPath $artifactDir -Filter 'zr-dsh-*-win-x64-unsigned.exe' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $installer) { throw "unsigned installer was not produced in $artifactDir" }

# The feed version comes from the artifact itself so the manifest can never
# advertise a version the installer does not carry.
$installerBase = [System.IO.Path]::GetFileNameWithoutExtension($installer.Name)
if ($installerBase -notmatch '^zr-dsh-(.+)-win-x64-unsigned$') {
  throw "cannot derive version from $($installer.Name)"
}
$version = $Matches[1]

$destDir = Join-Path $RepoRoot 'dist'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$dest = Join-Path $destDir $installer.Name
Copy-Item -LiteralPath $installer.FullName -Destination $dest -Force
Write-Output "installer: $dest"

& node (Join-Path $DesktopRoot 'update-feed.mjs') `
  --platform windows `
  --version $version `
  --artifact $dest `
  --out $destDir
if ($LASTEXITCODE -ne 0) { throw "update feed failed with exit $LASTEXITCODE" }
