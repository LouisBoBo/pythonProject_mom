/** Company plugin market: seed the desktop profile and serve the index. */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Shipped bundle that adds the Plugins page Discover tab. */
export const COMPANY_MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
/** Loopback index produced by scripts/company-market-bridge.mjs. */
export const COMPANY_MARKET_INDEX = 'http://127.0.0.1:13090/index.json'
/**
 * Loopback npm registry exposed by the same bridge.
 * Market installs already pass this URL; update/uninstall still read profile `.npmrc`.
 * Without the scoped override, pnpm falls through to npmmirror → ERR_PNPM_FETCH_404 for `@zhongruan/*`.
 */
export const COMPANY_MARKET_NPM = 'http://127.0.0.1:13090/npm/'
/** Marker block rewritten on every ensure; other `.npmrc` lines are kept. */
export const COMPANY_MARKET_NPMRC_BEGIN = '# --- company-dsh-market ---'
export const COMPANY_MARKET_NPMRC_END = '# --- /company-dsh-market ---'
/** Marker for the permanent release-age exclude block in `pnpm-workspace.yaml`. */
export const COMPANY_RELEASE_AGE_MARKER = 'mom-company-release-age-exclude-v1'
const RELEASE_AGE_EXCLUDE = ['@zhongruan/*', '@cursor/*'] as const

let bridge: ChildProcess | undefined

/**
 * Packaged bridge script, when this build included the company market.
 * @param packaged - Whether Electron is running from an installer.
 * @param resourcesPath - Electron resources directory.
 * @returns absolute script path, or undefined when this build has no bridge.
 */
export function companyMarketScript(packaged: boolean, resourcesPath: string): string | undefined {
  if (!packaged) return undefined
  const path = join(resourcesPath, 'company-market-bridge.mjs')
  return existsSync(path) ? path : undefined
}

/**
 * Turn on the company market bundle and point Discover at the local index.
 * Also heals profile npm registry + same-day release-age exclude so update/uninstall
 * do not hit public npmmirror for `@zhongruan/*` (users never edit `.npmrc`).
 * Existing profile files are kept; the index URL is added once.
 * @param profileDir - Desktop profile directory.
 */
/** Company tarball URLs baked into a lockfile before the registry moved off the TLS port. */
const COMPANY_LOCK_TARBALL = /https?:\/\/175\.178\.238\.31(?::8443)?\/dsh-plugins\/npm\//g

/**
 * Point lockfile tarballs at the local bridge.
 * An absolute `https://…:8443/…tgz` is fetched by pnpm itself, so a reset on
 * that port fails uninstall and update even when the bridge can still serve
 * the package.
 * @param lockText - `pnpm-lock.yaml` contents.
 * @param localNpm - Bridge npm URL.
 * @returns the lockfile text, unchanged when it names no company tarball.
 */
export function rewriteCompanyLockTarballs(lockText: string, localNpm: string = COMPANY_MARKET_NPM): string {
  const local = `${String(localNpm).replace(/\/+$/u, '')}/`
  return lockText.replace(COMPANY_LOCK_TARBALL, local)
}

/**
 * Rewrite company tarball URLs in the profile lockfile.
 * Skips the write while pnpm holds `package.json.lock`.
 * @param profileDir - Desktop profile directory.
 * @param localNpm - Bridge npm URL.
 * @returns whether the lockfile was rewritten.
 */
export function healCompanyLockfile(profileDir: string, localNpm: string = COMPANY_MARKET_NPM): boolean {
  if (!profileDir || !existsSync(profileDir)) return false
  const lockPath = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(lockPath) || existsSync(join(profileDir, 'package.json.lock'))) return false
  const body = readFileSync(lockPath, 'utf8')
  const next = rewriteCompanyLockTarballs(body, localNpm)
  if (next === body) return false
  writeFileSync(lockPath, next)
  return true
}

export function ensureCompanyMarketProfile(profileDir: string): void {
  try {
    writeCompanyMarketProfile(profileDir)
    ensureCompanyMarketNpmrc(profileDir)
    ensureCompanyReleaseAgeExclude(profileDir)
    healCompanyLockfile(profileDir)
  } catch (error) {
    console.error('desktop company market profile was not updated', error)
  }
}

function writeCompanyMarketProfile(profileDir: string): void {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(COMPANY_MARKET_BUNDLE)) {
    manifest.dsh = {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: [...bundles, COMPANY_MARKET_BUNDLE] },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return
  const patch = readFileSync(patchPath, 'utf8')
  if (patch.includes(COMPANY_MARKET_INDEX)) return
  const entry = [
    '- id: plugin-market',
    '  config:',
    '    indexes:',
    `      - ${COMPANY_MARKET_INDEX}`,
    '',
  ].join('\n')
  const next = /\[\]\s*$/u.test(patch) ? patch.replace(/\[\]\s*$/u, entry) : `${patch.replace(/\s*$/u, '\n')}${entry}`
  writeFileSync(patchPath, next)
}

/**
 * Point `@zhongruan` / `@cursor` at the local company-market bridge.
 * Idempotent: rewrites only the marked block.
 * @param profileDir - Desktop profile directory.
 * @param registry - Bridge npm URL (tests may override).
 */
export function ensureCompanyMarketNpmrc(
  profileDir: string,
  registry: string = COMPANY_MARKET_NPM,
): void {
  if (!profileDir || !existsSync(profileDir)) return
  const npmrcPath = join(profileDir, '.npmrc')
  const reg = `${String(registry).replace(/\/+$/u, '')}/`
  let body = ''
  if (existsSync(npmrcPath)) {
    body = readFileSync(npmrcPath, 'utf8')
    body = body.replace(
      new RegExp(
        String.raw`\n?${escapeRegExp(COMPANY_MARKET_NPMRC_BEGIN)}[\s\S]*?${escapeRegExp(COMPANY_MARKET_NPMRC_END)}\n?`,
        'g',
      ),
      '\n',
    )
  }
  // Default registry also points at the bridge: `pnpm remove` verifies the whole lockfile
  // and may pass `--config.registry=…`; the bridge proxies `@zhongruan/*` to the company
  // npm and everything else to npmmirror. Do not set minimum-release-age=0 (ignored by DSH pnpm).
  const block = [
    COMPANY_MARKET_NPMRC_BEGIN,
    `registry=${reg}`,
    `@zhongruan:registry=${reg}`,
    `@cursor:registry=${reg}`,
    'strict-ssl=false',
    COMPANY_MARKET_NPMRC_END,
    '',
  ].join('\n')
  const next = (body.trimEnd() ? `${body.trimEnd()}\n` : '') + block
  writeFileSync(npmrcPath, next)
}

/**
 * Bypass pnpm's default 24h minimumReleaseAge for company scopes.
 * Without this, same-day publishes fail update/uninstall with supply-chain policy errors.
 * @param profileDir - Desktop profile directory.
 */
export function ensureCompanyReleaseAgeExclude(profileDir: string): void {
  if (!profileDir || !existsSync(profileDir)) return
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    const created = [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      '',
      `# ${COMPANY_RELEASE_AGE_MARKER}`,
      'minimumReleaseAgeExclude:',
      ...RELEASE_AGE_EXCLUDE.map((item) => `  - '${item}'`),
      '',
    ].join('\n')
    writeFileSync(workspacePath, created)
    scrubIneffectiveReleaseAgeNpmrc(profileDir)
    return
  }

  let src = readFileSync(workspacePath, 'utf8')
  if (!/^minimumReleaseAgeExclude:\s*$/mu.test(src)) {
    const block = [
      '',
      `# ${COMPANY_RELEASE_AGE_MARKER}`,
      'minimumReleaseAgeExclude:',
      ...RELEASE_AGE_EXCLUDE.map((item) => `  - '${item}'`),
      '',
    ].join('\n')
    writeFileSync(workspacePath, `${src.replace(/\s*$/u, '')}\n${block}`)
    scrubIneffectiveReleaseAgeNpmrc(profileDir)
    return
  }

  const missing = RELEASE_AGE_EXCLUDE.filter((item) => !src.includes(`'${item}'`) && !src.includes(`"${item}"`))
  if (missing.length === 0 && src.includes(COMPANY_RELEASE_AGE_MARKER)) {
    scrubIneffectiveReleaseAgeNpmrc(profileDir)
    return
  }

  const lines = src.split(/(?<=\n)/u)
  const out: string[] = []
  let insertedMarker = src.includes(COMPANY_RELEASE_AGE_MARKER)
  let insertedMissing = missing.length === 0
  for (const line of lines) {
    if (!insertedMarker && /^minimumReleaseAgeExclude:\s*$/u.test(line)) {
      out.push(`# ${COMPANY_RELEASE_AGE_MARKER}\n`)
      insertedMarker = true
    }
    out.push(line)
    if (!insertedMissing && /^minimumReleaseAgeExclude:\s*$/u.test(line)) {
      for (const item of missing) out.push(`  - '${item}'\n`)
      insertedMissing = true
    }
  }
  writeFileSync(workspacePath, out.join(''))
  scrubIneffectiveReleaseAgeNpmrc(profileDir)
}

/** Drop ineffective `minimum-release-age=0` lines left by older ops scripts. */
function scrubIneffectiveReleaseAgeNpmrc(profileDir: string): void {
  const npmrcPath = join(profileDir, '.npmrc')
  if (!existsSync(npmrcPath)) return
  const src = readFileSync(npmrcPath, 'utf8')
  const kept = src.split(/(?<=\n)/u).filter((line) => {
    const stripped = line.trim()
    if (stripped.startsWith('minimum-release-age=') || stripped.startsWith('minimum-release-age-exclude')) return false
    return true
  })
  const next = kept.join('')
  if (next !== src) writeFileSync(npmrcPath, next.endsWith('\n') || next.length === 0 ? next : `${next}\n`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Start the company market bridge with Electron's Node.
 * @param packaged - Whether Electron is running from an installer.
 * @param resourcesPath - Electron resources directory.
 * @param execPath - Electron executable, launched as Node.
 * @param caFile - PEM bundle trusting the company CA that signs the market host; without it the
 * bridge's HTTPS fetch of the catalog fails verification.
 * @param outFile - Where the bridge writes the index. It must be writable: the script sits inside
 * the signed bundle, and its default path would add files there and break the code signature.
 */
export function startCompanyMarketBridge(
  packaged: boolean,
  resourcesPath: string,
  execPath: string,
  caFile?: string,
  outFile?: string,
): void {
  if (bridge !== undefined) return
  const script = companyMarketScript(packaged, resourcesPath)
  if (script === undefined) return
  // Ensure writable out dir exists before the bridge process starts.
  const out = outFile?.trim() ?? ''
  if (out) {
    try { mkdirSync(dirname(out), { recursive: true }) } catch { /* best effort */ }
  }
  bridge = spawn(execPath, [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(() => {
        const certPath = caFile?.trim() ?? ''
        return certPath ? { NODE_EXTRA_CA_CERTS: certPath } : {}
      })(),
      ...(out ? { ZR_DSH_MARKET_OUT: out } : {}),
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  bridge.on('exit', () => { bridge = undefined })
}

/** Stop the bridge started by this process. */
export function stopCompanyMarketBridge(): void {
  bridge?.kill()
  bridge = undefined
}
