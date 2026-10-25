/** Filesystem ownership for the Electron-managed desktop installation. */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Stable desktop installation paths under this app's own home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Data root for this desktop only.
 * @returns `%LOCALAPPDATA%\ZR_DSH\dsh-home`.
 */
export function zrDesktopHome(): string {
  const local = process.env.LOCALAPPDATA
  const root = local !== undefined && local.trim().length > 0 ? local : join(homedir(), 'AppData', 'Local')
  return join(root, 'ZR_DSH', 'dsh-home')
}

/**
 * Resolve every Electron-owned path and pin the host to this app's home.
 * @param dshHome - Desktop data root. Defaults to {@link zrDesktopHome}.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = zrDesktopHome()): DesktopPaths {
  process.env.DSH_HOME = dshHome
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}
