/** Saved application shell so the next launch can paint before the Host is ready. */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Origin the page uses until the Host binds its port. Nothing listens here, so the socket fails fast and retries. */
export const DESKTOP_SHELL_PENDING_ORIGIN = 'http://127.0.0.1:9'

/** On-disk names written by {@link writeDesktopShellSnapshot}: body SHA-1 hex + `.js`. */
const SHELL_CACHE_FILE = /^[a-f0-9]{40}\.js$/u

/**
 * Whether a snapshot index entry is a safe relative file name under the cache directory.
 * Rejects path segments that could escape the directory via a tampered `index.json`.
 */
export function isShellCacheFileName(name: string): boolean {
  return SHELL_CACHE_FILE.test(name)
}

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
 * Bundle revisions each boot entry advertises, keyed by package id.
 *
 * The Host derives a revision from filesystem metadata. Inside `app.asar` Node reports the
 * launch time as that metadata, so every launch advertises different revisions than the
 * snapshot saved by the previous launch. On-demand chunks (`client.pdf.js`) are not part of
 * the snapshot, so their snapshot-stamped URL only loads when rewritten to the live revision.
 * @param injections - Boot rows, either live or restored from a snapshot.
 * @returns package id to live bundle revision.
 */
export function pluginScriptRevisions(injections: readonly unknown[]): Map<string, string> {
  const revisions = new Map<string, string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as { id?: unknown, rev?: unknown }
    if (typeof record.id === 'string' && typeof record.rev === 'string') {
      revisions.set(record.id, record.rev)
      return
    }
    for (const item of Object.values(value)) visit(item)
  }
  visit(injections)
  return revisions
}

/**
 * Point an on-demand plugin chunk request at the revision the live Host serves.
 *
 * Combo batches and URLs without a revision are left alone: the snapshot answers those by
 * exact key, and the Host rejects anything else.
 * @param request - Application request.
 * @param revisions - Live entry revisions from {@link pluginScriptRevisions}.
 * @returns the request to forward, rewritten only when its package has a live revision.
 */
export function rewriteStalePluginRevision(
  request: Request,
  revisions: ReadonlyMap<string, string>,
): Request {
  if (revisions.size === 0 || !['GET', 'HEAD'].includes(request.method)) return request
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/plugins/') || url.pathname.startsWith('/plugins/??')) return request
  if (!url.searchParams.has('rev')) return request
  for (const [id, rev] of revisions) {
    if (!url.pathname.startsWith(`/plugins/${id}/`)) continue
    if (url.searchParams.get('rev') === rev) return request
    url.searchParams.set('rev', rev)
    return new Request(url, request)
  }
  return request
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
    const root = resolve(directory)
    const files = new Map<string, string>()
    for (const [key, name] of Object.entries(snapshot.files)) {
      if (typeof name !== 'string' || shellScriptKey(key) !== key || !isShellCacheFileName(name)) return undefined
      const absolute = resolve(directory, name)
      if (absolute !== join(root, name)) return undefined
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
  const keep = new Set<string>(['index.json'])
  for (const key of snapshot.keys()) {
    const body = snapshot.read(key)
    if (body === undefined) throw new Error('desktop shell: snapshot is missing a script body')
    // Hash the body so identical scripts across revision query changes share one file,
    // and so a rewrite can drop every name the live index no longer references.
    const name = `${createHash('sha1').update(body).digest('hex')}.js`
    const path = join(directory, name)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, body)
    try { renameSync(temporary, path) } catch { rmSync(path, { force: true }); renameSync(temporary, path) }
    files[key] = name
    keep.add(name)
  }
  const index = join(directory, 'index.json')
  const temporary = `${index}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: snapshot.version, injections: snapshot.injections, files }))
  try { renameSync(temporary, index) } catch { rmSync(index, { force: true }); renameSync(temporary, index) }
  rmSync(join(home, 'desktop-shell.json'), { force: true })
  // Asar-stamped revisions used to leave unbounded orphans (multi-GB). Drop only
  // prior script blobs the live index no longer names.
  for (const entry of readdirSync(directory)) {
    if (keep.has(entry) || !isShellCacheFileName(entry)) continue
    rmSync(join(directory, entry), { force: true })
  }
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
