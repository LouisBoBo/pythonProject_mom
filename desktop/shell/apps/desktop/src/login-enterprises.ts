/** Enterprise choices shown on the local login card. Keys are display-only. */

export const LOGIN_ENTERPRISES = [
  { key: 'jsry', label: '江苏软云' },
  { key: 'jxzr', label: '江西中软' },
  { key: 'qhzr', label: '前海中软' },
] as const

export const DEFAULT_ENTERPRISE_KEY = 'jxzr'

export function normalizeEnterpriseKey(key: string): string {
  return LOGIN_ENTERPRISES.some(item => item.key === key) ? key : DEFAULT_ENTERPRISE_KEY
}
