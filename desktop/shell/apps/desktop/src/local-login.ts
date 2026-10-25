/** Local username/password store for the desktop welcome card. No network and no default passwords. */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ENTERPRISE_KEY, normalizeEnterpriseKey } from './login-enterprises.ts'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_SKEW_MS = 30 * 1000
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u

export interface LoginInput {
  readonly username: string
  readonly password: string
  readonly enterpriseKey: string
}

export interface LoginSession {
  readonly username: string
  readonly displayName: string
  readonly enterpriseKey: string
  readonly expiresAt: number
}

export type LoginFailureCode = 'empty' | 'uninitialized' | 'weak_password' | 'invalid_username' | 'invalid' | 'unreadable'

export type LoginResult =
  | { readonly ok: true }
  | { readonly ok: false, readonly code: LoginFailureCode, readonly detail: string }

interface StoredUser {
  readonly username: string
  readonly displayName: string
  readonly role: 'admin'
  readonly passwordHash: string
}

type UserStore =
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'ready', readonly users: readonly StoredUser[] }

function usersPath(directory: string): string {
  return join(directory, 'users.json')
}

function sessionPath(directory: string): string {
  return join(directory, 'session.json')
}

function replaceFile(path: string, body: string): void {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, body, 'utf8')
  rmSync(path, { force: true })
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function readStore(directory: string): UserStore {
  let text: string
  try {
    text = readFileSync(usersPath(directory), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'corrupt' }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { users?: unknown }).users)) return { kind: 'corrupt' }
    const users: StoredUser[] = []
    for (const row of (parsed as { users: unknown[] }).users) {
      if (typeof row !== 'object' || row === null) return { kind: 'corrupt' }
      const record = row as Record<string, unknown>
      if (typeof record.username !== 'string' || typeof record.displayName !== 'string' || record.role !== 'admin' || typeof record.passwordHash !== 'string') {
        return { kind: 'corrupt' }
      }
      users.push({
        username: record.username,
        displayName: record.displayName,
        role: 'admin',
        passwordHash: record.passwordHash,
      })
    }
    return { kind: 'ready', users }
  } catch {
    return { kind: 'corrupt' }
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

function checkPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) return false
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const expect = Buffer.from(parts[5] ?? '', 'base64url')
  if (salt.length === 0 || expect.length !== SCRYPT_KEYLEN) return false
  const actual = scryptSync(password, salt, expect.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 })
  return timingSafeEqual(actual, expect)
}

function writeSession(directory: string, session: LoginSession): void {
  mkdirSync(directory, { recursive: true })
  replaceFile(sessionPath(directory), `${JSON.stringify(session)}\n`)
}

/** @returns the unexpired local session, or null when absent, corrupt, or inside the expiry skew. */
export function readValidSession(directory: string, now = Date.now()): LoginSession | null {
  const path = sessionPath(directory)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('desktop login: session is not an object')
    const record = parsed as Record<string, unknown>
    if (typeof record.username !== 'string' || typeof record.displayName !== 'string' || typeof record.enterpriseKey !== 'string' || typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) {
      throw new Error('desktop login: session fields are invalid')
    }
    if (now >= record.expiresAt - SESSION_SKEW_MS) {
      rmSync(path, { force: true })
      return null
    }
    return {
      username: record.username,
      displayName: record.displayName,
      enterpriseKey: normalizeEnterpriseKey(record.enterpriseKey),
      expiresAt: record.expiresAt,
    }
  } catch {
    rmSync(path, { force: true })
    return null
  }
}

/** @returns whether a usable account already exists. A corrupt store stays closed so it cannot be replaced from the card. */
export function loginInitialized(directory: string): boolean {
  const store = readStore(directory)
  if (store.kind === 'missing') return false
  if (store.kind === 'corrupt') return true
  return store.users.length > 0
}

/**
 * Check the local account, or create the first administrator when the store does not exist yet.
 * An empty or corrupt store never accepts a login against a missing user.
 */
export function submitLocalLogin(directory: string, input: LoginInput, now = Date.now()): LoginResult {
  const username = input.username.trim().toLowerCase()
  const password = input.password
  if (username === '' || password === '') return { ok: false, code: 'empty', detail: '请输入账号和密码' }
  if (password.length > 256) return { ok: false, code: 'invalid', detail: '用户名或密码错误' }
  const enterpriseKey = normalizeEnterpriseKey(input.enterpriseKey)
  const store = readStore(directory)
  if (store.kind === 'corrupt') return { ok: false, code: 'unreadable', detail: '登录数据无法读取' }
  if (store.kind === 'missing' || store.users.length === 0) {
    if (!USERNAME_PATTERN.test(username)) {
      return { ok: false, code: 'invalid_username', detail: '账号须以字母开头，仅含小写字母、数字、下划线或连字符' }
    }
    if (password.length < 8) return { ok: false, code: 'weak_password', detail: '密码至少 8 位' }
    const user: StoredUser = { username, displayName: username, role: 'admin', passwordHash: hashPassword(password) }
    mkdirSync(directory, { recursive: true })
    replaceFile(usersPath(directory), `${JSON.stringify({ users: [user] })}\n`)
    writeSession(directory, { username, displayName: username, enterpriseKey, expiresAt: now + SESSION_TTL_MS })
    return { ok: true }
  }
  const user = store.users.find(item => item.username === username)
  if (user === undefined || !checkPassword(password, user.passwordHash)) {
    return { ok: false, code: 'invalid', detail: '用户名或密码错误' }
  }
  writeSession(directory, {
    username: user.username,
    displayName: user.displayName,
    enterpriseKey,
    expiresAt: now + SESSION_TTL_MS,
  })
  return { ok: true }
}

/** Drop the remembered session. The account store stays. */
export function clearLocalSession(directory: string): void {
  rmSync(sessionPath(directory), { force: true })
}

export function localLoginDirectory(userData: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_DESKTOP_LOCAL_LOGIN_DIR?.trim()
  if (override !== undefined && override !== '') return override
  return join(userData, 'local-login')
}

export { DEFAULT_ENTERPRISE_KEY }
