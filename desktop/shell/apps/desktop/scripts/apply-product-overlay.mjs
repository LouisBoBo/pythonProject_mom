import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

function fail(message) {
  console.error(message)
  process.exit(1)
}

function findMarkedRoot(start) {
  let dir = resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, '.dsh-mom-root'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function readPin(path) {
  const pin = {}
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const index = line.indexOf('=')
    if (index === -1) continue
    pin[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return pin
}

function allowDesktopProductVersion(buildRoot) {
  const path = join(buildRoot, 'scripts', 'release', 'families.ts')
  const text = readFileSync(path, 'utf8')
  const lf = text.replace(/\r\n/gu, '\n')
  if (lf.includes("member.directory !== 'apps/desktop'")) return
  const needle = [
    '    const versions = new Set(members.map(member => member.version))',
    '    if (versions.size !== 1) {',
    '      const detail = members.map(member => `${member.directory}: ${member.version}`).join(\'\\n\')',
    '      throw new Error(`dsh release members must share one version:\\n${detail}`)',
    '    }',
  ].join('\n')
  const replacement = [
    "    const shared = members.filter(member => member.directory !== 'apps/desktop')",
    '    const versions = new Set(shared.map(member => member.version))',
    '    if (versions.size !== 1) {',
    '      const detail = shared.map(member => `${member.directory}: ${member.version}`).join(\'\\n\')',
    '      throw new Error(`dsh release members must share one version:\\n${detail}`)',
    '    }',
  ].join('\n')
  if (!lf.includes(needle)) fail('could not patch the dsh family version check')
  const patched = lf.replace(needle, replacement)
  writeFileSync(path, text.includes('\r\n') ? patched.replace(/\n/gu, '\r\n') : patched)
  console.log('desktop product version stays independent of the dsh runtime')
}

function applyOnMac(buildRoot, productRoot) {
  const pinPath = join(productRoot, 'desktop', 'upstream-pin.txt')
  if (!existsSync(pinPath)) fail(`missing ${pinPath}`)
  const expected = readPin(pinPath).commit
  if (!expected) fail('upstream-pin.txt has no commit')
  if (!existsSync(join(buildRoot, '.git'))) {
    fail(`${buildRoot} is missing. Clone tag dsh-v0.2.1-rc.2 there, then run apply again.`)
  }
  const head = spawnSync('git', ['-C', buildRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.status !== 0) fail(`git rev-parse failed in ${buildRoot}`)
  const actual = head.stdout.trim()
  if (actual !== expected) {
    fail(`${buildRoot} HEAD is ${actual}, expected ${expected} (tag dsh-v0.2.1-rc.2).`)
  }

  const manifestPath = join(productRoot, 'desktop', 'shell-manifest.txt')
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`)
  const paths = readFileSync(manifestPath, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (paths.length === 0) fail('shell-manifest.txt is empty')
  const overlay = join(productRoot, 'desktop', 'shell')
  for (const relative of paths) {
    const normalized = relative.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').some(part => part === '..' || part === '.')) {
      fail(`illegal manifest path: ${relative}`)
    }
    const source = join(overlay, normalized)
    const target = join(buildRoot, normalized)
    if (!existsSync(source)) fail(`missing ${source}`)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }
  console.log(`apply ok, ${paths.length} files. Source of truth: ${overlay}`)
  allowDesktopProductVersion(buildRoot)
}

const buildRoot = process.env.DSH_BUILD_ROOT
  ? resolve(process.env.DSH_BUILD_ROOT)
  : findMarkedRoot(scriptDir) ?? (process.platform === 'win32' ? 'C:\\dsh-src' : undefined)
const marker = buildRoot ? join(buildRoot, '.dsh-mom-root') : undefined
if (!buildRoot || !existsSync(marker)) {
  fail(process.platform === 'darwin'
    ? 'desktop package: product overlay is not linked. From the product repo run: bash desktop/package-macos.sh'
    : 'desktop package: product overlay is not linked. From the product repo run: powershell -File desktop\\package-windows.ps1')
}

const productRoot = readFileSync(marker, 'utf8').replace(/^\uFEFF/u, '').trim()
if (process.platform === 'win32') {
  const sync = join(productRoot, 'desktop', 'shell-sync.ps1')
  if (!existsSync(sync)) fail(`desktop package: missing ${sync}`)
  const result = spawnSync('powershell', ['-NoProfile', '-File', sync, '-Mode', 'apply'], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status)
  allowDesktopProductVersion(buildRoot)
  process.exit(0)
}

applyOnMac(buildRoot, productRoot)
