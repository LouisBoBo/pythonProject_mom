/** Company plugin market: seed the desktop profile and serve the index. */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Shipped bundle that adds the Plugins page Discover tab. */
export const COMPANY_MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
/** Loopback index produced by scripts/company-market-bridge.mjs. */
export const COMPANY_MARKET_INDEX = 'http://127.0.0.1:13090/index.json'

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
 * Existing profile files are kept; the index URL is added once.
 * @param profileDir - Desktop profile directory.
 */
export function ensureCompanyMarketProfile(profileDir: string): void {
  try {
    writeCompanyMarketProfile(profileDir)
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
  bridge = spawn(execPath, [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(() => {
        const certPath = caFile?.trim() ?? ''
        return certPath ? { NODE_EXTRA_CA_CERTS: certPath } : {}
      })(),
      ...(() => {
        const out = outFile?.trim() ?? ''
        return out ? { ZR_DSH_MARKET_OUT: out } : {}
      })(),
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
