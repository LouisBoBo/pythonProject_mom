import assert from 'node:assert/strict'
import test from 'node:test'
import { npmProxyTarget, packageRegistryUrl, publicHttpUrl, publicRedirectUrl } from './company-market-bridge.mjs'

test('package names stay on the registry', () => {
  const url = new URL(packageRegistryUrl('http://127.0.0.1/dsh-plugins/npm/', '@zr/dsh-tool'))
  assert.equal(url.pathname, '/dsh-plugins/npm/%40zr%2Fdsh-tool')
  assert.throws(() => packageRegistryUrl('http://127.0.0.1/npm/', '../admin'))
  assert.throws(() => packageRegistryUrl('http://127.0.0.1/npm/', 'pkg/../../admin'))
  assert.throws(() => packageRegistryUrl('file:///tmp/', 'pkg'))
})

test('company packages stay on the company registry and other dependencies use the public registry', () => {
  const company = 'http://127.0.0.1/dsh-plugins/npm/'
  const publicRegistry = 'https://registry.example/'
  assert.equal(
    npmProxyTarget('/npm/@zhongruan%2Fdsh-knowledge', company, publicRegistry),
    'http://127.0.0.1/dsh-plugins/npm/@zhongruan%2Fdsh-knowledge',
  )
  assert.equal(
    npmProxyTarget('/npm/@deepseek-ai%2Fschemastery', company, publicRegistry),
    'https://registry.example/@deepseek-ai%2Fschemastery',
  )
  assert.throws(() => npmProxyTarget('/npm/../admin', company, publicRegistry))
  assert.throws(() => npmProxyTarget('/health', company, publicRegistry))
})

test('registry redirects stay on public http(s) hosts', () => {
  assert.equal(
    publicRedirectUrl('https://cdn.npmmirror.com/packages/left-pad.tgz', 'https://registry.example/left-pad'),
    'https://cdn.npmmirror.com/packages/left-pad.tgz',
  )
  assert.throws(() => publicRedirectUrl('http://127.0.0.1/secret', 'https://registry.example/pkg'))
  assert.throws(() => publicRedirectUrl('http://169.254.169.254/latest', 'https://registry.example/pkg'))
  assert.throws(() => publicRedirectUrl('file:///etc/passwd', 'https://registry.example/pkg'))
})

test('published links are http(s) only', () => {
  assert.equal(publicHttpUrl('https://github.com/acme/plugin.git'), 'https://github.com/acme/plugin.git')
  assert.equal(publicHttpUrl('javascript:alert(1)'), undefined)
  assert.equal(publicHttpUrl('https://user:secret@example.com/plugin'), undefined)
})
