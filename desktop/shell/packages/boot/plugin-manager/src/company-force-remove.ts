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
