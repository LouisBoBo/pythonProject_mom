/** Apply an installed plugin to the already-open desktop window. */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { shellScriptKeys } from './shell-cache.ts'

/**
 * Remove a UTF-8 BOM from the profile `package.json` if one is present.
 * Windows editors and PowerShell `Set-Content -Encoding utf8` often write EF BB BF;
 * Host `JSON.parse` rejects that and the desktop window stays blank.
 * Skips while `package.json.lock` is held so a concurrent pnpm write is not clobbered.
 * @param profileDir - Desktop profile directory.
 * @returns true when a BOM was stripped.
 */
export function sanitizeProfileManifestBom(profileDir: string): boolean {
  const path = join(profileDir, 'package.json')
  if (existsSync(join(profileDir, 'package.json.lock'))) return false
  let bytes: Buffer
  try { bytes = readFileSync(path) } catch { return false }
  if (bytes.length < 3 || bytes[0] !== 0xEF || bytes[1] !== 0xBB || bytes[2] !== 0xBF) return false
  const body = bytes.subarray(3)
  let parsed: unknown
  try { parsed = JSON.parse(body.toString('utf8')) } catch { return false }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const temporary = `${path}.tmp`
  writeFileSync(temporary, body)
  try {
    renameSync(temporary, path)
  } catch {
    try {
      rmSync(path, { force: true })
      renameSync(temporary, path)
    } catch {
      rmSync(temporary, { force: true })
      return false
    }
  }
  return true
}

/**
 * Plugins the profile has saved. The market shows these as installed even
 * while the running Host is still on the previous client graph.
 * @param packageJson - Profile `package.json` text.
 * @returns a stable signature, or undefined when the text is not a manifest.
 */
export function profilePluginSignature(packageJson: string): string | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(packageJson.replace(/^\uFEFF/u, '')) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const manifest = parsed as { dependencies?: unknown, dsh?: { profile?: { bundles?: unknown } } }
  const dependencies = manifest.dependencies
  const deps: string[] = []
  if (typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === 'string') deps.push(`${name}@${version}`)
    }
  }
  deps.sort()
  const bundlesRaw = manifest.dsh?.profile?.bundles
  const bundles = Array.isArray(bundlesRaw)
    ? bundlesRaw.filter((item): item is string => typeof item === 'string').sort()
    : []
  return `${deps.join('\n')}\n---\n${bundles.join('\n')}`
}

/**
 * Whether two boot graphs name the same plugin scripts.
 * @param left - Script keys the open page already loaded.
 * @param right - Script keys the Host is serving now.
 * @returns true when reloading the page would not reveal a new plugin.
 */
export function sameScriptKeyList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightKeys = [...right].sort()
  return [...left].sort().every((key, index) => key === rightKeys[index])
}

/**
 * Whether the open page is missing plugin scripts the Host now provides.
 * @param booted - Keys returned to the page, when it has booted.
 * @param injections - Live Host boot rows.
 * @returns true when the page should load again.
 */
export function bootScriptsChanged(booted: readonly string[] | undefined, injections: readonly unknown[]): boolean {
  if (booted === undefined) return false
  return !sameScriptKeyList(booted, shellScriptKeys(injections))
}

const SCRIPT_PACKAGE = /@[\w.-]+\/[\w.-]+/gu

/** Package names named by plugin script URLs. Revision query changes are ignored. */
export function scriptPackages(keys: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const key of keys) {
    for (const match of key.matchAll(SCRIPT_PACKAGE)) names.add(match[0])
  }
  return names
}

/**
 * Whether the open page still has a plugin script the live Host no longer serves.
 * A revision-only change is not a removal. An empty live list is not a removal:
 * the Host has not published its graph yet.
 * @param booted - Script keys the open page already loaded.
 * @param injections - Live Host boot rows.
 */
export function removedPluginScripts(booted: readonly string[] | undefined, injections: readonly unknown[]): boolean {
  if (booted === undefined) return false
  const live = scriptPackages(shellScriptKeys(injections))
  if (live.size === 0) return false
  for (const name of scriptPackages(booted)) {
    if (!live.has(name)) return true
  }
  return false
}

const WINDOW_RESTART_METHODS = new Set(['removeBundle', 'installBundle', 'setBundleEnabled'])

/**
 * Plugin-manager method named by a desktop API path, such as `/api/pluginManager/removeBundle`.
 * @param pathname - Request path.
 * @returns the method, or undefined when the path is not a plugin-manager call.
 */
export function pluginManagerMethod(pathname: string): string | undefined {
  const prefix = '/api/pluginManager/'
  if (!pathname.startsWith(prefix)) return undefined
  const method = pathname.slice(prefix.length).split('/')[0]
  return method === '' ? undefined : method
}

function changeWasSaved(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const record = body as { ok?: unknown, value?: unknown, result?: unknown, application?: unknown, changed?: unknown }
  if (record.application === 'applied' || record.application === 'restart-required' || record.changed === true) return true
  if (record.ok === true && changeWasSaved(record.value)) return true
  // The Host answers `{ type: 'server-response', result: { ok, value } }`, not the change itself.
  return changeWasSaved(record.result)
}

/**
 * Whether this plugin-manager response should ask the user to restart.
 * Install, uninstall, and the plugin enable switch save the profile. The window
 * stays as it is until the user confirms. A row toggle inside a plugin does not ask.
 * @param pathname - Request path.
 * @param body - JSON answer, either the change itself or `{ ok, value }`.
 */
export function pluginChangeRestartsWindow(pathname: string, body: unknown): boolean {
  const method = pluginManagerMethod(pathname)
  if (method === undefined || !WINDOW_RESTART_METHODS.has(method)) return false
  return changeWasSaved(body)
}

/**
 * Whether a directory watch event can be the profile manifest.
 * Atomic writes land as `package.json.<hex>.tmp` and Windows often reports only that name.
 * @param filename - Event file name, or null for a directory-level event.
 */
export function profileManifestEvent(filename: string | null): boolean {
  if (filename === null) return true
  return filename === 'package.json' || filename === 'package.json.lock' || filename.startsWith('package.json.')
}

/**
 * Move profile copies of the installation's runtime packages aside when their version differs.
 * Node resolves profile packages before the runtime resolution, so a plugin that pins a private
 * runtime dependency shadows the matching installation copy for every other plugin too — an
 * `@deepseek-ai/dsh-tools@0.1.1-rc.2` hoisted by a company plugin makes the enabled cursor-chat
 * import fail against the installation's 0.2.x `dsh-llm`. The runtime already supplies its own
 * packages, so quarantining the shadow restores the pairing without disabling the plugin.
 * @param profileDir - Desktop profile directory.
 * @param dshDir - Installation directory; its `node_modules` is the runtime resolution.
 * @param quarantineDir - Where the shadowed copies are kept for inspection.
 * @returns the moved `name@version (runtime version)` entries, for logging.
 */
export function quarantineShadowedRuntimePackages(
  profileDir: string,
  dshDir: string,
  quarantineDir = join(profileDir, '.desktop-quarantine'),
): string[] {
  const runtimeScope = join(dshDir, 'node_modules', '@deepseek-ai')
  const profileScope = join(profileDir, 'node_modules', '@deepseek-ai')
  let names: string[]
  try { names = readdirSync(runtimeScope) } catch { return [] }
  const moved: string[] = []
  for (const name of names) {
    const installed = join(profileScope, name)
    if (!existsSync(installed)) continue
    const runtimeVersion = packageVersion(join(runtimeScope, name))
    const profileVersion = packageVersion(installed)
    if (runtimeVersion === undefined || profileVersion === runtimeVersion) continue
    try {
      mkdirSync(quarantineDir, { recursive: true })
      renameSync(installed, join(quarantineDir, `${name}-${profileVersion ?? 'unknown'}-${Date.now()}`))
      moved.push(`${name}@${profileVersion ?? 'unknown'} (runtime ${runtimeVersion})`)
    } catch {
      // A failed move must not keep the Host from starting; the Host will report the real import error.
    }
  }
  return moved
}

function packageVersion(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Watch the profile until its saved plugins change and the install lock is gone.
 * A desktop Host without HMR keeps the old client until it starts again; this is
 * the signal to do that start while the window is still open.
 * @param profileDir - Desktop profile directory.
 * @param onChange - Apply the new plugins. Return false to keep watching the previous set.
 * @param debounceMs - Quiet period so a manifest is not read mid-write.
 * @returns a handle, or undefined when the profile directory does not exist yet.
 */
export function watchProfilePlugins(
  profileDir: string,
  onChange: () => Promise<boolean> | boolean,
  debounceMs = 400,
): { close(): void } | undefined {
  let applied = readSignature(profileDir) ?? ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  let closed = false
  let pending = false
  const schedule = (): void => {
    if (timer !== undefined || closed) return
    timer = setTimeout(() => {
      timer = undefined
      check()
    }, debounceMs)
    timer.unref()
  }
  const check = (): void => {
    if (closed || pending) {
      if (!closed && pending) schedule()
      return
    }
    if (existsSync(join(profileDir, 'package.json.lock'))) {
      schedule()
      return
    }
    const next = readSignature(profileDir)
    if (next === undefined || next === applied) return
    const previous = applied
    applied = next
    pending = true
    void Promise.resolve(onChange()).then((accepted) => {
      if (!accepted) applied = previous
    }).finally(() => {
      pending = false
    })
  }
  try {
    watcher = watch(profileDir, { persistent: false }, (_event, filename) => {
      if (!profileManifestEvent(filename)) return
      schedule()
    })
  } catch {
    return undefined
  }
  return {
    close(): void {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
    },
  }
}

function readSignature(profileDir: string): string | undefined {
  try { return profilePluginSignature(readFileSync(join(profileDir, 'package.json'), 'utf8')) }
  catch { return undefined }
}
