import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDesktopShellSnapshot,
  desktopBootCanContinue,
  desktopShellSnapshot,
  desktopShellSnapshotPath,
  isShellCacheFileName,
  pluginScriptRevisions,
  readDesktopShellSnapshot,
  rewriteStalePluginRevision,
  sameShellScripts,
  serveCachedShellScript,
  shellScriptKey,
  shellScriptKeys,
  writeDesktopShellSnapshot,
} from '../src/shell-cache.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
  homes.push(directory)
  return directory
}

describe('desktop shell snapshot', () => {
  it('keeps plugin route keys and ignores other boot text', () => {
    expect(shellScriptKey('plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc')).toBe(
      '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc',
    )
    const keys = shellScriptKeys([
      { kind: 'script', text: 'window.__ModuleLoader__' },
      { kind: 'script-src', src: 'plugins/??app/client.js&rev=abc' },
      { kind: 'global', name: '__DSH_BOOT__', value: { batches: [{ url: 'plugins/??layout/client.js&rev=def' }] } },
    ])
    expect(keys).toEqual([
      '/plugins/??app/client.js&rev=abc',
      '/plugins/??layout/client.js&rev=def',
    ])
  })

  it('round-trips a snapshot for the same version only', () => {
    const directory = home()
    const snapshot = desktopShellSnapshot('0.2.1-rc.2', [{ kind: 'global', name: '__DSH_BOOT__' }], {
      '/plugins/??app/client.js&rev=abc': 'console.log(1)',
    })
    writeDesktopShellSnapshot(directory, snapshot)
    const restored = readDesktopShellSnapshot(directory, '0.2.1-rc.2')
    expect(restored?.injections).toEqual(snapshot.injections)
    expect(restored?.read('/plugins/??app/client.js&rev=abc')).toBe('console.log(1)')
    expect(readDesktopShellSnapshot(directory, '0.2.1-rc.1')).toBeUndefined()
    expect(desktopShellSnapshotPath(directory)).toContain('desktop-shell')
  })

  it('stores scripts by content hash and drops orphan files on rewrite', () => {
    const directory = home()
    const first = desktopShellSnapshot('0.2.1-rc.2', [], {
      '/plugins/??app/client.js&rev=old': 'console.log(1)',
    })
    writeDesktopShellSnapshot(directory, first)
    const shellDir = desktopShellSnapshotPath(directory)
    writeFileSync(join(shellDir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.js'), 'stale')
    const second = desktopShellSnapshot('0.2.1-rc.2', [], {
      '/plugins/??app/client.js&rev=new': 'console.log(1)',
      '/plugins/??layout/client.js&rev=new': 'console.log(2)',
    })
    writeDesktopShellSnapshot(directory, second)
    const restored = readDesktopShellSnapshot(directory, '0.2.1-rc.2')
    expect(restored?.read('/plugins/??app/client.js&rev=new')).toBe('console.log(1)')
    expect(restored?.read('/plugins/??layout/client.js&rev=new')).toBe('console.log(2)')
    expect(existsSync(join(shellDir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.js'))).toBe(false)
  })

  it('rejects a tampered index that points outside the cache directory', () => {
    expect(isShellCacheFileName('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.js')).toBe(true)
    expect(isShellCacheFileName('../secrets.txt')).toBe(false)
    const directory = home()
    const shellDir = desktopShellSnapshotPath(directory)
    writeDesktopShellSnapshot(directory, desktopShellSnapshot('0.2.1-rc.2', [], {
      '/plugins/??app/client.js&rev=abc': 'console.log(1)',
    }))
    writeFileSync(join(shellDir, 'index.json'), JSON.stringify({
      version: '0.2.1-rc.2',
      injections: [],
      files: { '/plugins/??app/client.js&rev=abc': '../../../etc/passwd' },
    }))
    expect(readDesktopShellSnapshot(directory, '0.2.1-rc.2')).toBeUndefined()
  })

  it('serves a cached script and refuses a request the snapshot does not name', () => {
    const snapshot = desktopShellSnapshot('0.2.1-rc.2', [], {
      '/plugins/??app/client.js&rev=abc': 'console.log(1)',
    })
    const hit = serveCachedShellScript(new Request('dsh-app://app/plugins/??app/client.js&rev=abc'), snapshot)
    expect(hit?.headers.get('content-type')).toContain('javascript')
    expect(serveCachedShellScript(new Request('dsh-app://app/plugins/??missing/client.js&rev=nope'), snapshot)).toBeUndefined()
  })

  it('captures every named script and treats a different route set as a new shell', async () => {
    const fetchScript = async (input: string) => ({ ok: input.endsWith('rev=abc'), text: async () => 'body' })
    const injections = [{ kind: 'script-src', src: 'plugins/??app/client.js&rev=abc' }]
    const snapshot = await captureDesktopShellSnapshot('0.2.1-rc.2', 'http://127.0.0.1:3080/?token=1', 'sid=1', injections, fetchScript)
    expect(snapshot?.read('/plugins/??app/client.js&rev=abc')).toBe('body')
    const other = desktopShellSnapshot('0.2.1-rc.2', injections, { '/plugins/??app/client.js&rev=next': 'body' })
    expect(snapshot).toBeDefined()
    expect(sameShellScripts(snapshot!, other)).toBe(false)
    expect(sameShellScripts(snapshot!, snapshot!)).toBe(true)
    const missing = await captureDesktopShellSnapshot('0.2.1-rc.2', 'http://127.0.0.1:3080/', '', [
      { kind: 'script-src', src: 'plugins/??app/client.js&rev=missing' },
    ], fetchScript)
    expect(missing).toBeUndefined()
  })

  it('continues a cached boot when every remaining entry is only waiting', () => {
    const pending = 'web boot: 2 entries did not activate\nchat: pending (waiting for services: locale)\nfiles: pending (waiting for service: layout)'
    expect(desktopBootCanContinue(pending)).toBe(true)
    expect(desktopBootCanContinue('web boot: 1 entry did not activate\nlocale: failed')).toBe(false)
    expect(desktopBootCanContinue('web boot: 1 entry did not activate\nlocale: import failed: missing')).toBe(false)
  })

  it('reads live revisions from the boot graph', () => {
    const revisions = pluginScriptRevisions([
      { kind: 'global', name: '__DSH_BOOT__', value: { entries: [
        { id: '@scope/preview', url: 'plugins/??@scope/preview/client.js&rev=new', rev: 'new' },
        { id: '@scope/other', url: 'plugins/??@scope/other/client.js&rev=b', rev: 'b' },
      ], batches: [{ phase: 'bootstrap', rev: 'batch' }] } },
    ])
    expect([...revisions]).toEqual([['@scope/preview', 'new'], ['@scope/other', 'b']])
  })

  it('rewrites only stale on-demand chunk revisions', () => {
    const revisions = pluginScriptRevisions([{ value: { entries: [{ id: '@scope/preview', rev: 'live' }] } }])
    const stale = rewriteStalePluginRevision(
      new Request('dsh-app://app/plugins/@scope/preview/client.pdf.js?rev=cached', {
        headers: { origin: 'dsh-app://app' },
      }),
      revisions,
    )
    expect(stale.url).toBe('dsh-app://app/plugins/@scope/preview/client.pdf.js?rev=live')
    expect(stale.headers.get('origin')).toBe('dsh-app://app')
    const current = new Request('dsh-app://app/plugins/@scope/preview/client.pdf.js?rev=live')
    expect(rewriteStalePluginRevision(current, revisions)).toBe(current)
    const combo = new Request('dsh-app://app/plugins/??@scope/preview/client.js&rev=cached')
    expect(rewriteStalePluginRevision(combo, revisions)).toBe(combo)
    const unknown = new Request('dsh-app://app/plugins/@scope/missing/client.js?rev=cached')
    expect(rewriteStalePluginRevision(unknown, revisions)).toBe(unknown)
    const unversioned = new Request('dsh-app://app/plugins/@scope/preview/client.pdf.js')
    expect(rewriteStalePluginRevision(unversioned, revisions)).toBe(unversioned)
  })
})
