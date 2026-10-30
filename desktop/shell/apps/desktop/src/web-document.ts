/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Cookie } from 'electron'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'
/** Painted with the first HTML frame, before the client bundle or its stylesheets. */
const STARTUP_STYLE = '<style data-dsh-startup>html,body,#root{height:100%;margin:0}body{background:#f9fafb;color:#0f1115;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}[data-dsh-boot]{height:100%;display:grid;place-items:center;background:#f9fafb}[data-dsh-boot-card]{display:flex;flex-direction:column;align-items:center;gap:16px}[data-dsh-boot-word]{font-size:16px;line-height:24px;font-weight:600}[data-dsh-boot-hint]{font-size:12px;line-height:18px;color:#81858c}@media (prefers-color-scheme:dark){body,[data-dsh-boot]{background:#1b1b1c;color:#f9fafb}[data-dsh-boot-hint]{color:#adb2b8}}</style>'
const STARTUP_MARKUP = '<div data-dsh-boot=""><div data-dsh-boot-card><div data-dsh-boot-word>江西中软工作助手</div><div data-dsh-boot-hint>正在启动…</div></div></div>'

/**
 * Put the startup screen in the first HTML paint and stop stylesheets from delaying it.
 * @param html - Built application document.
 * @returns The same document with the boot script, startup screen, and non-blocking stylesheets.
 */
export function paintStartupDocument(html: string): string {
  let next = html.includes('__DSH_BOOT_READY__') ? html : html.replace('<head>', '<head>' + BOOT)
  if (!next.includes('data-dsh-startup')) next = next.replace('<head>', '<head>' + STARTUP_STYLE)
  next = next.replace(/<link\b(?=[^>]*\brel=(["'])stylesheet\1)(?![^>]*\bmedia=)/gi, '<link media="print" onload="this.media=\'all\'"')
  if (next.includes('data-dsh-boot')) return next
  if (/<div id="root">\s*<\/div>/.test(next)) return next.replace(/<div id="root">\s*<\/div>/, `<div id="root">${STARTUP_MARKUP}</div>`)
  if (next.includes('<div id="root">')) return next.replace('<div id="root">', `<div id="root">${STARTUP_MARKUP}`)
  return next.replace('<body>', `<body>${STARTUP_MARKUP}`)
}

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? paintStartupDocument(body.toString()) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Recognize a Host authentication cookie left in the browser jar by an earlier launch.
 * Every launch issues a fresh cookie name, Chromium resends all of them to the loopback Host,
 * and the Host rejects request headers over Node's 16 KiB limit, so a launch eventually fails.
 * @param cookie - Cookie stored for the loopback origin.
 * @returns Whether the cookie authenticates a Host instance that is no longer running.
 */
export function isStaleHostAuthCookie(cookie: Cookie): boolean {
  return (cookie.domain === '127.0.0.1' || cookie.domain === 'localhost') && cookie.name.startsWith('dsh-auth-')
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
