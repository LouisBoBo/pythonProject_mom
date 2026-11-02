#!/usr/bin/env bash
# Unsigned macOS DMG. Mirrors desktop/package-windows.ps1:
# clone the pinned upstream tag, apply desktop/shell, run the official
# package:desktop:mac:*:unsigned command, and copy the DMG into dist/.
set -euo pipefail

DesktopRoot="$(cd "$(dirname "$0")" && pwd)"
RepoRoot="$(cd "$DesktopRoot/.." && pwd)"
BuildRoot="${DSH_BUILD_ROOT:-$HOME/dsh-src}"
export DSH_BUILD_ROOT="$BuildRoot"

PinFile="$DesktopRoot/upstream-pin.txt"
if [[ ! -f "$PinFile" ]]; then
  echo "missing $PinFile" >&2
  exit 1
fi

tag=""
commit=""
url=""
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line#$'\ufeff'}"
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    tag) tag="$value" ;;
    commit) commit="$value" ;;
    url) url="$value" ;;
  esac
done < "$PinFile"
if [[ -z "$tag" || -z "$commit" || -z "$url" ]]; then
  echo "upstream-pin.txt has no tag, commit, or url" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (^22.19.0 or >=24)." >&2
  exit 1
fi

node_version="$(node -v | sed 's/^v//')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
node_ok=0
if [[ "$node_major" -ge 24 ]]; then
  node_ok=1
elif [[ "$node_major" -eq 22 && "$node_minor" -ge 19 ]]; then
  node_ok=1
fi
if [[ "$node_ok" -ne 1 ]]; then
  echo "Node.js $(node -v) is too old. Install ^22.19.0 or >=24, then run this script again." >&2
  exit 1
fi
echo "node $(node -v)"

node "$RepoRoot/scripts/check-skill-sync.mjs"

if [[ ! -d "$BuildRoot/.git" ]]; then
  if [[ -e "$BuildRoot" ]]; then
    echo "$BuildRoot exists but is not a git checkout. Move that folder aside, then run this script again." >&2
    exit 1
  fi
  echo "cloning $tag into $BuildRoot"
  git clone --depth 1 --branch "$tag" "$url" "$BuildRoot"
fi

head="$(git -C "$BuildRoot" rev-parse HEAD)"
if [[ "$head" != "$commit" ]]; then
  echo "$BuildRoot HEAD is $head, expected $commit (tag $tag)." >&2
  exit 1
fi

printf '%s\n' "$RepoRoot" > "$BuildRoot/.dsh-mom-root"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export DSH_DESKTOP_NPM_REGISTRY="${DSH_DESKTOP_NPM_REGISTRY:-https://registry.npmmirror.com}"
export DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS="${DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS:-1800000}"

node "$DesktopRoot/shell/apps/desktop/scripts/apply-product-overlay.mjs"

if [[ ! -f "$BuildRoot/node_modules/.modules.yaml" ]]; then
  echo "installing desktop dependencies"
  corepack enable
  corepack prepare pnpm@11.28.5 --activate
  (
    cd "$BuildRoot"
    corepack pnpm install --frozen-lockfile \
      --registry "$DSH_DESKTOP_NPM_REGISTRY" \
      --fetch-timeout 300000 \
      --fetch-retries 5 \
      --network-concurrency 16
  )
fi

# 公司插件（@zhongruan/*）一律由插件市场装进 profile，不随应用打包。
# 安装目录里的旧副本会先于 profile 被解析，导致市场把已是最新的插件永远显示为“可更新”。
# 这里只打上游桌面端；插件依赖由 profile 自己的 .npmrc + pnpm 负责。

case "$(uname -m)" in
  x86_64) script_target="mac:x64"; artifact_target="mac-x64" ;;
  arm64) script_target="mac:arm64"; artifact_target="mac-arm64" ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

python3 "$DesktopRoot/prefetch-macos-runtime.py" "$BuildRoot" "$artifact_target"

(
  cd "$BuildRoot"
  corepack pnpm run "package:desktop:${script_target}:unsigned"
)

artifact_dir="$BuildRoot/apps/desktop/.desktop-build/targets/${artifact_target}/unsigned-artifacts"
dmg="$(find "$artifact_dir" -maxdepth 1 -type f -name 'zr-dsh-*-unsigned.dmg' | sort | tail -n 1)"
if [[ -z "$dmg" ]]; then
  echo "unsigned DMG was not produced in $artifact_dir" >&2
  exit 1
fi

# The DMG is for manual installs; the ZIP is what the in-app updater downloads.
# Derive the published version from the artifact name so the feed can never claim
# a version the installer does not carry.
dmg_base="$(basename "$dmg" .dmg)"
version="${dmg_base#zr-dsh-}"
version="${version%-${artifact_target}-unsigned}"
if [[ "zr-dsh-${version}-${artifact_target}-unsigned" != "$dmg_base" ]]; then
  echo "cannot derive version from $dmg_base" >&2
  exit 1
fi

app="$(find "$artifact_dir" -maxdepth 3 -type d -name '*.app' -exec ls -td {} + 2>/dev/null | head -n 1)"
if [[ -z "$app" ]]; then
  echo "unsigned .app bundle was not produced in $artifact_dir" >&2
  exit 1
fi

mkdir -p "$RepoRoot/dist"
cp -f "$dmg" "$RepoRoot/dist/"
echo "installer: $RepoRoot/dist/$(basename "$dmg")"

zip="$RepoRoot/dist/$dmg_base.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
echo "update package: $zip"

node "$DesktopRoot/update-feed.mjs" \
  --platform macos \
  --version "$version" \
  --artifact "$zip" \
  --out "$RepoRoot/dist"
