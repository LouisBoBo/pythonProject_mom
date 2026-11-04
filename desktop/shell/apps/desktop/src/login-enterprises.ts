/** Enterprise choices shown on the local login card. Keys are display-only. */

export const LOGIN_ENTERPRISES = [
  { key: 'jsry', label: '江苏软云' },
  { key: 'jxzr', label: '江西中软' },
  { key: 'qhzr', label: '前海中软' },
] as const

export const DEFAULT_ENTERPRISE_KEY = 'jxzr'

/**
 * Enterprise CID (decimal) each card key signs in as.
 * Empty means the server value has not been supplied yet: the login body omits
 * `Enterprise`, which the server reads as 0.
 */
const ENTERPRISE_CIDS: Readonly<Record<string, string>> = {
  jsry: '',
  jxzr: '',
  qhzr: '',
}

export function normalizeEnterpriseKey(key: string): string {
  return LOGIN_ENTERPRISES.some(item => item.key === key) ? key : DEFAULT_ENTERPRISE_KEY
}

/** @param key - card enterprise key. @returns the decimal CID, or empty while unmapped. */
export function enterpriseCid(key: string): string {
  return ENTERPRISE_CIDS[normalizeEnterpriseKey(key)] ?? ''
}
