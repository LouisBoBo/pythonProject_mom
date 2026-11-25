import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPANY_MARKET_NPM,
  COMPANY_MARKET_NPMRC_BEGIN,
  COMPANY_RELEASE_AGE_MARKER,
  ensureCompanyMarketNpmrc,
  ensureCompanyMarketProfile,
  ensureCompanyReleaseAgeExclude,
  rewriteCompanyLockTarballs,
} from '../src/company-market.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function profile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-company-market-'))
  directories.push(directory)
  return directory
}

describe('company market profile heal', () => {
  it('writes scoped registry to the bridge so @zhongruan never hits npmmirror', () => {
    const directory = profile()
    writeFileSync(join(directory, '.npmrc'), 'registry=https://registry.npmmirror.com/\n')
    ensureCompanyMarketNpmrc(directory)
    const body = readFileSync(join(directory, '.npmrc'), 'utf8')
    expect(body).toContain(COMPANY_MARKET_NPMRC_BEGIN)
    expect(body).toContain(`registry=${COMPANY_MARKET_NPM}`)
    expect(body).toContain(`@zhongruan:registry=${COMPANY_MARKET_NPM}`)
    expect(body).toContain(`@cursor:registry=${COMPANY_MARKET_NPM}`)
    // Public default outside the company block is preserved when present before ensure.
    expect(body).toContain('registry=https://registry.npmmirror.com/')
    ensureCompanyMarketNpmrc(directory)
    expect(body.split(COMPANY_MARKET_NPMRC_BEGIN).length - 1).toBe(
      readFileSync(join(directory, '.npmrc'), 'utf8').split(COMPANY_MARKET_NPMRC_BEGIN).length - 1,
    )
    expect(readFileSync(join(directory, '.npmrc'), 'utf8').split(COMPANY_MARKET_NPMRC_BEGIN).length - 1).toBe(1)
  })

  it('creates pnpm-workspace release-age exclude and scrubs ineffective age=0', () => {
    const directory = profile()
    writeFileSync(
      join(directory, '.npmrc'),
      'minimum-release-age=0\n@zhongruan:registry=https://example.test/\n',
    )
    ensureCompanyReleaseAgeExclude(directory)
    const workspace = readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toContain(COMPANY_RELEASE_AGE_MARKER)
    expect(workspace).toContain("'@zhongruan/*'")
    expect(workspace).toContain("'@cursor/*'")
    const npmrc = readFileSync(join(directory, '.npmrc'), 'utf8')
    expect(npmrc).not.toContain('minimum-release-age=')
    expect(npmrc).toContain('@zhongruan:registry=')
  })

  it('rewrites company tarball URLs off the TLS port that resets', () => {
    const before = [
      'tarball: https://175.178.238.31:8443/dsh-plugins/npm/@zhongruan/dsh-esc/-/dsh-esc-0.1.62.tgz',
      'tarball: http://175.178.238.31/dsh-plugins/npm/@zhongruan/dsh-knowledge/-/dsh-knowledge-1.0.41.tgz',
      'tarball: https://registry.npmmirror.com/@deepseek-ai/cordis/-/cordis-4.1.0.tgz',
    ].join('\n')
    const after = rewriteCompanyLockTarballs(before)
    expect(after).toContain('tarball: http://127.0.0.1:13090/npm/@zhongruan/dsh-esc/-/dsh-esc-0.1.62.tgz')
    expect(after).toContain('tarball: http://127.0.0.1:13090/npm/@zhongruan/dsh-knowledge/-/dsh-knowledge-1.0.41.tgz')
    expect(after).toContain('tarball: https://registry.npmmirror.com/@deepseek-ai/cordis/-/cordis-4.1.0.tgz')
    expect(rewriteCompanyLockTarballs(after)).toBe(after)
  })

  it('ensureCompanyMarketProfile heals npmrc and workspace when package.json exists', () => {
    const directory = profile()
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`,
    )
    writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'tarball: https://175.178.238.31:8443/dsh-plugins/npm/@zhongruan/dsh-esc/-/dsh-esc-0.1.62.tgz\n')
    ensureCompanyMarketProfile(directory)
    expect(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8')).toContain('http://127.0.0.1:13090/npm/@zhongruan/dsh-esc/-/dsh-esc-0.1.62.tgz')
    expect(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8')).not.toContain(':8443/')
    expect(existsSync(join(directory, '.npmrc'))).toBe(true)
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).toContain('@zhongruan:registry=')
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(true)
    expect(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')).toContain(COMPANY_RELEASE_AGE_MARKER)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-experimental-plugin-market-bundle')
  })

  it('appends missing exclude entries into an existing workspace file', () => {
    const directory = profile()
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'pnpm-workspace.yaml'),
      "packages:\n  - .\n\nminimumReleaseAgeExclude:\n  - 'dshmarket'\n",
    )
    ensureCompanyReleaseAgeExclude(directory)
    const workspace = readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toContain("'@zhongruan/*'")
    expect(workspace).toContain("'@cursor/*'")
    expect(workspace).toContain("'dshmarket'")
  })
})
