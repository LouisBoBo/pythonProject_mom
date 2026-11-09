import { expect, it } from 'vitest'
import { enterpriseCid, normalizeEnterpriseCid, normalizeEnterpriseKey } from '../src/login-enterprises.ts'

it('keeps unknown keys on the default enterprise', () => {
  expect(normalizeEnterpriseKey('nope')).toBe('jxzr')
  expect(normalizeEnterpriseKey('qhzr')).toBe('qhzr')
})

it('rejects zero, empty, and non-decimal CIDs', () => {
  expect(normalizeEnterpriseCid('')).toBe('')
  expect(normalizeEnterpriseCid('0')).toBe('')
  expect(normalizeEnterpriseCid(' 12a ')).toBe('')
  expect(normalizeEnterpriseCid(' 8701 ')).toBe('8701')
})

it('leaves CIDs empty without env overrides so login omits Enterprise', () => {
  expect(enterpriseCid('jxzr', {})).toBe('')
  expect(enterpriseCid('jsry', {})).toBe('')
})

it('reads ZR_ENTERPRISE_CID_* overrides without changing other keys', () => {
  const env = {
    ZR_ENTERPRISE_CID_JXZR: '1001',
    ZR_ENTERPRISE_CID_JSRY: '0',
    ZR_ENTERPRISE_CID_QHZR: ' 2002 ',
  }
  expect(enterpriseCid('jxzr', env)).toBe('1001')
  expect(enterpriseCid('jsry', env)).toBe('')
  expect(enterpriseCid('qhzr', env)).toBe('2002')
})
