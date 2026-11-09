import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  clearGatewaySessionToken,
  readGatewaySessionToken,
  saveGatewaySessionToken,
  type GatewayTokenStore,
} from '../src/gateway-session-token.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-gateway-token-'))
  directories.push(path)
  return path
}

const encryptedStore: GatewayTokenStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/u, ''),
}

const plainStore: GatewayTokenStore = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('encryption unavailable')
  },
  decryptString: () => {
    throw new Error('encryption unavailable')
  },
}

it('round-trips a token through the encrypted store', () => {
  const root = directory()
  expect(saveGatewaySessionToken(root, ' tok-1 ', encryptedStore)).toBe(true)
  expect(readGatewaySessionToken(root, encryptedStore)).toBe('tok-1')
  clearGatewaySessionToken(root)
  expect(readGatewaySessionToken(root, encryptedStore)).toBeUndefined()
})

it('does not write a plaintext token when encryption is unavailable', () => {
  const root = directory()
  expect(saveGatewaySessionToken(root, 'tok-plain', plainStore)).toBe(false)
  expect(existsSync(join(root, 'session-token'))).toBe(false)
  expect(existsSync(join(root, 'session-token.plain'))).toBe(false)
  expect(readGatewaySessionToken(root, plainStore)).toBeUndefined()
})

it('scrubs a legacy plaintext token file and never returns it', () => {
  const root = directory()
  writeFileSync(join(root, 'session-token.plain'), 'legacy-secret', { mode: 0o600 })
  expect(readGatewaySessionToken(root, encryptedStore)).toBeUndefined()
  expect(existsSync(join(root, 'session-token.plain'))).toBe(false)
})

it('ignores empty tokens and leaves the directory untouched', () => {
  const root = directory()
  expect(saveGatewaySessionToken(root, '   ', encryptedStore)).toBe(false)
  expect(readGatewaySessionToken(root, encryptedStore)).toBeUndefined()
})
