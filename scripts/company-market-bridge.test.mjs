import assert from 'node:assert/strict'
import test from 'node:test'
import { npmProxyTarget, packageRegistryUrl, pinnedDnsLookup, publicHttpUrl, publicRedirectTarget, publicRedirectUrl } from './company-market-bridge.mjs'

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

test('redirect names that resolve to a private address are rejected', async () => {
  const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }]
  assert.equal(
    await publicRedirectTarget('https://cdn.example/pkg.tgz', 'https://registry.example/pkg', publicLookup),
    'https://cdn.example/pkg.tgz',
  )
  const calls = []
  const privateLookup = async (host) => {
    calls.push(host)
    return [{ address: '127.0.0.1', family: 4 }]
  }
  await assert.rejects(
    () => publicRedirectTarget('https://cdn.example/pkg.tgz', 'https://registry.example/pkg', privateLookup),
    /rejected redirect/,
  )
  assert.deepEqual(calls, ['cdn.example'])
  await assert.rejects(
    () => publicRedirectTarget('https://cdn.example/pkg.tgz', 'https://registry.example/pkg', async () => [{ address: '10.1.1.1', family: 4 }]),
    /rejected redirect/,
  )
  await assert.rejects(
    () => publicRedirectTarget('https://cdn.example/pkg.tgz', 'https://registry.example/pkg', async () => [{ address: '169.254.169.254', family: 4 }]),
    /rejected redirect/,
  )
  await assert.rejects(
    () => publicRedirectTarget('https://cdn.example/pkg.tgz', 'https://registry.example/pkg', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]),
    /rejected redirect/,
  )
  await assert.rejects(
    () => publicRedirectTarget('https://cdn.example/pkg.tgz', 'https://registry.example/pkg', async () => {
      throw new Error('dns down')
    }),
    /rejected redirect/,
  )
  let lookedUp = false
  await assert.rejects(
    () => publicRedirectTarget('http://127.0.0.1/secret', 'https://registry.example/pkg', async () => {
      lookedUp = true
      return [{ address: '127.0.0.1', family: 4 }]
    }),
    /rejected redirect/,
  )
  assert.equal(lookedUp, false)
})

test('a checked redirect connects only to the addresses already accepted', () => {
  const lookup = pinnedDnsLookup(['1.1.1.1', '2606:4700:4700::1111'])
  const all = []
  lookup('cdn.example', { all: true }, (error, records) => {
    assert.equal(error, null)
    all.push(...records)
  })
  assert.deepEqual(all, [
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])
  let single
  lookup('cdn.example', {}, (error, address, family) => {
    assert.equal(error, null)
    single = { address, family }
  })
  assert.deepEqual(single, { address: '1.1.1.1', family: 4 })
  assert.throws(() => pinnedDnsLookup([]))
})

test('published links are http(s) only', () => {
  assert.equal(publicHttpUrl('https://github.com/acme/plugin.git'), 'https://github.com/acme/plugin.git')
  assert.equal(publicHttpUrl('javascript:alert(1)'), undefined)
  assert.equal(publicHttpUrl('https://user:secret@example.com/plugin'), undefined)
})
