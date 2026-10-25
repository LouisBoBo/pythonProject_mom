/** Saved application shell so the next launch can paint before the Host is ready. */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Origin the page uses until the Host binds its port. Nothing listens here, so the socket fails fast and retries. */
export const DESKTOP_SHELL_PENDING_ORIGIN = 'http://127.0.0.1:9'

/** One launch's boot rows, with plugin script bytes stored beside the index. */
export interface DesktopShellSnapshot {
  readonly version: string
  readonly injections: readonly unknown[]
  /** @param key - Plugin route key. */
  read(key: string): string | undefined
  keys(): readonly string[]
}

/** Fetch used while copying plugin scripts off the live Host. */
export type ShellScriptFetch = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  text(): Promise<string>
}>

/**
 * Directory holding the shell index and one file per plugin script.
 * @param home - Desktop data root.
 * @returns absolute snapshot directory.
 */
export function desktopShellSnapshotPath(home: string): string {
  return join(home, 'desktop-shell')
}

/** Build a snapshot from script bodies already in memory. */
export function desktopShellSnapshot(
  version: string,
  injections: readonly unknown[],
  scripts: Readonly<Record<string, string>>,
): DesktopShellSnapshot {
  return {
    version,
    injections,
    read: key => scripts[key],
    keys: () => Object.keys(scripts),
  }
}

/**
 * Route key for one plugin script, or undefined when the string is not a plugin URL.
 * @param src - Document-relative or absolute script URL from a boot row.
 * @returns pathname plus query, matching the request the page will make.
 */
export function shellScriptKey(src: string): string | undefined {
  try {
    const url = new URL(src, 'http://127.0.0.1/')
    if (!url.pathname.startsWith('/plugins')) return undefined
    return `${url.pathname}${url.search}`
  } catch {
    return undefined
  }
}

/**
 * Every plugin URL named by the boot rows, including the graph's application batches.
 * @param injections - Host boot rows.
 * @returns stable unique route keys.
 */
export function shellScriptKeys(injections: readonly unknown[]): string[] {
  const keys = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const key = shellScriptKey(value)
      if (key !== undefined) keys.add(key)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(injections)
  return [...keys]
}

/**
 * Read a snapshot written by this desktop version.
 * @param home - Desktop data root.
 * @param version - Running application version.
 * @returns the snapshot, or undefined when it is missing or from another version.
 */
export function readDesktopShellSnapshot(home: string, version: string): DesktopShellSnapshot | undefined {
  try {
    const directory = desktopShellSnapshotPath(home)
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const snapshot = parsed as { version?: unknown, injections?: unknown, files?: unknown }
    if (snapshot.version !== version || !Array.isArray(snapshot.injections)) return undefined
    if (typeof snapshot.files !== 'object' || snapshot.files === null) return undefined
    const files = new Map<string, string>()
    for (const [key, name] of Object.entries(snapshot.files)) {
      if (typeof name !== 'string' || shellScriptKey(key) !== key) return undefined
      files.set(key, name)
    }
    return {
      version,
      injections: snapshot.injections,
      read: key => {
        const name = files.get(key)
        if (name === undefined) return undefined
        try { return readFileSync(join(directory, name), 'utf8') } catch { return undefined }
      },
      keys: () => [...files.keys()],
    }
  } catch {
    return undefined
  }
}

/**
 * Replace the snapshot atomically.
 * @param home - Desktop data root.
 * @param snapshot - Complete boot rows and script bodies.
 */
export function writeDesktopShellSnapshot(home: string, snapshot: DesktopShellSnapshot): void {
  const directory = desktopShellSnapshotPath(home)
  mkdirSync(directory, { recursive: true })
  const files: Record<string, string> = {}
  for (const key of snapshot.keys()) {
    const body = snapshot.read(key)
    if (body === undefined) throw new Error('desktop shell: snapshot is missing a script body')
    const name = `${createHash('sha1').update(key).digest('hex')}.js`
    const path = join(directory, name)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, body)
    try { renameSync(temporary, path) } catch { rmSync(path, { force: true }); renameSync(temporary, path) }
    files[key] = name
  }
  const index = join(directory, 'index.json')
  const temporary = `${index}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: snapshot.version, injections: snapshot.injections, files }))
  try { renameSync(temporary, index) } catch { rmSync(index, { force: true }); renameSync(temporary, index) }
  rmSync(join(home, 'desktop-shell.json'), { force: true })
}

/**
 * Copy every plugin script named by the boot rows.
 * @param version - Running application version.
 * @param hostUrl - Authenticated Host URL.
 * @param cookie - Host authentication cookie.
 * @param injections - Boot rows from the ready message.
 * @param fetchScript - HTTP fetch bound to the Host.
 * @returns a snapshot, or undefined when there is nothing to save or a script is missing.
 */
export async function captureDesktopShellSnapshot(
  version: string,
  hostUrl: string,
  cookie: string,
  injections: readonly unknown[],
  fetchScript: ShellScriptFetch,
): Promise<DesktopShellSnapshot | undefined> {
  const keys = shellScriptKeys(injections)
  if (keys.length === 0) return undefined
  const origin = new URL(hostUrl).origin
  const scripts: Record<string, string> = {}
  for (const key of keys) {
    const response = await fetchScript(new URL(key, origin).href, {
      headers: cookie.length > 0 ? { cookie } : {},
    })
    if (!response.ok) return undefined
    scripts[key] = await response.text()
  }
  return desktopShellSnapshot(version, injections, scripts)
}

/**
 * Serve one cached plugin script.
 * @param request - Application request.
 * @param snapshot - Snapshot loaded for this version.
 * @returns a script response, or undefined when this request is not cached.
 */
export function serveCachedShellScript(request: Request, snapshot: DesktopShellSnapshot | undefined): Response | undefined {
  if (snapshot === undefined || !['GET', 'HEAD'].includes(request.method)) return undefined
  const url = new URL(request.url)
  const body = snapshot.read(`${url.pathname}${url.search}`)
  if (body === undefined) return undefined
  const contentType = url.search.includes('.map') || url.pathname.endsWith('.map')
    ? 'application/json; charset=utf-8'
    : 'text/javascript; charset=utf-8'
  return new Response(request.method === 'HEAD' ? null : body, { headers: { 'content-type': contentType } })
}

/**
 * Whether two snapshots name the same plugin scripts.
 * @param left - Snapshot already shown.
 * @param right - Snapshot just captured from the Host.
 * @returns true when a reload would fetch the same bytes.
 */
export function sameShellScripts(left: DesktopShellSnapshot, right: DesktopShellSnapshot): boolean {
  const leftKeys = [...left.keys()].sort()
  const rightKeys = [...right.keys()].sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
}

/**
 * A desktop boot may keep the shell when every remaining entry is only waiting for a service.
 * @param message - Failure text reported by the web boot.
 * @returns true when the report lists only pending entries.
 */
export function desktopBootCanContinue(message: string): boolean {
  const lines = message.split('\n').slice(1).map(line => line.trim()).filter(line => line.length > 0)
  return lines.length > 0 && lines.every(line => line.includes(': pending (waiting for service'))
}

/** Last locale preference the Host confirmed, so the next paint need not wait for it. */
export function readDesktopLocalePreference(home: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'desktop-locale.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('preference' in parsed)) return null
    const preference = (parsed as { preference?: unknown }).preference
    return typeof preference === 'string' ? preference : null
  } catch {
    return null
  }
}

/**
 * Remember a Host locale preference.
 * @param home - Desktop data root.
 * @param preference - Stored preference, or null for automatic selection.
 */
export function writeDesktopLocalePreference(home: string, preference: string | null): void {
  const path = join(home, 'desktop-locale.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ preference }))
}
