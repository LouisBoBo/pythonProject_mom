import assert from 'node:assert/strict'
import test from 'node:test'
import { packageRegistryUrl, publicHttpUrl } from './company-market-bridge.mjs'

test('package names stay on the registry', () => {
  const url = new URL(packageRegistryUrl('http://127.0.0.1/dsh-plugins/npm/', '@zr/dsh-tool'))
  assert.equal(url.pathname, '/dsh-plugins/npm/%40zr%2Fdsh-tool')
  assert.throws(() => packageRegistryUrl('http://127.0.0.1/npm/', '../admin'))
  assert.throws(() => packageRegistryUrl('http://127.0.0.1/npm/', 'pkg/../../admin'))
  assert.throws(() => packageRegistryUrl('file:///tmp/', 'pkg'))
})

test('published links are http(s) only', () => {
  assert.equal(publicHttpUrl('https://github.com/acme/plugin.git'), 'https://github.com/acme/plugin.git')
  assert.equal(publicHttpUrl('javascript:alert(1)'), undefined)
  assert.equal(publicHttpUrl('https://user:secret@example.com/plugin'), undefined)
})
