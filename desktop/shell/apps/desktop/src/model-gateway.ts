/**
 * Company model gateway: the welcome-card login and the pi-ai route that serves it.
 *
 * The gateway holds the vendor keys; this process only ever sees a session token
 * and model aliases. Everything here stays inert until a base URL is configured,
 * so a build without a gateway keeps the local login and the official route.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeEnterpriseKey } from './login-enterprises.ts'
import { SESSION_TTL_MS } from './local-login.ts'

/**
 * Deployment address, used when `ZR_MODEL_GATEWAY_URL` is absent.
 * Set this in a build with a fixed gateway; leave empty to keep the feature off.
 */
export const DEFAULT_GATEWAY_BASE_URL = 'https://175.178.238.31'

/** pi-ai route name requests select; also the prefix of every alias. */
export const GATEWAY_PROVIDER = 'zr-gateway'

/**
 * Credential reference the gateway session token is stored under.
 * It is not the official provider's reference: a token minted by the company
 * gateway must never be read as a DeepSeek platform key.
 */
export const GATEWAY_CREDENTIAL_REF = 'ZR_GATEWAY_TOKEN'

/**
 * Model aliases the gateway serves. Ids are aliases, never vendor model names,
 * and the capacities must match what the gateway maps each alias to. `name` is
 * the selector label: it follows the vendor's public model name so the card
 * reads like the official provider, while requests still carry only the alias.
 */
export const GATEWAY_MODELS = [
  { id: 'standard', name: 'DeepSeek-V4.1-Flash', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'deep', name: 'DeepSeek-V4-Pro', contextWindow: 128_000, maxTokens: 16_384 },
] as const

/** Generated block delimiters; re-running replaces the whole block between them. */
export const GATEWAY_PATCH_BEGIN = '# zr-model-gateway:begin (regenerated on launch; edits inside this block are lost)'
export const GATEWAY_PATCH_END = '# zr-model-gateway:end'

export interface GatewayModel {
  readonly id: string
  /** Selector label shown to the user; the request still sends only `id`. */
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
}

export interface GatewayConfig {
  /** Origin only, without a trailing slash. */
  readonly baseUrl: string
  readonly models: readonly GatewayModel[]
}

export interface GatewayLoginInput {
  readonly username: string
  readonly password: string
  readonly enterpriseKey: string
}

/** Card-safe login outcome: a success carries the token, a failure carries display copy. */
export type GatewayLoginOutcome =
  | {
      readonly ok: true
      readonly token: string
      readonly expiresAt: number
      readonly username: string
      readonly displayName: string
      readonly enterpriseKey: string
    }
  | { readonly ok: false, readonly code: string, readonly detail: string }

/** The narrow slice of `fetch` this module needs, so tests can supply a fake. */
export type GatewayFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const LOGIN_TIMEOUT_MS = 20_000

/**
 * Accept only an origin that can carry a bearer token.
 * Plain HTTP is allowed for a loopback gateway in development and nowhere else.
 * @param raw - configured base URL.
 * @returns the normalized origin, or undefined when the value is unusable.
 */
export function parseGatewayBaseUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return undefined
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  if (url.pathname !== '/' && url.pathname !== '') return undefined
  return url.origin
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Resolve the gateway from the environment, falling back to the build constant.
 * @param env - process environment.
 * @param fallback - deployment address used when the environment has none.
 * @returns the gateway, or undefined when this build has none.
 */
export function resolveGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = DEFAULT_GATEWAY_BASE_URL,
): GatewayConfig | undefined {
  const raw = (env.ZR_MODEL_GATEWAY_URL ?? fallback).trim()
  if (raw === '') return undefined
  const baseUrl = parseGatewayBaseUrl(raw)
  if (baseUrl === undefined) {
    console.error(`desktop model gateway: ignoring unusable base URL ${JSON.stringify(raw)}; HTTPS or a loopback HTTP origin is required`)
    return undefined
  }
  return { baseUrl, models: GATEWAY_MODELS }
}

/** Origin the OpenAI-compatible route targets: `{baseUrl}/v1`. */
export function gatewayChatBaseUrl(config: GatewayConfig): string {
  return `${config.baseUrl}/v1`
}

/**
 * The patch rows that register the gateway route and make it the default model.
 * `apiKeyEnv` names a credential reference, so the token never enters this file.
 * The built-in DeepSeek provider is disabled in the same block: with the
 * gateway installed there is one vendor account, and leaving the official row
 * in place presents a second, unusable provider in settings and the selector.
 * @param config - resolved gateway.
 * @returns YAML text wrapped in the generated block markers.
 */
export function gatewayPatchBlock(config: GatewayConfig): string {
  const first = config.models[0]
  return [
    GATEWAY_PATCH_BEGIN,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${GATEWAY_PROVIDER}:`,
    '        displayName: 中软模型网关',
    `        baseURL: ${gatewayChatBaseUrl(config)}`,
    '        api: openai-completions',
    `        apiKeyEnv: ${GATEWAY_CREDENTIAL_REF}`,
    '        compat:',
    '          thinkingFormat: deepseek',
    '        models:',
    ...config.models.flatMap(model => [
      `          - id: ${model.id}`,
      `            name: ${model.name}`,
      `            contextWindow: ${model.contextWindow}`,
      `            maxTokens: ${model.maxTokens}`,
    ]),
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${GATEWAY_PROVIDER}`,
    `    model: ${first?.id ?? ''}`,
    GATEWAY_PATCH_END,
  ].join('\n')
}

/**
 * Insert, replace, or leave the generated block, keeping every other row as written.
 * An untouched file that already carries this exact block comes back unchanged.
 * @param current - existing patch document.
 * @param block - {@link gatewayPatchBlock} output.
 * @returns the document to write.
 */
export function applyGatewayPatch(current: string, block: string): string {
  const start = current.indexOf(GATEWAY_PATCH_BEGIN)
  const end = start === -1 ? -1 : current.indexOf(GATEWAY_PATCH_END, start)
  if (start !== -1 && end !== -1) {
    const before = current.slice(0, start)
    const after = current.slice(end + GATEWAY_PATCH_END.length)
    return `${before}${block}${after.startsWith('\n') ? '' : '\n'}${after}`
  }
  // Only the template's own empty sequence is replaced; a `[]` inside another row is data.
  const isEmptySequence = current.replace(/^[ \t]*#[^\n]*$/gmu, '').trim() === '[]'
  if (isEmptySequence) return current.replace(/\[\][ \t]*\n?[ \t]*$/u, `${block}\n`)
  return `${current.replace(/\s*$/u, '')}\n${block}\n`
}

/**
 * Register the route in the desktop profile before the Host boots.
 * A profile without a patch file is left alone: the Host creates it on first launch.
 * @param profileDir - desktop profile directory.
 * @param config - resolved gateway.
 */
export function ensureGatewayProfile(profileDir: string, config: GatewayConfig): void {
  try {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) return
    const current = readFileSync(patchPath, 'utf8')
    const next = applyGatewayPatch(current, gatewayPatchBlock(config))
    if (next !== current) writeFileSync(patchPath, next)
  } catch (error) {
    // A profile write must never keep the app from starting; the route simply stays unregistered.
    console.error('desktop model gateway profile was not updated', error)
  }
}

/**
 * Exchange the card's credentials for a session token.
 * @param config - resolved gateway.
 * @param input - enterprise, username, and password from the card.
 * @param options - fetch implementation, clock, and timeout for tests.
 * @returns a card-safe outcome; the password is never echoed.
 */
export async function loginWithGateway(
  config: GatewayConfig,
  input: GatewayLoginInput,
  options: { fetch?: GatewayFetch; now?: number; timeoutMs?: number } = {},
): Promise<GatewayLoginOutcome> {
  const username = input.username.trim().toLowerCase()
  const password = input.password
  if (username === '' || password === '') return { ok: false, code: 'empty', detail: '请输入账号和密码' }
  if (password.length > 256) return { ok: false, code: 'invalid', detail: '用户名或密码错误' }
  const now = options.now ?? Date.now()
  const fetchImpl = options.fetch ?? defaultFetch
  let response: Awaited<ReturnType<GatewayFetch>>
  try {
    response = await fetchImpl(`${config.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ enterprise: normalizeEnterpriseKey(input.enterpriseKey), username, password }),
      signal: AbortSignal.timeout(options.timeoutMs ?? LOGIN_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, code: 'unreachable', detail: '无法连接登录服务，请检查网络后重试' }
  }
  if (response.status === 401) return { ok: false, code: 'invalid', detail: '用户名或密码错误' }
  if (response.status === 403) return { ok: false, code: 'forbidden', detail: '该账号没有登录权限' }
  if (response.status === 429) return { ok: false, code: 'busy', detail: '尝试过于频繁，请稍后再试' }
  if (!response.ok) return { ok: false, code: 'server', detail: '登录服务暂时不可用，请稍后再试' }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, code: 'server', detail: '登录服务返回了无法识别的内容' }
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, code: 'server', detail: '登录服务返回了无法识别的内容' }
  }
  const record = payload as Record<string, unknown>
  const token = record.token
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/u.test(token)) {
    return { ok: false, code: 'server', detail: '登录服务没有返回有效凭证' }
  }
  const user = typeof record.user === 'object' && record.user !== null ? record.user as Record<string, unknown> : {}
  const name = typeof user.name === 'string' && user.name.trim() !== '' ? user.name.trim() : username
  const displayName = typeof user.displayName === 'string' && user.displayName.trim() !== '' ? user.displayName.trim() : name
  const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) && record.expiresAt > now
    ? record.expiresAt
    : now + SESSION_TTL_MS
  return {
    ok: true,
    token,
    expiresAt,
    username: name,
    displayName,
    enterpriseKey: normalizeEnterpriseKey(input.enterpriseKey),
  }
}

const defaultFetch: GatewayFetch = (url, init) => fetch(url, init)
