/**
 * Convert company plugins.json → DSH market index format 1, and serve it.
 * Catalog: http://175.178.238.31/dsh-plugins/plugins.json
 * npm:     http://175.178.238.31/dsh-plugins/npm/
 *
 * This bridge only adapts market metadata. Plugin behavior/UI fixes belong in
 * each plugin's own repository — do not patch plugin code from this repo.
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CATALOG = process.env.ZR_DSH_MARKET_CATALOG ?? 'http://175.178.238.31/dsh-plugins/plugins.json'
const NPM = (process.env.ZR_DSH_MARKET_NPM ?? 'http://175.178.238.31/dsh-plugins/npm/').replace(/\/?$/, '/')
const HOST = process.env.ZR_DSH_MARKET_HOST ?? '127.0.0.1'
const PORT = Number(process.env.ZR_DSH_MARKET_PORT ?? '13090')
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
        source: { type: 'npm', registry: NPM },
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
      res.end(JSON.stringify({ ok: true, catalog: CATALOG, npm: NPM }))
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
