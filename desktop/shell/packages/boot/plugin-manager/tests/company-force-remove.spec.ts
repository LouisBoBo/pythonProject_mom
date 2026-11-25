import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forceRemoveCompanyPlugin,
  isForceRemovableCompanyPackage,
} from '../src/company-force-remove.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function profile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-force-remove-'))
  directories.push(directory)
  return directory
}

describe('company force remove', () => {
  it('only allows @zhongruan packages', () => {
    expect(isForceRemovableCompanyPackage('@zhongruan/dsh-cursor-chat')).toBe(true)
    expect(isForceRemovableCompanyPackage('@deepseek-ai/dsh-base')).toBe(false)
    expect(isForceRemovableCompanyPackage('left-pad')).toBe(false)
  })

  it('refuses to force-remove core packages', () => {
    const directory = profile()
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0' },
    }, undefined, 2)}\n`)
    const result = forceRemoveCompanyPlugin(directory, '@deepseek-ai/dsh-base')
    expect(result.ok).toBe(false)
    expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh-base']).toBe('1.0.0')
  })

  it('removes company dependency, bundle entry, and node_modules package', () => {
    const directory = profile()
    const name = '@zhongruan/dsh-cursor-chat'
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      dependencies: { [name]: '0.3.43', '@deepseek-ai/dsh-base': '1.0.0' },
      dsh: { profile: { bundles: [name, '@deepseek-ai/dsh-base'] } },
    }, undefined, 2)}\n`)
    const pkgDir = join(directory, 'node_modules', '@zhongruan', 'dsh-cursor-chat')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{"name":"@zhongruan/dsh-cursor-chat"}\n')
    mkdirSync(join(directory, 'node_modules', '@zhongruan', 'dsh-cursor-chat_tmp_1'), { recursive: true })

    const result = forceRemoveCompanyPlugin(directory, name)
    expect(result.ok).toBe(true)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies[name]).toBeUndefined()
    expect(manifest.dependencies['@deepseek-ai/dsh-base']).toBe('1.0.0')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(existsSync(pkgDir)).toBe(false)
    expect(existsSync(join(directory, 'node_modules', '@zhongruan', 'dsh-cursor-chat_tmp_1'))).toBe(false)
  })
})
