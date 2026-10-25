import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { localLoginDirectory, loginInitialized, readValidSession, submitLocalLogin } from '../src/local-login.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-local-login-'))
  directories.push(path)
  return path
}

const now = 1_700_000_000_000

it('rejects an empty submit and does not create a store', () => {
  const root = directory()
  expect(submitLocalLogin(root, { username: '  ', password: '', enterpriseKey: 'jxzr' }, now)).toEqual({
    ok: false, code: 'empty', detail: '请输入账号和密码',
  })
  expect(loginInitialized(root)).toBe(false)
  expect(readValidSession(root, now)).toBeNull()
})

it('creates the first administrator and keeps the password out of the store', () => {
  const root = directory()
  expect(loginInitialized(root)).toBe(false)
  expect(submitLocalLogin(root, { username: 'Admin', password: 'short', enterpriseKey: 'nope' }, now)).toEqual({
    ok: false, code: 'weak_password', detail: '密码至少 8 位',
  })
  expect(loginInitialized(root)).toBe(false)
  expect(submitLocalLogin(root, { username: '1bad', password: 'long-enough', enterpriseKey: 'jxzr' }, now)).toMatchObject({
    ok: false, code: 'invalid_username',
  })
  expect(submitLocalLogin(root, { username: ' Admin ', password: 'correct-password', enterpriseKey: 'qhzr' }, now)).toEqual({ ok: true })
  expect(loginInitialized(root)).toBe(true)
  expect(readValidSession(root, now)).toMatchObject({
    username: 'admin', displayName: 'admin', enterpriseKey: 'qhzr',
  })
  expect(readFileSync(join(root, 'users.json'), 'utf8')).not.toContain('correct-password')
})

it('rejects a wrong password and accepts the stored one on the next submit', () => {
  const root = directory()
  expect(submitLocalLogin(root, { username: 'admin', password: 'correct-password', enterpriseKey: 'jxzr' }, now).ok).toBe(true)
  expect(submitLocalLogin(root, { username: 'ADMIN', password: 'other-password', enterpriseKey: 'jsry' }, now)).toEqual({
    ok: false, code: 'invalid', detail: '用户名或密码错误',
  })
  expect(submitLocalLogin(root, { username: 'missing', password: 'correct-password', enterpriseKey: 'jxzr' }, now).ok).toBe(false)
  expect(submitLocalLogin(root, { username: 'admin', password: 'correct-password', enterpriseKey: 'not-a-company' }, now)).toEqual({ ok: true })
  expect(readValidSession(root, now)?.enterpriseKey).toBe('jxzr')
})

it('drops a session inside the expiry skew and ignores a corrupt user store', () => {
  const root = directory()
  expect(submitLocalLogin(root, { username: 'admin', password: 'correct-password', enterpriseKey: 'jxzr' }, now).ok).toBe(true)
  const session = readValidSession(root, now)
  expect(session).not.toBeNull()
  expect(readValidSession(root, session!.expiresAt - 30_000)).toBeNull()
  writeFileSync(join(root, 'session.json'), '{', 'utf8')
  expect(readValidSession(root, now)).toBeNull()
  writeFileSync(join(root, 'users.json'), '{', 'utf8')
  expect(loginInitialized(root)).toBe(true)
  expect(submitLocalLogin(root, { username: 'other', password: 'another-password', enterpriseKey: 'jxzr' }, now)).toEqual({
    ok: false, code: 'unreadable', detail: '登录数据无法读取',
  })
})

it('resolves the login directory from the override or user data', () => {
  expect(localLoginDirectory('C:\\user', {})).toBe(join('C:\\user', 'local-login'))
  expect(localLoginDirectory('C:\\user', { DSH_DESKTOP_LOCAL_LOGIN_DIR: '  D:\\login  ' })).toBe('D:\\login')
  expect(localLoginDirectory('C:\\user', { DSH_DESKTOP_LOCAL_LOGIN_DIR: '   ' })).toBe(join('C:\\user', 'local-login'))
  const root = directory()
  mkdirSync(root, { recursive: true })
  expect(readValidSession(join(root, 'missing'), now)).toBeNull()
})
