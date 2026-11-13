/**
 * Company model gateway: the welcome-card login and the pi-ai route that serves it.
 *
 * The gateway holds the vendor keys; this process only ever sees a session token
 * and model aliases. Everything here stays inert until a base URL is configured,
 * so a build without a gateway keeps the local login and the official route.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { enterpriseCid, normalizeEnterpriseKey } from './login-enterprises.ts'
import { SESSION_TTL_MS } from './local-login.ts'

/**
 * Production (company) MOM gateway origin (login always; chat only in `prod`).
 * Used when `ZR_MODEL_GATEWAY_URL` is absent. `dev` still uses this for UserLogin.
 * The company server currently serves plain HTTP only (no TLS listener).
 */
export const DEFAULT_GATEWAY_BASE_URL = 'http://113.90.149.166:19772'

/**
 * Desktop mode switch (`DSH_DESKTOP_GATEWAY_ENV` in project `.env` or the process env).
 *
 * - unset / `prod` (default): company UserLogin + company model gateway (unchanged).
 * - `dev`: **same company UserLogin**, but model calls use a personal `DEEPSEEK_API_KEY`
 *   (no `zr-gateway` chat route). Only the model path changes.
 *
 * Explicit `ZR_MODEL_GATEWAY_URL` still overrides the login/gateway base URL
 * (including `""` to force the gateway fully off).
 */
export const GATEWAY_DESKTOP_ENV_KEY = 'DSH_DESKTOP_GATEWAY_ENV'

/** Official DeepSeek credential / env name used when {@link usesPersonalModelKey} is true. */
export const PERSONAL_MODEL_API_KEY_ENV = 'DEEPSEEK_API_KEY'

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
 * Vision: the gateway fronts DeepSeek V4 models that accept images. The Models/Get
 * catalog does not carry modalities, so {@link gatewayPatchBlock} declares
 * `defaultInput: [text, image]` on the route (pi-ai otherwise defaults to text-only
 * and the composer refuses attachments with MODEL_DOES_NOT_SUPPORT_IMAGES).
 */
export const GATEWAY_MODELS = [
  { id: 'standard', name: 'DeepSeek-V4.1-Flash', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'deep', name: 'DeepSeek-V4-Pro', contextWindow: 128_000, maxTokens: 16_384 },
] as const

/** Generated block delimiters; re-running replaces the whole block between them. */
export const GATEWAY_PATCH_BEGIN = '# zr-model-gateway:begin (regenerated on launch; edits inside this block are lost)'
export const GATEWAY_PATCH_END = '# zr-model-gateway:end'

/**
 * Legacy separate retry patch. A later `- id: llm-pi-ai` row replaces the whole
 * plugin config (loader assigns `config`, it does not deep-merge), so a
 * retry-only row wiped `models` and produced INVALID_CONFIG. Retry now lives
 * inside {@link gatewayPatchBlock}; this marker is stripped on ensure.
 */
export const LLM_RETRY_BEGIN = '# zr-llm-retry:begin (idempotent; keep outside zr-model-gateway block)'
export const LLM_RETRY_END = '# zr-llm-retry:end'

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
  /** From {@link fetchGatewayCaptcha}; required after three failed attempts. */
  readonly captchaId?: string
  readonly captchaCode?: string
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
  | {
      readonly ok: false
      readonly code: string
      readonly detail: string
      readonly needCaptcha?: boolean
      readonly locked?: boolean
    }

export interface GatewayCaptcha {
  readonly captchaId: string
  /** PNG base64 without a data-URL prefix. */
  readonly imageBase64: string
}

/** The narrow slice of `fetch` this module needs, so tests can supply a fake. */
export type GatewayFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>

const LOGIN_TIMEOUT_MS = 20_000

/**
 * Password the server expects: uppercase MD5 hex, characters 9–24, lowercased.
 * @param plain - password typed on the card.
 * @returns the 16-character digest sent as `Password`.
 */
export function gatewayLoginPassword(plain: string): string {
  return createHash('md5').update(plain, 'utf8').digest('hex').toUpperCase().slice(8, 24).toLowerCase()
}

/**
 * Read a .NET `TokenExpires` header (`yyyy-MM-ddTHH:mm:ss.fffffffZ`).
 * @param raw - header value.
 * @param now - current epoch milliseconds.
 * @returns the epoch milliseconds, or undefined when absent, malformed, or not in the future.
 */
export function parseTokenExpires(raw: string | null, now: number): number | undefined {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return undefined
  const parsed = Date.parse(trimmed.replace(/(\.\d{3})\d+/u, '$1'))
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined
}

function headerValue(headers: { get(name: string): string | null }, name: string): string | undefined {
  const value = headers.get(name) ?? headers.get(name.toLowerCase())
  return value === null ? undefined : value
}

/** Host envelope around every controller result; business outcome is `data`. */
function readFunctionResult(payload: unknown): { Success?: unknown; Content?: unknown; Datas?: unknown } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = (payload as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  return data as { Success?: unknown; Content?: unknown; Datas?: unknown }
}

/**
 * Accept only an origin that can carry a bearer token.
 * Plain HTTP is allowed for loopback development and for the build's own
 * deployment host, which currently has no TLS listener.
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
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowsPlainHttp(url.hostname))) return undefined
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  if (url.pathname !== '/' && url.pathname !== '') return undefined
  return url.origin
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '<unparseable>'
  }
}

function allowsPlainHttp(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true
  try {
    const deployment = new URL(DEFAULT_GATEWAY_BASE_URL)
    return deployment.protocol === 'http:' && deployment.hostname === hostname
  } catch {
    return false
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Read {@link GATEWAY_DESKTOP_ENV_KEY}. Only the exact value `dev` (any case) selects
 * personal-model mode; every other value stays `prod` so typos cannot drop the company chat route.
 */
export function resolveGatewayDesktopEnv(env: NodeJS.ProcessEnv = process.env): 'dev' | 'prod' {
  return (env[GATEWAY_DESKTOP_ENV_KEY] ?? '').trim().toLowerCase() === 'dev' ? 'dev' : 'prod'
}

/** `dev` → company login stays; models use {@link PERSONAL_MODEL_API_KEY_ENV} instead of `zr-gateway`. */
export function usesPersonalModelKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGatewayDesktopEnv(env) === 'dev'
}

/**
 * Read one KEY=value from a `.env` body. Does not load the rest of the file into the process.
 */
export function readDotEnvValue(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=\\s*(.*)$`, 'u')
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = pattern.exec(trimmed)
    if (match === null) continue
    let value = (match[1] ?? '').trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value
  }
  return undefined
}

/** @deprecated Use {@link readDotEnvValue} — kept name for existing tests. */
export function readGatewayDesktopEnvFromDotEnv(text: string): string | undefined {
  return readDotEnvValue(text, GATEWAY_DESKTOP_ENV_KEY)
}

/**
 * Candidate project `.env` paths: cwd, ancestors, and the path in a `.dsh-mom-root` marker
 * (written by `desktop/prepare-windows.ps1` into `C:\\dsh-src`).
 */
export function projectGatewayEnvFileCandidates(
  cwd: string = process.cwd(),
  fromFile?: string,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (path: string): void => {
    const normalized = resolvePath(path)
    if (seen.has(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }
  const roots = [cwd]
  if (fromFile !== undefined) roots.push(dirname(fromFile))
  for (const start of roots) {
    let directory = resolvePath(start)
    for (let depth = 0; depth < 8; depth += 1) {
      const marker = join(directory, '.dsh-mom-root')
      if (existsSync(marker)) {
        try {
          const root = readFileSync(marker, 'utf8').trim().split(/\r?\n/u)[0]?.trim()
          if (root !== undefined && root !== '') add(join(root, '.env'))
        } catch {
          // ignore unreadable marker
        }
      }
      add(join(directory, '.env'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return out
}

/**
 * If the process does not already define {@link GATEWAY_DESKTOP_ENV_KEY}, copy it from the
 * first readable project `.env`. Returns true when a value was applied.
 */
export function applyProjectGatewayDesktopEnv(
  env: NodeJS.ProcessEnv = process.env,
  filePaths: readonly string[] = projectGatewayEnvFileCandidates(),
): boolean {
  if (env[GATEWAY_DESKTOP_ENV_KEY] !== undefined) return false
  for (const path of filePaths) {
    if (!existsSync(path)) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const value = readGatewayDesktopEnvFromDotEnv(text)
    if (value === undefined) continue
    env[GATEWAY_DESKTOP_ENV_KEY] = value
    return true
  }
  return false
}

/**
 * Read {@link PERSONAL_MODEL_API_KEY_ENV} from the first project `.env` that defines it.
 * Used only when {@link usesPersonalModelKey} is true; never invents a key.
 */
export function readProjectPersonalModelApiKey(
  filePaths: readonly string[] = projectGatewayEnvFileCandidates(),
): string | undefined {
  for (const path of filePaths) {
    if (!existsSync(path)) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const value = readDotEnvValue(text, PERSONAL_MODEL_API_KEY_ENV)?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * Resolve the gateway from the environment, falling back to the build constant.
 *
 * Priority (minimal / safe):
 * 1. `ZR_MODEL_GATEWAY_URL` when the variable is present (empty string disables the gateway)
 * 2. `fallback` (defaults to the company production origin)
 *
 * `DSH_DESKTOP_GATEWAY_ENV=dev` does **not** clear this URL: login still uses the company
 * gateway; only the Host model route is switched via {@link usesPersonalModelKey}.
 *
 * @param env - process environment.
 * @param fallback - production address used when env has no URL.
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
    // The raw value may carry credentials in its userinfo; log only a redacted form.
    console.error(`desktop model gateway: ignoring unusable base URL ${redactUrl(raw)}; HTTPS, a loopback HTTP origin, or the deployment host over HTTP is required`)
    return undefined
  }
  return { baseUrl, models: GATEWAY_MODELS }
}

/**
 * Origin the OpenAI-compatible route targets: `{baseUrl}/api/ai`.
 * The colleague-server chat action (`/api/ai/Chat/Completions`) is
 * OpenAI-compatible for streaming; the earlier self-built gateway's `/v1`
 * route no longer exists on this backend.
 */
export function gatewayChatBaseUrl(config: GatewayConfig): string {
  return `${config.baseUrl}/api/ai`
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
    `        usageReportUrl: ${gatewayChatBaseUrl(config)}/Usage/Report`,
    '        compat:',
    '          thinkingFormat: deepseek',
    // Catalog aliases are not in the installed pi-ai catalog, so without this
    // the route falls back to text-only and image attach is refused client-side.
    '        defaultInput:',
    '          - text',
    '          - image',
    // Same plugin config is replaced wholesale by later id-targeted rows, so
    // retry must sit on this provider object — never in a follow-up patch.
    // Do not retry INVALID_REQUEST: stream-guard rewrites gateway business
    // failures (HTTP 200 + Success=false) into 400 + Chinese text, which pi-ai
    // maps to INVALID_REQUEST. Retrying that only burns 5 attempts on the same
    // upstream outage and shows "已重试模型请求 (5/5)".
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 5',
    '          retryableCodes:',
    '            - EMPTY_RESPONSE',
    '            - RATE_LIMIT',
    '            - SERVER',
    '            - TIMEOUT',
    '            - TRANSPORT',
    '            - PI_AI_ERROR',
    '          backoff:',
    '            initialDelayMs: 800',
    '            maxDelayMs: 12000',
    '            jitterRatio: 0.15',
    '        models:',
    ...config.models.flatMap(model => [
      `          - id: ${yamlScalar(model.id)}`,
      `            name: ${yamlScalar(model.name)}`,
      `            contextWindow: ${model.contextWindow}`,
      `            maxTokens: ${model.maxTokens}`,
    ]),
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${GATEWAY_PROVIDER}`,
    `    model: ${yamlScalar(first?.id ?? '')}`,
    GATEWAY_PATCH_END,
  ].join('\n')
}

/**
 * Drop the legacy retry-only patch so it cannot replace the gateway models list.
 * @param current - existing patch document.
 * @returns document without the `# zr-llm-retry` block.
 */
export function stripLlmRetryBlock(current: string): string {
  const start = current.indexOf(LLM_RETRY_BEGIN)
  const end = start === -1 ? -1 : current.indexOf(LLM_RETRY_END, start)
  if (start === -1 || end === -1) return current
  const before = current.slice(0, start).replace(/\s+$/u, '')
  const after = current.slice(end + LLM_RETRY_END.length).replace(/^\s+/u, '')
  return `${before}${after ? `\n\n${after}` : '\n'}`
}

/**
 * Remove a previously generated gateway patch so a gateway-off launch does not keep
 * routing to the company host or leave `llm-deepseek` disabled inside that block.
 */
export function stripGatewayPatchBlock(current: string): string {
  const start = current.indexOf(GATEWAY_PATCH_BEGIN)
  const end = start === -1 ? -1 : current.indexOf(GATEWAY_PATCH_END, start)
  if (start === -1 || end === -1) return current
  const before = current.slice(0, start).replace(/\s+$/u, '')
  const after = current.slice(end + GATEWAY_PATCH_END.length).replace(/^\s+/u, '')
  return `${before}${after ? `\n\n${after}` : '\n'}`
}

/**
 * Quote a catalog-supplied scalar so a server value cannot alter the document.
 * JSON string syntax is valid inside a YAML double-quoted scalar, and it
 * escapes newlines, quotes, and control characters.
 * @param value - alias or display name from the model catalog.
 * @returns the quoted scalar.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
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
    const next = applyGatewayPatch(stripLlmRetryBlock(current), gatewayPatchBlock(config))
    if (next !== current) writeFileSync(patchPath, next)
  } catch (error) {
    // A profile write must never keep the app from starting; the route simply stays unregistered.
    console.error('desktop model gateway profile was not updated', error)
  }
}

/**
 * Drop the generated gateway block when the gateway is intentionally off (e.g. `DSH_DESKTOP_GATEWAY_ENV=dev`).
 * Leaves every other patch row alone. Missing or unreadable profiles are ignored.
 */
export function clearGatewayProfile(profileDir: string): void {
  try {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) return
    const current = readFileSync(patchPath, 'utf8')
    const next = stripGatewayPatchBlock(current)
    if (next !== current) writeFileSync(patchPath, next)
  } catch (error) {
    console.error('desktop model gateway profile was not cleared', error)
  }
}

/**
 * Redacted login attempt for the console / gateway trace file.
 * Password and username never appear: only lengths and whether Enterprise was sent.
 */
export function describeGatewayLoginAttempt(
  url: string,
  body: Readonly<Record<string, string>>,
  result: { ok: true; status: number; ms: number } | { ok: false; ms: number; error: string },
): string {
  return JSON.stringify({
    at: new Date().toISOString(),
    method: 'POST',
    url,
    userNameChars: typeof body.UserName === 'string' ? body.UserName.length : 0,
    enterprise: body.Enterprise ?? null,
    passwordChars: typeof body.Password === 'string' ? body.Password.length : 0,
    ...result,
  })
}

/**
 * Exchange the card's credentials for a session token.
 * The token and its expiry arrive in response headers; the user object sits in
 * the host envelope, and rejections still come back as HTTP 200 with `Content`.
 * @param config - resolved gateway.
 * @param input - enterprise, username, and password from the card.
 * @param options - fetch implementation, clock, and timeout for tests.
 * @returns a card-safe outcome; the password is never echoed.
 */
export async function loginWithGateway(
  config: GatewayConfig,
  input: GatewayLoginInput,
  options: { fetch?: GatewayFetch; now?: number; timeoutMs?: number; traceDirectory?: string } = {},
): Promise<GatewayLoginOutcome> {
  const username = input.username.trim().toLowerCase()
  const password = input.password
  if (username === '' || password === '') return { ok: false, code: 'empty', detail: '请输入账号和密码' }
  if (password.length > 256) return { ok: false, code: 'invalid', detail: '用户名或密码错误' }
  const now = options.now ?? Date.now()
  const fetchImpl = options.fetch ?? defaultFetch
  const body: Record<string, string> = {
    UserName: username,
    Password: gatewayLoginPassword(password),
  }
  const cid = enterpriseCid(input.enterpriseKey)
  if (cid !== '') body.Enterprise = cid
  const captchaId = normalizeCaptchaField(input.captchaId, CAPTCHA_ID_MAX)
  const captchaCode = normalizeCaptchaField(input.captchaCode, CAPTCHA_CODE_MAX)
  if (captchaId !== '' && captchaCode !== '') {
    body.CaptchaId = captchaId
    body.CaptchaCode = captchaCode
  }
  const url = `${config.baseUrl}/api/sys/user/UserLogin`
  const started = Date.now()
  let response: Awaited<ReturnType<GatewayFetch>>
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? LOGIN_TIMEOUT_MS),
    })
  } catch (error) {
    const ms = Date.now() - started
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const line = describeGatewayLoginAttempt(url, body, { ok: false, ms, error: message })
    console.error('desktop model gateway login unreachable', line)
    writeGatewayLoginTrace(options.traceDirectory, line)
    return { ok: false, code: 'unreachable', detail: '无法连接登录服务，请检查网络后重试' }
  }
  {
    const line = describeGatewayLoginAttempt(url, body, { ok: true, status: response.status, ms: Date.now() - started })
    // Failures always leave a local trace. Successful HTTP responses only log when
    // field diagnosis is opted in, so usernames are not written on every normal login.
    const traceSuccess = process.env.DSH_GATEWAY_LOGIN_TRACE === '1'
    if (!response.ok || traceSuccess) {
      console.error('desktop model gateway login response', line)
      writeGatewayLoginTrace(options.traceDirectory, line)
    }
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
  const result = readFunctionResult(payload)
  if (result === undefined) return { ok: false, code: 'server', detail: '登录服务返回了无法识别的内容' }
  if (result.Success === false) {
    const content = typeof result.Content === 'string' ? result.Content.trim() : ''
    const datas = typeof result.Datas === 'object' && result.Datas !== null
      ? result.Datas as Record<string, unknown>
      : undefined
    // Prefer the server flag. Only fall back to Content text when Datas is absent,
    // so ordinary password-error copy never forces a captcha field by accident.
    const needCaptcha = datas?.NeedCaptcha === true
      || (datas === undefined && /验证码/u.test(content))
    const locked = datas?.Locked === true
      || (datas === undefined && /账号已被锁定/u.test(content))
    return {
      ok: false,
      code: locked ? 'locked' : needCaptcha ? 'captcha' : 'invalid',
      detail: content === '' ? '用户名或密码错误' : content,
      ...needCaptcha ? { needCaptcha: true } : {},
      ...locked ? { locked: true } : {},
    }
  }
  if (result.Success !== true) return { ok: false, code: 'server', detail: '登录服务返回了无法识别的内容' }
  const token = headerValue(response.headers, 'Token')
  if (token === undefined || !/^[\x21-\x7e]+$/u.test(token)) {
    return { ok: false, code: 'server', detail: '登录服务没有返回有效凭证' }
  }
  const user = typeof result.Datas === 'object' && result.Datas !== null ? result.Datas as Record<string, unknown> : {}
  const name = typeof user.CUSER_NAME === 'string' && user.CUSER_NAME.trim() !== '' ? user.CUSER_NAME.trim() : username
  const displayName = typeof user.CDISPLAY_NAME === 'string' && user.CDISPLAY_NAME.trim() !== '' ? user.CDISPLAY_NAME.trim() : name
  const expiresAt = parseTokenExpires(headerValue(response.headers, 'TokenExpires') ?? null, now) ?? now + SESSION_TTL_MS
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

const LOGOUT_TIMEOUT_MS = 5_000
const MODELS_TIMEOUT_MS = 10_000
const VALIDATE_TIMEOUT_MS = 8_000
const CAPTCHA_TIMEOUT_MS = 10_000
/** Captcha id / code wire limits — anything larger is treated as unusable. */
const CAPTCHA_ID_MAX = 128
const CAPTCHA_CODE_MAX = 32
/** ~256 KiB of base64 (~192 KiB decoded); real PNG captchas are far smaller. */
const CAPTCHA_IMAGE_BASE64_MAX = 256 * 1024
const CAPTCHA_IMAGE_BASE64 = /^[A-Za-z0-9+/]+=*$/u

/**
 * Accept only a bounded, alphabet-safe captcha image payload for the welcome card.
 * @param raw - `ImageBase64` from GetCaptcha.
 * @returns the trimmed value, or empty when unsafe.
 */
export function normalizeCaptchaImageBase64(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (value === '' || value.length > CAPTCHA_IMAGE_BASE64_MAX) return ''
  if (value.includes('data:') || value.includes(',') || value.includes('.')) return ''
  return CAPTCHA_IMAGE_BASE64.test(value) ? value : ''
}

/**
 * Accept a short captcha id / typed code for the login body.
 * @param raw - field from the card or GetCaptcha.
 * @param max - inclusive length limit.
 * @returns the trimmed value, or empty when oversized/blank.
 */
export function normalizeCaptchaField(raw: string | undefined, max: number): string {
  const value = raw?.trim() ?? ''
  if (value === '' || value.length > max) return ''
  if (!/^[\x21-\x7e]+$/u.test(value)) return ''
  return value
}

/**
 * Confirm the access token is still accepted by the gateway.
 * HTTP 401 or a business rejection both mean the remembered session must re-login.
 * Transport failures resolve true so a temporary outage does not force a password prompt.
 * @param config - resolved gateway.
 * @param token - session token from login or the persisted local copy.
 * @param options - fetch implementation and timeout for tests.
 */
export async function validateGatewayToken(
  config: GatewayConfig,
  token: string,
  options: { fetch?: GatewayFetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const trimmed = token.trim()
  if (trimmed === '') return false
  const fetchImpl = options.fetch ?? defaultFetch
  let response: Awaited<ReturnType<GatewayFetch>>
  try {
    response = await fetchImpl(`${config.baseUrl}/api/sys/user/ValidateToken`, {
      method: 'GET',
      headers: { authorization: `Bearer ${trimmed}`, accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? VALIDATE_TIMEOUT_MS),
    })
  } catch {
    return true
  }
  if (response.status === 401) return false
  if (!response.ok) return true
  try {
    const result = readFunctionResult(await response.json())
    if (result === undefined) return true
    return result.Success === true
  } catch {
    return true
  }
}

export type SoftGatewayTokenProbe = 'valid' | 'expired' | 'skipped'

/**
 * Best-effort ValidateToken for a remembered session.
 * Callers must not use `expired` to block workspace admit — only to drop a
 * local copy that the gateway has already rejected.
 * @param options - gateway config, optional token, and validate override for tests.
 */
export async function softValidateStoredGatewayToken(options: {
  readonly config: GatewayConfig
  readonly token: string | undefined
  readonly validate?: (config: GatewayConfig, token: string) => Promise<boolean>
}): Promise<SoftGatewayTokenProbe> {
  const trimmed = options.token?.trim() ?? ''
  if (trimmed === '') return 'skipped'
  const validate = options.validate ?? ((config, token) => validateGatewayToken(config, token))
  return (await validate(options.config, trimmed)) ? 'valid' : 'expired'
}

/**
 * Fetch a login captcha image after the server asks for one.
 * @param config - resolved gateway.
 * @param options - fetch implementation and timeout for tests.
 */
export async function fetchGatewayCaptcha(
  config: GatewayConfig,
  options: { fetch?: GatewayFetch; timeoutMs?: number } = {},
): Promise<GatewayCaptcha | undefined> {
  const fetchImpl = options.fetch ?? defaultFetch
  let response: Awaited<ReturnType<GatewayFetch>>
  try {
    response = await fetchImpl(`${config.baseUrl}/api/sys/user/GetCaptcha`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? CAPTCHA_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return undefined
  }
  const result = readFunctionResult(payload)
  if (result?.Success !== true || typeof result.Datas !== 'object' || result.Datas === null) return undefined
  const datas = result.Datas as Record<string, unknown>
  const captchaId = normalizeCaptchaField(
    typeof datas.CaptchaId === 'string' ? datas.CaptchaId : undefined,
    CAPTCHA_ID_MAX,
  )
  const imageBase64 = normalizeCaptchaImageBase64(
    typeof datas.ImageBase64 === 'string' ? datas.ImageBase64 : undefined,
  )
  if (captchaId === '' || imageBase64 === '') return undefined
  return { captchaId, imageBase64 }
}

/**
 * The enabled-model catalog the gateway serves for the selector.
 * `models` is ordered with `defaultAlias` first: the profile patch takes
 * `models[0]` as the agent default model.
 */
export interface GatewayCatalog {
  readonly models: GatewayModel[]
  readonly defaultAlias: string
}

function parseCatalogModels(datas: Record<string, unknown>): GatewayModel[] | undefined {
  if (!Array.isArray(datas.models)) return undefined
  const models: GatewayModel[] = []
  for (const item of datas.models) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const id = typeof row.alias === 'string' ? row.alias.trim() : ''
    const name = typeof row.displayName === 'string' && row.displayName.trim() !== '' ? row.displayName.trim() : id
    const contextWindow = Number(row.contextWindow)
    const maxTokens = Number(row.maxTokens)
    if (id === '' || !Number.isFinite(contextWindow) || contextWindow <= 0
      || !Number.isFinite(maxTokens) || maxTokens <= 0) continue
    models.push({ id, name, contextWindow, maxTokens })
  }
  return models.length === 0 ? undefined : models
}

/**
 * Fetch the enabled-model catalog (`GET /api/ai/Models/Get`).
 * Any failure resolves undefined so the caller keeps its built-in list.
 * @param config - resolved gateway.
 * @param token - session token from a successful login.
 * @param options - fetch implementation and timeout for tests.
 */
export async function fetchGatewayModels(
  config: GatewayConfig,
  token: string,
  options: { fetch?: GatewayFetch; timeoutMs?: number } = {},
): Promise<GatewayCatalog | undefined> {
  const trimmed = token.trim()
  if (trimmed === '') return undefined
  const fetchImpl = options.fetch ?? defaultFetch
  let response: Awaited<ReturnType<GatewayFetch>>
  try {
    response = await fetchImpl(`${config.baseUrl}/api/ai/Models/Get`, {
      method: 'GET',
      // Fetch rejects any body on GET, so the catalog call must not send one.
      headers: { authorization: `Bearer ${trimmed}`, accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? MODELS_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return undefined
  }
  const result = readFunctionResult(payload)
  if (result?.Success !== true || typeof result.Datas !== 'object' || result.Datas === null) return undefined
  const datas = result.Datas as Record<string, unknown>
  const models = parseCatalogModels(datas)
  if (models === undefined) return undefined
  const defaultAlias = typeof datas.defaultAlias === 'string' ? datas.defaultAlias.trim() : ''
  const ordered = [...models].sort((a, b) => (b.id === defaultAlias ? 1 : 0) - (a.id === defaultAlias ? 1 : 0))
  return { models: ordered, defaultAlias }
}

/**
 * Read the cached catalog written after login; the patch is generated before
 * the Host boots, when no token is available to refresh it.
 * @param directory - `<userData>/gateway`.
 * @returns the cached models, or undefined when absent or unreadable.
 */
export function readGatewayModelsCache(directory: string): GatewayModel[] | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const datas = (raw as Record<string, unknown>).models
    if (!Array.isArray(datas)) return undefined
    // The cache stores the normalized catalog ({id, name, ...}); parseCatalogModels
    // validates the server row shape, so map back before reusing its checks.
    const rows = datas.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const row = item as Record<string, unknown>
      return { alias: row.id, displayName: row.name, contextWindow: row.contextWindow, maxTokens: row.maxTokens }
    })
    const models = parseCatalogModels({ models: rows })
    return models
  } catch {
    return undefined
  }
}

/**
 * Persist the freshly fetched catalog for the next startup's profile patch.
 * A failed write only logs: the selector then keeps the built-in list.
 * @param directory - `<userData>/gateway`.
 * @param catalog - what {@link fetchGatewayModels} returned.
 */
export function writeGatewayModelsCache(directory: string, catalog: GatewayCatalog): void {
  try {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'models.json'), JSON.stringify({ version: 1, ...catalog }))
  } catch (error) {
    console.error('desktop model gateway catalog was not cached', error)
  }
}

/** Keep at most this many JSONL lines so local diagnosis does not grow without bound. */
const LOGIN_TRACE_MAX_LINES = 200

/**
 * Append one redacted login attempt line for field diagnosis.
 * @param directory - `<userData>/gateway`; omitted skips the file write.
 * @param line - JSON from {@link describeGatewayLoginAttempt}.
 */
function writeGatewayLoginTrace(directory: string | undefined, line: string): void {
  if (directory === undefined || directory.trim() === '') return
  try {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'login-last.json'), `${line}\n`)
    const logPath = join(directory, 'login-trace.jsonl')
    let prior = ''
    try { prior = readFileSync(logPath, 'utf8') } catch { /* first write */ }
    const lines = prior === '' ? [] : prior.split('\n').filter(entry => entry.length > 0)
    lines.push(line)
    const kept = lines.length <= LOGIN_TRACE_MAX_LINES ? lines : lines.slice(-LOGIN_TRACE_MAX_LINES)
    writeFileSync(logPath, `${kept.join('\n')}\n`)
  } catch (error) {
    console.error('desktop model gateway login trace was not written', error)
  }
}

/**
 * Best-effort server-side sign-out: invalidate the session token at the gateway.
 * Every path resolves; a failure returns false and must never block the local
 * sign-out that follows. A 401 means the session is already gone, which is the
 * desired end state, so it counts as success.
 * @param config - gateway the token was minted by.
 * @param token - session token from a successful login.
 * @param options - fetch implementation and timeout for tests.
 * @returns whether the server session is known to be gone.
 */
export async function logoutWithGateway(
  config: GatewayConfig,
  token: string,
  options: { fetch?: GatewayFetch } = {},
): Promise<boolean> {
  const trimmed = token.trim()
  if (trimmed === '') return false
  const fetchImpl = options.fetch ?? defaultFetch
  let response: Awaited<ReturnType<GatewayFetch>>
  try {
    response = await fetchImpl(`${config.baseUrl}/api/sys/user/UserLogout`, {
      method: 'POST',
      // The host rejects a POST without a content type (415) and a truly
      // empty body (400), although the document says "no request body".
      headers: { authorization: `Bearer ${trimmed}`, 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
    })
  } catch {
    return false
  }
  if (response.status === 401) return true
  if (!response.ok) return false
  try {
    return readFunctionResult(await response.json())?.Success === true
  } catch {
    return false
  }
}
