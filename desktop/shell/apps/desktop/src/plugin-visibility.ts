/** Apply an installed plugin to the already-open desktop window. */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { shellScriptKeys } from './shell-cache.ts'

/**
 * Plugins the profile has saved. The market shows these as installed even
 * while the running Host is still on the previous client graph.
 * @param packageJson - Profile `package.json` text.
 * @returns a stable signature, or undefined when the text is not a manifest.
 */
export function profilePluginSignature(packageJson: string): string | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(packageJson) } catch { return undefined }
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
      if (filename !== null && filename !== 'package.json' && filename !== 'package.json.lock') return
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
