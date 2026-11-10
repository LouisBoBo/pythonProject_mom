import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootScriptsChanged, profilePluginSignature, quarantineShadowedRuntimePackages, sanitizeProfileManifestBom, watchProfilePlugins } from '../src/plugin-visibility.ts'

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

function packageAt(directory: string, version: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version }))
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

describe('profile manifest BOM', () => {
  it('strips a UTF-8 BOM so Host JSON.parse can read package.json', () => {
    const directory = profile()
    const path = join(directory, 'package.json')
    const body = `${JSON.stringify({ name: 'dsh-profile-desktop', private: true }, undefined, 2)}\n`
    writeFileSync(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]))
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).toThrow(/Unexpected token/)

    expect(sanitizeProfileManifestBom(directory)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ name: 'dsh-profile-desktop', private: true })
    expect(sanitizeProfileManifestBom(directory)).toBe(false)
  })

  it('leaves a locked or non-object BOM file alone', () => {
    const directory = profile()
    const path = join(directory, 'package.json')
    const body = `${JSON.stringify({ name: 'dsh-profile-desktop' }, undefined, 2)}\n`
    writeFileSync(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]))
    writeFileSync(join(directory, 'package.json.lock'), '1\n')
    expect(sanitizeProfileManifestBom(directory)).toBe(false)
    expect(readFileSync(path)[0]).toBe(0xEF)

    rmSync(join(directory, 'package.json.lock'))
    writeFileSync(path, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('[]\n', 'utf8')]))
    expect(sanitizeProfileManifestBom(directory)).toBe(false)
    expect(readFileSync(path)[0]).toBe(0xEF)
  })
})

describe('runtime package shadowing', () => {
  it('quarantines only profile copies whose version differs from the installation', () => {
    const root = profile()
    const dsh = join(root, 'dsh')
    const profileDir = join(root, 'profile')
    packageAt(join(dsh, 'node_modules', '@deepseek-ai', 'dsh-tools'), '0.2.1-rc.2')
    packageAt(join(dsh, 'node_modules', '@deepseek-ai', 'cordis'), '4.0.5')
    packageAt(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tools'), '0.1.1-rc.2')
    packageAt(join(profileDir, 'node_modules', '@deepseek-ai', 'cordis'), '4.0.5')
    packageAt(join(profileDir, 'node_modules', '@deepseek-ai', 'company-only'), '1.0.0')

    const moved = quarantineShadowedRuntimePackages(profileDir, dsh)

    expect(moved).toEqual(['dsh-tools@0.1.1-rc.2 (runtime 0.2.1-rc.2)'])
    expect(existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tools'))).toBe(false)
    expect(existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'cordis'))).toBe(true)
    expect(existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'company-only'))).toBe(true)
    const kept = readdirSync(join(profileDir, '.desktop-quarantine'))
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/^dsh-tools-0\.1\.1-rc\.2-/)
  })

  it('does nothing without a profile scope', () => {
    const root = profile()
    const dsh = join(root, 'dsh')
    packageAt(join(dsh, 'node_modules', '@deepseek-ai', 'dsh-tools'), '0.2.1-rc.2')
    expect(quarantineShadowedRuntimePackages(join(root, 'profile'), dsh)).toEqual([])
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
