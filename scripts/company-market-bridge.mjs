/**
 * Convert company plugins.json → DSH market index format 1, and serve it.
 * Catalog: http://175.178.238.31/dsh-plugins/plugins.json
 * npm:     http://175.178.238.31/dsh-plugins/npm/
 *
 * This bridge only adapts market metadata. Plugin behavior/UI fixes belong in
 * each plugin's own repository — do not patch plugin code from this repo.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CATALOG = process.env.ZR_DSH_MARKET_CATALOG ?? 'http://175.178.238.31/dsh-plugins/plugins.json'
const NPM = (process.env.ZR_DSH_MARKET_NPM ?? 'http://175.178.238.31/dsh-plugins/npm/').replace(/\/?$/, '/')
const PUBLIC_NPM = (process.env.ZR_DSH_MARKET_PUBLIC_NPM ?? 'https://registry.npmmirror.com/').replace(/\/?$/, '/')
const HOST = process.env.ZR_DSH_MARKET_HOST ?? '127.0.0.1'
const PORT = Number(process.env.ZR_DSH_MARKET_PORT ?? '13090')
/** Registry the desktop installer asks. Company packages stay on NPM; every other dependency is fetched from PUBLIC_NPM. */
const LOCAL_NPM = `http://${HOST}:${PORT}/npm/`
const OUT = process.env.ZR_DSH_MARKET_OUT
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'var', 'company-market', 'index.json')

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'error' })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

function publishSeconds(iso) {
  if (typeof iso !== 'string') return Math.floor(Date.now() / 1000)
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000)
  return Math.floor(ms / 1000)
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

function assertHttpUrl(value, label) {
  let url
  try { url = new URL(value) } catch { throw new Error(`${label} is not an absolute URL`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`)
  }
  if (url.username || url.password) throw new Error(`${label} must not carry credentials`)
  return url
}

/** Registry URL for one package name. Rejects path segments that leave the registry. */
export function packageRegistryUrl(registry, name) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
    throw new Error('invalid package name')
  }
  const base = assertHttpUrl(registry, 'npm registry')
  const encoded = name.split('/').map(part => encodeURIComponent(part)).join('%2F')
  const url = new URL(encoded, base.href.endsWith('/') ? base.href : `${base.href}/`)
  if (url.origin !== base.origin) throw new Error('package URL left the registry')
  return url.href
}

/**
 * Where one installer request under `/npm/` is fetched.
 * `@zhongruan` packages stay on the company registry. Everything else goes to the public registry,
 * because a market install passes this bridge as pnpm's only `--registry`.
 * @param {string} requestPath pathname beginning with `/npm/`, still percent-encoded
 * @param {string} companyRegistry
 * @param {string} publicRegistry
 * @returns {string} absolute upstream URL
 */
export function npmProxyTarget(requestPath, companyRegistry = NPM, publicRegistry = PUBLIC_NPM) {
  if (!requestPath.startsWith('/npm/')) throw new Error('rejected npm path')
  const suffix = requestPath.slice('/npm/'.length)
  if (suffix === '' || suffix.includes('\\') || suffix.startsWith('/') || suffix.includes('\0')) {
    throw new Error('rejected npm path')
  }
  let decoded
  try { decoded = decodeURIComponent(suffix) } catch { throw new Error('rejected npm path') }
  if (decoded.includes('\\') || decoded.startsWith('/') || decoded.includes('\0')) throw new Error('rejected npm path')
  // Guard against `.` / `..` / empty path segments (URL-encoded or literal).
  const segmentBad = seg => seg === '.' || seg === '..' || seg === ''
  for (const seg of suffix.split('/')) if (segmentBad(seg)) throw new Error('rejected npm path')
  for (const seg of decoded.split('/')) if (segmentBad(seg)) throw new Error('rejected npm path')
  const base = decoded.startsWith('@zhongruan/') ? companyRegistry : publicRegistry
  const root = new URL(base.endsWith('/') ? base : `${base}/`)
  const target = new URL(suffix, root)
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) {
    throw new Error('rejected npm path')
  }
  return target.href
}

/** Decide whether a hostname resolves to a private, loopback, or otherwise blocked address.
 *  WhatWG URL passes us the canonicalised hostname (e.g. [::ffff:127.0.0.1] → [::ffff:7f00:1]),
 *  so the IPv4-mapped branch must read the packed 32-bit value after `::ffff:` as hex,
 *  not re-match the original dotted-decimal form. */
function blockedRedirectHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  if (host.includes(':')) {
    if (host === '::1') return true
    if (host.startsWith('fe80:')) return true
    if (host.startsWith('fc') || host.startsWith('fd')) return true
    // IPv4-mapped ::ffff:XXXX:XXXX — unpack the trailing 32-bit hex into an IPv4
    if (host.startsWith('::ffff:')) {
      const tail = host.slice('::ffff:'.length)
      const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
      if (hexMatch) {
        const hi = parseInt(hexMatch[1], 16)
        const lo = parseInt(hexMatch[2], 16)
        return isPrivateIpv4Bits((hi << 16) | lo)
      }
      // Fallback: dotted-decimal form (some parsers keep it)
      const dots = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail)
      if (dots) return isPrivateIpv4Bits(
        (Number(dots[1]) << 24) | (Number(dots[2]) << 16) | (Number(dots[3]) << 8) | Number(dots[4]),
      )
    }
    return false
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  const parts = match.slice(1).map(Number)
  if (parts.some(part => part > 255)) return true
  const packed = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
  return isPrivateIpv4Bits(packed)
}

/** Check packed 32-bit IPv4 integer against all private / loopback / reserved ranges. */
function isPrivateIpv4Bits(packed) {
  const a = (packed >>> 24) & 0xff
  const b = (packed >>> 16) & 0xff
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true // multicast 224.0.0.0/4 + reserved 240.0.0.0/4
  return false
}

/** Redirect target an installer may follow. Private, loopback, and non-http locations are rejected. */
export function publicRedirectUrl(location, current) {
  const url = new URL(location, current)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('rejected redirect')
  if (url.username || url.password) throw new Error('rejected redirect')
  if (blockedRedirectHost(url.hostname)) throw new Error('rejected redirect')
  return url.href
}

async function fetchPublic(target, accept) {
  let current = target
  for (let hop = 0; hop < 5; hop += 1) {
    const upstream = await fetch(current, { headers: { accept }, redirect: 'manual' })
    if (upstream.status < 300 || upstream.status >= 400) return upstream
    const location = upstream.headers.get('location')
    await upstream.body?.cancel()
    if (!location) return upstream
    current = publicRedirectUrl(location, current)
  }
  throw new Error('rejected redirect')
}

/** http(s) link safe to publish, or undefined when the catalog value is not one. */
export function publicHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const url = assertHttpUrl(value, 'link')
    return url.href
  } catch {
    return undefined
  }
}

function titleFromName(name) {
  const short = name.includes('/') ? name.split('/').pop() : name
  return short.replace(/^dsh-/, '').replace(/-/g, ' ')
}

async function packageMeta(name) {
  return fetchJson(packageRegistryUrl(NPM, name))
}

async function buildIndex() {
  const catalog = await fetchJson(CATALOG)
  const categories = {}
  for (const [id, title] of Object.entries(catalog.categories ?? {})) {
    categories[id] = {
      title: typeof title === 'string' ? { en: title, zh: title } : {
        en: title.en ?? id,
        zh: title.zh ?? title.en ?? id,
      },
    }
  }
  if (Object.keys(categories).length === 0) {
    categories.tools = { title: { en: 'Tools', zh: '工具与能力' } }
  }

  const plugins = []
  for (const row of catalog.plugins ?? []) {
    const name = row.npm ?? row.name
    if (typeof name !== 'string' || name.length === 0) continue
    let meta
    try { meta = await packageMeta(name) } catch (error) {
      console.warn(`skip ${name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const version = row.version ?? meta['dist-tags']?.latest
    const manifest = meta.versions?.[version]
    if (!manifest) {
      console.warn(`skip ${name}: version ${version} missing on npm`)
      continue
    }
    const enginesDsh = manifest.engines?.dsh
      ?? manifest.peerDependencies?.['@deepseek-ai/dsh']
      ?? '*'
    const desc = row.description ?? {}
    const description = {
      en: typeof desc === 'string' ? desc : (desc.en ?? manifest.description ?? name),
      zh: typeof desc === 'string' ? desc : (desc.zh ?? desc.en ?? manifest.description ?? name),
    }
    const title = {
      en: titleFromName(name),
      zh: titleFromName(name),
    }
    if (manifest.dshMarket) {
      if (manifest.dshMarket.en) title.en = String(manifest.dshMarket.en).slice(0, 80)
      if (manifest.dshMarket.zh) title.zh = String(manifest.dshMarket.zh).slice(0, 80)
    }
    const page = publicHttpUrl(row.url)
    const source = typeof row.url === 'string' ? publicHttpUrl(row.url.replace(/\.git$/, '')) : undefined
    plugins.push({
      name,
      title,
      description,
      author: typeof row.owner === 'string' && row.owner.trim() ? row.owner.trim() : '中软',
      homepage: page,
      repository: source !== undefined && row.url.includes('github.com') ? { url: source } : undefined,
      metadata: {
        category: typeof row.category === 'string' && categories[row.category] ? row.category : 'tools',
        keywords: Array.isArray(manifest.keywords) ? manifest.keywords.map(String) : ['dsh-plugin'],
      },
      'dist-tags': { latest: version },
      versions: [{
        version,
        publishTimestamp: publishSeconds(meta.time?.[version] ?? row.added),
        source: { type: 'npm', registry: LOCAL_NPM },
        engines: { dsh: enginesDsh },
      }],
    })
  }

  return {
    format: 1,
    title: { en: 'Zhongruan DSH Plugins', zh: '中软 DSH 插件市场' },
    description: {
      en: 'Company plugin market for 江西中软工作助手',
      zh: '江西中软工作助手公司插件市场',
    },
    metadata: { categories },
    plugins,
  }
}

let cache = { at: 0, body: '' }
const TTL_MS = 60_000

async function indexBody() {
  if (Date.now() - cache.at < TTL_MS && cache.body) return cache.body
  const index = await buildIndex()
  const body = `${JSON.stringify(index, null, 2)}\n`
  cache = { at: Date.now(), body }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, body)
  console.log(`index plugins=${index.plugins.length} → ${OUT}`)
  return body
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly && process.argv.includes('--once')) {
  await indexBody()
  process.exit(0)
}

if (invokedDirectly) {
  const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && (path === '/' || path === '/index.json')) {
      const body = await indexBody()
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(body)
      return
    }
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, catalog: CATALOG, npm: NPM, publicNpm: PUBLIC_NPM, installRegistry: LOCAL_NPM }))
      return
    }
    if (req.method === 'GET' && path.startsWith('/npm/')) {
      const target = npmProxyTarget(path)
      const upstream = await fetchPublic(target, req.headers.accept ?? '*/*')
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      if (upstream.body === null) {
        res.end()
        return
      }
      Readable.fromWeb(upstream.body).pipe(res)
      return
    }
    res.writeHead(404)
    res.end('not found')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'market index is unavailable' }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`company market bridge http://${HOST}:${PORT}/index.json`)
  console.log(`catalog ${CATALOG}`)
  console.log(`npm ${NPM}`)
})
}
