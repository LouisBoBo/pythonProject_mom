/**
 * Persist the company gateway access token across app restarts.
 *
 * The Host credential store is write-only from this process, so sign-out after a
 * remembered session needs a local copy. Only Electron `safeStorage` is used:
 * when OS encryption is unavailable the token stays in memory for this launch
 * (same as before persistence existed). Never write a plaintext token file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GatewayTokenStore {
  readonly isEncryptionAvailable: () => boolean
  readonly encryptString: (plain: string) => Buffer
  readonly decryptString: (encrypted: Buffer) => string
}

const TOKEN_FILE = 'session-token'
/** Legacy plaintext fallback from an earlier build; always deleted on touch. */
const LEGACY_PLAIN_FILE = 'session-token.plain'

function encryptedPath(directory: string): string {
  return join(directory, TOKEN_FILE)
}

function legacyPlainPath(directory: string): string {
  return join(directory, LEGACY_PLAIN_FILE)
}

function scrubLegacyPlain(directory: string): void {
  rmSync(legacyPlainPath(directory), { force: true })
}

/**
 * Save the gateway access token for later UserLogout after restart.
 * No-ops when the OS cannot encrypt the value.
 * @param directory - `<userData>/gateway`.
 * @param token - access token from a successful login.
 * @param store - Electron safeStorage, or a test double.
 * @returns whether the token was written under encryption.
 */
export function saveGatewaySessionToken(
  directory: string,
  token: string,
  store: GatewayTokenStore,
): boolean {
  const trimmed = token.trim()
  scrubLegacyPlain(directory)
  if (trimmed === '') return false
  if (!store.isEncryptionAvailable()) return false
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  writeFileSync(encryptedPath(directory), store.encryptString(trimmed))
  return true
}

/**
 * Read the token saved by {@link saveGatewaySessionToken}.
 * @param directory - `<userData>/gateway`.
 * @param store - Electron safeStorage, or a test double.
 * @returns the token, or undefined when absent, undecryptable, or only a legacy plaintext file remains.
 */
export function readGatewaySessionToken(
  directory: string,
  store: GatewayTokenStore,
): string | undefined {
  scrubLegacyPlain(directory)
  try {
    if (!existsSync(encryptedPath(directory))) return undefined
    if (!store.isEncryptionAvailable()) return undefined
    const plain = store.decryptString(readFileSync(encryptedPath(directory))).trim()
    return plain === '' ? undefined : plain
  } catch (error) {
    console.error('desktop model gateway: session token could not be read', error)
    return undefined
  }
}

/** Drop any persisted gateway token (encrypted or legacy plaintext). */
export function clearGatewaySessionToken(directory: string): void {
  rmSync(encryptedPath(directory), { force: true })
  scrubLegacyPlain(directory)
}
