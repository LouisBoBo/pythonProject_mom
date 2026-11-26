import assert from 'node:assert/strict'
import test from 'node:test'
import {
  companyDocument, companyHttpFallback, localTarballUrl, npmProxyTarget, packageRegistryUrl,
  pinnedDnsLookup, publicHttpUrl, publicRedirectTarget, publicRedirectUrl, rewritePackumentTarballs,
  transientNetworkError, withoutTrailingVersion,
} from './company-market-bridge.mjs'

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

test('a reset TLS company registry falls back to the same path on port 80', () => {
  assert.equal(
    companyHttpFallback('https://175.178.238.31:8443/dsh-plugins/npm/@zhongruan%2Fdsh-mom-docs'),
    'http://175.178.238.31/dsh-plugins/npm/@zhongruan%2Fdsh-mom-docs',
  )
  assert.equal(companyHttpFallback('http://175.178.238.31/dsh-plugins/npm/pkg'), undefined)
  assert.equal(transientNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(transientNetworkError(new Error('rejected npm path')), false)
})

test('port 80 is accepted only when it is a package document', () => {
  assert.equal(companyDocument('text/html', Buffer.from('<html>not the registry</html>')), false)
  assert.equal(companyDocument('application/json', Buffer.from(JSON.stringify({ name: '@zhongruan/dsh-mom-docs' }))), true)
  assert.equal(companyDocument('application/octet-stream', Buffer.from([0x1f, 0x8b, 0x08, 0x00])), true)
  assert.equal(companyDocument('application/json', Buffer.from('not json')), false)
})

test('packument tarballs are served from the local bridge', () => {
  const bases = [
    'https://175.178.238.31:8443/dsh-plugins/npm/',
    'http://175.178.238.31/dsh-plugins/npm/',
  ]
  const local = 'http://127.0.0.1:13090/npm/'
  assert.equal(
    localTarballUrl('http://175.178.238.31/dsh-plugins/npm/@zhongruan/dsh-mom-docs/-/dsh-mom-docs-0.1.9.tgz', local, bases),
    'http://127.0.0.1:13090/npm/@zhongruan/dsh-mom-docs/-/dsh-mom-docs-0.1.9.tgz',
  )
  assert.equal(
    localTarballUrl('https://registry.npmmirror.com/left-pad/-/left-pad-1.0.0.tgz', local, bases),
    undefined,
  )
  assert.equal(
    localTarballUrl('https://175.178.238.31:8443/dsh-plugins/npm///evil.example/pkg.tgz', local, bases),
    undefined,
  )
  const packument = {
    name: '@zhongruan/dsh-mom-docs',
    versions: {
      '0.1.9': { dist: { tarball: 'https://175.178.238.31:8443/dsh-plugins/npm/@zhongruan/dsh-mom-docs/-/dsh-mom-docs-0.1.9.tgz' } },
      '9.9.9': { dist: { tarball: 'https://evil.example/pkg.tgz' } },
    },
  }
  rewritePackumentTarballs(packument, local, bases)
  assert.equal(
    packument.versions['0.1.9'].dist.tarball,
    'http://127.0.0.1:13090/npm/@zhongruan/dsh-mom-docs/-/dsh-mom-docs-0.1.9.tgz',
  )
  assert.equal(packument.versions['9.9.9'].dist.tarball, undefined)
  const publicPackument = {
    name: '@cursor/sdk',
    versions: {
      '1.0.31': { dist: { tarball: 'https://registry.npmmirror.com/@cursor/sdk/-/sdk-1.0.31.tgz' } },
    },
  }
  rewritePackumentTarballs(publicPackument, local, bases)
  assert.equal(
    publicPackument.versions['1.0.31'].dist.tarball,
    'https://registry.npmmirror.com/@cursor/sdk/-/sdk-1.0.31.tgz',
  )
})

test('market titles do not keep a trailing version', () => {
  assert.equal(
    withoutTrailingVersion('专家·技能·连接器：岗位人设、公司 SOP · 0.1.65'),
    '专家·技能·连接器：岗位人设、公司 SOP',
  )
  assert.equal(withoutTrailingVersion('专家·技能·连接器'), '专家·技能·连接器')
  assert.equal(withoutTrailingVersion('版本 0.1.65 在句子中间'), '版本 0.1.65 在句子中间')
})

test('published links are http(s) only', () => {
  assert.equal(publicHttpUrl('https://github.com/acme/plugin.git'), 'https://github.com/acme/plugin.git')
  assert.equal(publicHttpUrl('javascript:alert(1)'), undefined)
  assert.equal(publicHttpUrl('https://user:secret@example.com/plugin'), undefined)
})
