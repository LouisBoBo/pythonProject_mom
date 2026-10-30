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

# --- 额外依赖：对话写码插件 + Cursor SDK ---
# pnpm install --frozen-lockfile 只装上游仓库原始依赖树；
# 下面两个包需要从公司 registry 拉，且不在上游 lockfile 里。
# 这里在 frozen-lockfile 之后追加安装，保持 BuildRoot 原始 lockfile 不变。
# 注意: Cursor SDK native binding 命名用 x64/arm64，和 uname -m 的 x86_64/arm64 不同。
DshPluginRegistry="${DSH_PLUGIN_REGISTRY:-http://175.178.238.31/dsh-plugins/npm/}"
DshNpmRegistry="${DSH_DESKTOP_NPM_REGISTRY:-https://registry.npmmirror.com}"
CursorSdkVer="1.0.31"
CursorPluginVer="0.1.8"
case "$(uname -m)" in
  x86_64) CursorArch="x64" ;;
  arm64)  CursorArch="arm64" ;;
  *)      CursorArch="$(uname -m)" ;;
esac
CursorNative="@cursor/sdk-darwin-$CursorArch"

needs_extra_install=0
if [[ ! -d "$BuildRoot/node_modules/@zhongruan/dsh-cursor-chat" ]]; then
  needs_extra_install=1
fi
if [[ ! -d "$BuildRoot/node_modules/@cursor/sdk" ]]; then
  needs_extra_install=1
fi
if [[ ! -d "$BuildRoot/node_modules/$CursorNative" ]]; then
  needs_extra_install=1
fi

if [[ "$needs_extra_install" -eq 1 ]]; then
  echo "installing extra dependencies: dsh-cursor-chat + cursor-sdk (native: $CursorNative)"
  # scope-based .npmrc: @zhongruan 从公司 registry，其余从镜像
  cat > "$BuildRoot/.npmrc" <<EOF
@zhongruan:registry=$DshPluginRegistry
@cursor:registry=$DshNpmRegistry
registry=$DshNpmRegistry
fetch-timeout=120000
fetch-retries=3
network-concurrency=4
EOF
  (
    cd "$BuildRoot"
    corepack pnpm add -Dw \
      "@zhongruan/dsh-cursor-chat@$CursorPluginVer" \
      "@cursor/sdk@$CursorSdkVer" \
      "$CursorNative@$CursorSdkVer" \
      --fetch-timeout 120000 --fetch-retries 3 --network-concurrency 4
  )
  if [[ $? -ne 0 ]]; then
    echo "failed to install cursor-chat plugin dependencies" >&2
    exit 1
  fi
fi

case "$(uname -m)" in
  x86_64) script_target="mac:x64"; artifact_target="mac-x64" ;;
  arm64) script_target="mac:arm64"; artifact_target="mac-arm64" ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

python3 "$DesktopRoot/prefetch-macos-runtime.py" "$BuildRoot" "$artifact_target"

# Tell mom's prepare-dsh.ts overlay where the real BuildRoot is, so it can
# additionally copy @cursor/* + @zhongruan/* from BuildRoot root node_modules
# into the dsh runtime (those packages are NOT in the pre-packaged package-set tarballs).
export MOM_BUILD_ROOT="$BuildRoot"

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

mkdir -p "$RepoRoot/dist"
cp -f "$dmg" "$RepoRoot/dist/"
echo "installer: $RepoRoot/dist/$(basename "$dmg")"
