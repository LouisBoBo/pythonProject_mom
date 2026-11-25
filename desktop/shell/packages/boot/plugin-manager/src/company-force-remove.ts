/**
 * Company-plugin uninstall must not be blocked by registry 404 / release-age policy.
 *
 * Market UI calls `pnpm remove` via runProfilePnpm. That command still verifies the
 * whole lockfile against registries; a missing `@zhongruan:registry` or 24h age hold
 * makes uninstall fail even though the user only asked to delete a local package.
 *
 * This module force-removes **only** `@zhongruan/*` from the profile so a later install
 * can proceed. Core `@deepseek-ai/*` packages are never touched.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Loopback npm from company-market-bridge; same default as desktop company-market.ts. */
export const COMPANY_BRIDGE_NPM = 'http://127.0.0.1:13090/npm/'

/** Only company-scoped packages may be force-removed. */
export function isForceRemovableCompanyPackage(name: string): boolean {
  return typeof name === 'string' && name.startsWith('@zhongruan/')
}

/** A bundle row the uninstall check compares with a live loader entry. */
export interface CompanyBundleRow {
  readonly id?: string
  readonly name?: string
}

/**
 * Drop this package's rows from the profile user patch.
 *
 * `cordis.patch.yml` is applied after every bundle. An entry that names the
 * same component stays mounted after the bundle is deselected, and uninstall
 * then stops with `bundle-in-use` before pnpm runs. Only blocks whose id is
 * one of this package's rows and whose module name is this package (or is
 * omitted) are removed. Other plugins in the same file stay.
 * @returns Whether the patch file changed.
 */
export function releaseCompanyProfileRows(
  profileDir: string,
  packageName: string,
  rows: readonly CompanyBundleRow[],
): boolean {
  if (!isForceRemovableCompanyPackage(packageName)) return false
  const ids = new Set(rows.flatMap(row => typeof row.id === 'string' && row.id.length > 0 ? [row.id] : []))
  if (ids.size === 0 || !profileDir) return false
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return false
  const text = readFileSync(patchPath, 'utf8')
  const next = stripProfileRows(text, ids, packageName, rows)
  if (next === text) return false
  writeFileSync(patchPath, next)
  return true
}

function stripProfileRows(
  text: string,
  ids: ReadonlySet<string>,
  packageName: string,
  rows: readonly CompanyBundleRow[],
): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const id = topLevelId(lines[index])
    if (id === undefined) {
      out.push(lines[index] ?? '')
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && topLevelId(lines[end]) === undefined) end += 1
    const block = lines.slice(index, end)
    if (!ids.has(id) || !blockNamesPackage(block, packageName, id, rows)) {
      out.push(...block)
    }
    index = end
  }
  let joined = out.join(newline)
  if (text.endsWith('\n') && !joined.endsWith('\n')) joined += newline
  if (text.endsWith('\n\n') && joined.endsWith('\n') && !joined.endsWith('\n\n')) joined += newline
  return joined
}

function topLevelId(line: string | undefined): string | undefined {
  const match = /^-\s+id:\s*(['"]?)([^'"\s#]+)\1\s*$/.exec(line ?? '')
  return match?.[2]
}

function blockNamesPackage(
  block: readonly string[],
  packageName: string,
  id: string,
  rows: readonly CompanyBundleRow[],
): boolean {
  const named = block.flatMap(line => {
    const match = /^\s+name:\s*(['"]?)([^'"\s#]+)\1\s*$/.exec(line)
    return match?.[2] === undefined ? [] : [match[2]]
  })
  if (named.length === 0) return true
  if (named.includes(packageName)) return true
  return named.some(name => rows.some(row => row.id === id && row.name === name))
}

const PUBLIC_REGISTRIES = new Set([
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
])

function registryBase(url: string): string {
  return url.trim().replace(/\/+$/u, '')
}

/**
 * The `@zhongruan/*` spec named by add, remove, or update, without a version.
 * Path, link, and URL specs stay with the registry the caller asked.
 */
export function companyPackageSpec(args: readonly string[]): string | undefined {
  const commandAt = args.findIndex(argument => !argument.startsWith('-'))
  const command = args[commandAt]
  if (command !== 'add' && command !== 'remove' && command !== 'update' && command !== 'up') return undefined
  const spec = args.slice(commandAt + 1).find(argument => !argument.startsWith('-'))
  if (spec === undefined || spec.startsWith('.') || spec.startsWith('file:') || spec.startsWith('link:') || spec.includes('://')) {
    return undefined
  }
  const name = spec.startsWith('@') ? `@${spec.slice(1).split('@')[0] ?? ''}` : spec.split('@')[0] ?? ''
  return isForceRemovableCompanyPackage(name) ? name : undefined
}

/**
 * Point a company install, update, or uninstall at the market bridge when the
 * caller asked the public npm registry or npmmirror. Those mirrors answer 404
 * for `@zhongruan/*`. A registry that is already the bridge, or another private
 * registry, is kept.
 */
export function companyPnpmArgs(args: readonly string[]): readonly string[] {
  if (companyPackageSpec(args) === undefined) return args
  const flag = args.find(argument => argument.startsWith('--config.registry=') || argument.startsWith('--registry='))
  const given = flag === undefined ? '' : flag.slice(flag.indexOf('=') + 1)
  const givenBase = registryBase(given)
  const useGiven = givenBase.length > 0 && !PUBLIC_REGISTRIES.has(givenBase)
  const registry = useGiven ? (given.endsWith('/') ? given : `${givenBase}/`) : companyRemoveRegistry()
  const without = args.filter(argument => !argument.startsWith('--registry=') && !argument.startsWith('--config.registry='))
  return [...without, `--config.registry=${registry}`]
}

/** Registry URL to prefer for company package remove (bridge proxies company + public). */
export function companyRemoveRegistry(): string {
  const fromEnv = (process.env.ZR_DSH_COMPANY_NPM ?? process.env.ZR_DSH_MARKET_NPM ?? '').trim()
  if (fromEnv) return fromEnv.replace(/\/+$/u, '') + '/'
  return COMPANY_BRIDGE_NPM
}

export interface ForceRemoveResult {
  readonly ok: boolean
  readonly detail: string
}

/**
 * Drop a company package from the profile without asking a registry.
 * @param profileDir - Desktop profile directory.
 * @param packageName - Exact dependency name (must be `@zhongruan/…`).
 */
export function forceRemoveCompanyPlugin(profileDir: string, packageName: string): ForceRemoveResult {
  if (!isForceRemovableCompanyPackage(packageName)) {
    return { ok: false, detail: `refused force-remove of non-company package: ${packageName}` }
  }
  if (!profileDir || !existsSync(profileDir)) {
    return { ok: false, detail: `profile missing: ${profileDir}` }
  }

  const notes: string[] = [`mom force-remove ${packageName}`]
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, detail: `no package.json in ${profileDir}` }
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    let changed = false
    if (manifest.dependencies && Object.hasOwn(manifest.dependencies, packageName)) {
      delete manifest.dependencies[packageName]
      changed = true
      notes.push('removed from package.json dependencies')
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(packageName)) {
      manifest.dsh = {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles: bundles.filter((name) => name !== packageName),
        },
      }
      changed = true
      notes.push('removed from dsh.profile.bundles')
    }
    if (changed) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    } else {
      notes.push('package.json already had no dependency/bundle entry')
    }
  } catch (error) {
    return { ok: false, detail: `package.json update failed: ${String(error)}` }
  }

  const scope = packageName.slice(0, packageName.indexOf('/'))
  const shortName = packageName.slice(packageName.indexOf('/') + 1)
  const scopeDir = join(profileDir, 'node_modules', scope)
  if (existsSync(scopeDir)) {
    for (const entry of readdirSync(scopeDir)) {
      if (entry !== shortName && !entry.startsWith(`${shortName}_tmp_`) && !entry.startsWith(`${shortName}.bak`)) {
        continue
      }
      const target = join(scopeDir, entry)
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
        notes.push(`removed ${scope}/${entry}`)
      } catch (error) {
        notes.push(`could not remove ${scope}/${entry}: ${String(error)}`)
      }
    }
  } else {
    notes.push('node_modules package directory already absent')
  }

  // Lockfile may still name the package; leave it. Next successful pnpm install/add
  // through the company bridge rewrites it. Deleting the whole lockfile would force a
  // full public resolve and is worse for offline / flaky networks.
  notes.push('left pnpm-lock.yaml in place for the next install to reconcile')
  return { ok: true, detail: notes.join('; ') }
}
