/** Enterprise choices shown on the local login card. Keys are display-only. */

export const LOGIN_ENTERPRISES = [
  { key: 'jsry', label: '江苏软云' },
  { key: 'jxzr', label: '江西中软' },
  { key: 'qhzr', label: '前海中软' },
] as const

export type LoginEnterpriseKey = (typeof LOGIN_ENTERPRISES)[number]['key']

export const DEFAULT_ENTERPRISE_KEY: LoginEnterpriseKey = 'jxzr'

/**
 * Built-in enterprise CID (decimal) each card key signs in as.
 * Empty means the server value has not been baked into the build yet.
 * Runtime overrides: `ZR_ENTERPRISE_CID_JSRY` / `_JXZR` / `_QHZR`.
 */
const ENTERPRISE_CIDS: Readonly<Record<LoginEnterpriseKey, string>> = {
  jsry: '',
  jxzr: '',
  qhzr: '',
}

const ENTERPRISE_CID_ENV: Readonly<Record<LoginEnterpriseKey, string>> = {
  jsry: 'ZR_ENTERPRISE_CID_JSRY',
  jxzr: 'ZR_ENTERPRISE_CID_JXZR',
  qhzr: 'ZR_ENTERPRISE_CID_QHZR',
}

export function normalizeEnterpriseKey(key: string): LoginEnterpriseKey {
  return LOGIN_ENTERPRISES.some(item => item.key === key) ? key as LoginEnterpriseKey : DEFAULT_ENTERPRISE_KEY
}

/**
 * Accept only a positive decimal enterprise CID the server can write into JWT.
 * @param raw - configured or environment value.
 * @returns the trimmed digits, or empty when absent/invalid.
 */
export function normalizeEnterpriseCid(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  return /^[1-9]\d*$/u.test(value) ? value : ''
}

/**
 * String environment map. This file is also typechecked by the client build,
 * which does not load `@types/node`, so the map stays structural.
 */
type EnterpriseEnv = { readonly [key: string]: string | undefined }

/**
 * Resolve the enterprise CID for a login-card key.
 * Environment overrides win so ops can stamp CIDs without a rebuild.
 * @param key - card enterprise key.
 * @param env - process environment.
 * @returns the decimal CID, or empty while unmapped.
 */
export function enterpriseCid(key: string, env: EnterpriseEnv = process.env): string {
  const normalized = normalizeEnterpriseKey(key)
  const fromEnv = normalizeEnterpriseCid(env[ENTERPRISE_CID_ENV[normalized]])
  if (fromEnv !== '') return fromEnv
  return normalizeEnterpriseCid(ENTERPRISE_CIDS[normalized])
}
