import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootScriptsChanged, profilePluginSignature, watchProfilePlugins } from '../src/plugin-visibility.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function profile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-plugin-visibility-'))
  directories.push(directory)
  return directory
}

function manifest(bundles: string[], dependencies: Record<string, string> = {}): string {
  return `${JSON.stringify({ dependencies, dsh: { profile: { bundles } } }, undefined, 2)}\n`
}

describe('profile plugin signature', () => {
  it('tracks installed bundles and dependency versions, not formatting', () => {
    const formatted = profilePluginSignature(manifest(['@zhongruan/dsh-knowledge'], { '@zhongruan/dsh-knowledge': '1.0.38' }))
    const compact = profilePluginSignature('{"dsh":{"profile":{"bundles":["@zhongruan/dsh-knowledge"]}},"dependencies":{"@zhongruan/dsh-knowledge":"1.0.38"}}')
    expect(formatted).toBe(compact)
    expect(profilePluginSignature(manifest(['@zhongruan/dsh-knowledge'], { '@zhongruan/dsh-knowledge': '1.0.39' }))).not.toBe(formatted)
    expect(profilePluginSignature('not json')).toBeUndefined()
  })

  it('notices when the open page is missing a plugin script the Host now serves', () => {
    const booted = ['/plugins/??@deepseek-ai/dsh-web-app/client.js&rev=1']
    const same = [{ src: 'plugins/??@deepseek-ai/dsh-web-app/client.js&rev=1' }]
    const added = [{ src: 'plugins/??@zhongruan/dsh-knowledge/client.js&rev=2' }, ...same]
    expect(bootScriptsChanged(undefined, added)).toBe(false)
    expect(bootScriptsChanged(booted, same)).toBe(false)
    expect(bootScriptsChanged(booted, added)).toBe(true)
  })
})

describe('profile plugin watch', () => {
  it('reports a finished install and waits while the profile lock is held', async () => {
    const directory = profile()
    writeFileSync(join(directory, 'package.json'), manifest(['@deepseek-ai/dsh-base']))
    const applied: string[] = []
    const watcher = watchProfilePlugins(directory, () => {
      applied.push('change')
      return true
    }, 30)
    expect(watcher).toBeDefined()
    writeFileSync(join(directory, 'package.json'), manifest(['@deepseek-ai/dsh-base', '@zhongruan/dsh-knowledge'], {
      '@zhongruan/dsh-knowledge': '1.0.38',
    }))
    await waitFor(() => applied.length === 1)

    writeFileSync(join(directory, 'package.json.lock'), '123\n')
    writeFileSync(join(directory, 'package.json'), manifest(['@deepseek-ai/dsh-base', '@zhongruan/dsh-knowledge', '@zhongruan/dsh-mom-docs']))
    await delay(80)
    expect(applied).toEqual(['change'])
    rmSync(join(directory, 'package.json.lock'))
    await waitFor(() => applied.length === 2)
    watcher?.close()
  })
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 2000) throw new Error('timed out waiting for the profile watch')
    await delay(20)
  }
}
