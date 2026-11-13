import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  GATEWAY_MODELS,
  LLM_RETRY_BEGIN,
  LLM_RETRY_END,
  applyGatewayPatch,
  describeGatewayLoginAttempt,
  ensureGatewayProfile,
  fetchGatewayModels,
  gatewayLoginPassword,
  gatewayPatchBlock,
  fetchGatewayCaptcha,
  loginWithGateway,
  logoutWithGateway,
  normalizeCaptchaField,
  normalizeCaptchaImageBase64,
  parseGatewayBaseUrl,
  parseTokenExpires,
  readGatewayModelsCache,
  applyProjectGatewayDesktopEnv,
  clearGatewayProfile,
  readDotEnvValue,
  readGatewayDesktopEnvFromDotEnv,
  readProjectPersonalModelApiKey,
  resolveGatewayConfig,
  resolveGatewayDesktopEnv,
  stripGatewayPatchBlock,
  stripLlmRetryBlock,
  usesPersonalModelKey,
  softValidateStoredGatewayToken,
  validateGatewayToken,
  writeGatewayModelsCache,
  type GatewayConfig,
  type GatewayFetch,
} from '../src/model-gateway.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-'))
  directories.push(path)
  return path
}

const config: GatewayConfig = {
  baseUrl: 'https://gateway.example',
  models: [
    { id: 'standard', name: 'Flash', contextWindow: 128_000, maxTokens: 8_192 },
    { id: 'deep', name: 'Pro', contextWindow: 128_000, maxTokens: 16_384 },
  ],
}

const input = { username: ' Louis ', password: 'secret', enterpriseKey: 'jxzr' }

interface Call {
  readonly url: string
  readonly init: Parameters<GatewayFetch>[1]
}

function respond(
  status: number,
  payload: unknown,
  calls: Call[] = [],
  headers: Record<string, string> = {},
): GatewayFetch {
  const lowered = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null },
      json: async () => payload,
    }
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** Host envelope the CI.Server wraps every controller result in. */
function envelope(datas: unknown): unknown {
  return { code: 200, success: true, data: { Success: true, Content: '', Datas: datas, TotalRows: 1 } }
}

/** Business rejection: HTTP 200, outer success true, reason in `Content`. */
function rejection(content: string): unknown {
  return { code: 200, success: true, data: { Success: false, Content: content, Datas: null, TotalRows: 0 } }
}

it('accepts HTTPS origins, loopback HTTP, and the deployment host over HTTP', () => {
  expect(parseGatewayBaseUrl('https://gateway.example')).toBe('https://gateway.example')
  expect(parseGatewayBaseUrl('https://gateway.example/')).toBe('https://gateway.example')
  expect(parseGatewayBaseUrl('https://gateway.example:8443')).toBe('https://gateway.example:8443')
  expect(parseGatewayBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  expect(parseGatewayBaseUrl('http://localhost:8787')).toBe('http://localhost:8787')
  expect(parseGatewayBaseUrl('http://[::1]:8787')).toBe('http://[::1]:8787')
  expect(parseGatewayBaseUrl('http://113.90.149.166:19772')).toBe('http://113.90.149.166:19772')
  expect(parseGatewayBaseUrl('http://gateway.example')).toBeUndefined()
  expect(parseGatewayBaseUrl('http://192.168.1.10:6680')).toBeUndefined()
  expect(parseGatewayBaseUrl('https://gateway.example/v1')).toBeUndefined()
  expect(parseGatewayBaseUrl('https://user:secret@gateway.example')).toBeUndefined()
  expect(parseGatewayBaseUrl('https://gateway.example/?tenant=1')).toBeUndefined()
  expect(parseGatewayBaseUrl('https://gateway.example/#x')).toBeUndefined()
  expect(parseGatewayBaseUrl('not a url')).toBeUndefined()
})

it('stays off without a URL and reads the environment first', () => {
  expect(resolveGatewayConfig({}, '')).toBeUndefined()
  expect(resolveGatewayConfig({ ZR_MODEL_GATEWAY_URL: '  ' }, '')).toBeUndefined()
  expect(resolveGatewayConfig({}, 'https://gateway.example')).toMatchObject({ baseUrl: 'https://gateway.example' })
  expect(resolveGatewayConfig({ ZR_MODEL_GATEWAY_URL: 'http://localhost:9000' }, 'https://ignored.example')).toEqual({
    baseUrl: 'http://localhost:9000',
    models: [
      { id: 'standard', name: 'DeepSeek-V4.1-Flash', contextWindow: 128_000, maxTokens: 8_192 },
      { id: 'deep', name: 'DeepSeek-V4-Pro', contextWindow: 128_000, maxTokens: 16_384 },
    ],
  })
})

it('falls back to the company server when no URL is configured', () => {
  expect(resolveGatewayConfig({})).toMatchObject({ baseUrl: 'http://113.90.149.166:19772' })
})

it('treats only DSH_DESKTOP_GATEWAY_ENV=dev as personal-model mode', () => {
  expect(resolveGatewayDesktopEnv({})).toBe('prod')
  expect(resolveGatewayDesktopEnv({ DSH_DESKTOP_GATEWAY_ENV: 'prod' })).toBe('prod')
  expect(resolveGatewayDesktopEnv({ DSH_DESKTOP_GATEWAY_ENV: 'DEV' })).toBe('dev')
  expect(resolveGatewayDesktopEnv({ DSH_DESKTOP_GATEWAY_ENV: ' staging ' })).toBe('prod')
})

it('keeps the company gateway URL in dev so login still uses company UserLogin', () => {
  expect(usesPersonalModelKey({ DSH_DESKTOP_GATEWAY_ENV: 'dev' })).toBe(true)
  expect(usesPersonalModelKey({ DSH_DESKTOP_GATEWAY_ENV: 'prod' })).toBe(false)
  expect(resolveGatewayConfig({ DSH_DESKTOP_GATEWAY_ENV: 'dev' })).toMatchObject({
    baseUrl: 'http://113.90.149.166:19772',
  })
})

it('reads only named keys from a project .env body', () => {
  const body = [
    '# comment',
    'DEEPSEEK_API_KEY=sk-secret',
    'DSH_DESKTOP_GATEWAY_ENV=dev',
    'OTHER=1',
  ].join('\n')
  expect(readGatewayDesktopEnvFromDotEnv(body)).toBe('dev')
  expect(readDotEnvValue(body, 'DEEPSEEK_API_KEY')).toBe('sk-secret')
  expect(readGatewayDesktopEnvFromDotEnv('export DSH_DESKTOP_GATEWAY_ENV="prod"\n')).toBe('prod')
  expect(readGatewayDesktopEnvFromDotEnv('DEEPSEEK_API_KEY=sk-secret\n')).toBeUndefined()
})

it('applies project .env gateway mode only when the process env does not already set it', () => {
  const root = directory()
  const envFile = join(root, '.env')
  writeFileSync(envFile, 'DSH_DESKTOP_GATEWAY_ENV=dev\nDEEPSEEK_API_KEY=sk-secret\n')
  const fresh: NodeJS.ProcessEnv = {}
  expect(applyProjectGatewayDesktopEnv(fresh, [envFile])).toBe(true)
  expect(fresh.DSH_DESKTOP_GATEWAY_ENV).toBe('dev')
  expect(fresh.DEEPSEEK_API_KEY).toBeUndefined()
  expect(readProjectPersonalModelApiKey([envFile])).toBe('sk-secret')
  const locked: NodeJS.ProcessEnv = { DSH_DESKTOP_GATEWAY_ENV: 'prod' }
  expect(applyProjectGatewayDesktopEnv(locked, [envFile])).toBe(false)
  expect(locked.DSH_DESKTOP_GATEWAY_ENV).toBe('prod')
})

it('lets ZR_MODEL_GATEWAY_URL override the company origin including forcing the gateway off', () => {
  expect(resolveGatewayConfig({
    DSH_DESKTOP_GATEWAY_ENV: 'dev',
    ZR_MODEL_GATEWAY_URL: 'http://localhost:9000',
  })).toMatchObject({ baseUrl: 'http://localhost:9000' })
  expect(resolveGatewayConfig({
    DSH_DESKTOP_GATEWAY_ENV: 'prod',
    ZR_MODEL_GATEWAY_URL: '',
  })).toBeUndefined()
})

it('strips a leftover gateway profile block when the gateway is off', () => {
  const root = directory()
  writeFileSync(join(root, 'cordis.patch.yml'), `${gatewayPatchBlock(config)}\n- id: keep-me\n`)
  clearGatewayProfile(root)
  const written = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  expect(written).not.toContain('zr-model-gateway:begin')
  expect(written).not.toContain('llm-deepseek')
  expect(written).toContain('- id: keep-me')
  expect(stripGatewayPatchBlock('no markers')).toBe('no markers')
})

it('ignores an unusable URL instead of failing startup', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(resolveGatewayConfig({ ZR_MODEL_GATEWAY_URL: 'http://gateway.example' }, '')).toBeUndefined()
  expect(error).toHaveBeenCalledOnce()
})

it('does not log credentials embedded in an unusable URL', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(resolveGatewayConfig({ ZR_MODEL_GATEWAY_URL: 'https://user:secret@gateway.example' }, '')).toBeUndefined()
  const logged = error.mock.calls.flat().join(' ')
  expect(logged).not.toContain('secret')
  expect(logged).not.toContain('user:')
  error.mockRestore()
})

it('generates a block that registers the route and the default model', () => {
  const block = gatewayPatchBlock(config)
  expect(block).toContain('baseURL: https://gateway.example/api/ai')
  expect(block).toContain('apiKeyEnv: ZR_GATEWAY_TOKEN')
  expect(block).toContain('usageReportUrl: https://gateway.example/api/ai/Usage/Report')
  expect(block).toContain('provider: zr-gateway')
  expect(block).toContain('model: "standard"')
  expect(block).toContain('- id: "standard"\n            name: "Flash"')
  expect(block).toContain('- id: "deep"\n            name: "Pro"')
  expect(block).toContain('retryPolicy:')
  expect(block).toContain('EMPTY_RESPONSE')
  expect(block).toContain('RATE_LIMIT')
  expect(block).not.toContain('INVALID_REQUEST')
  expect(block).toContain('defaultInput:\n          - text\n          - image')
  expect(block).not.toContain('sk-')
})

it('quotes catalog values so they cannot alter the patch document', () => {
  const block = gatewayPatchBlock({
    baseUrl: 'https://gateway.example',
    models: [{ id: 'evil\n- id: other', name: 'x: y # z', contextWindow: 1, maxTokens: 1 }],
  })
  expect(block).toContain('- id: "evil\\n- id: other"')
  expect(block).toContain('name: "x: y # z"')
  expect(block).not.toContain('\n- id: other')
})

it('disables the built-in DeepSeek provider it would otherwise compete with', () => {
  const block = gatewayPatchBlock(config)
  expect(block).toContain('- id: llm-deepseek\n  disabled: true')
  expect(block).not.toContain('apiKeyEnv: DEEPSEEK_API_KEY')
})

it('labels the selector with the vendor model names the gateway fronts', () => {
  expect(GATEWAY_MODELS).toEqual([
    { id: 'standard', name: 'DeepSeek-V4.1-Flash', contextWindow: 128_000, maxTokens: 8_192 },
    { id: 'deep', name: 'DeepSeek-V4-Pro', contextWindow: 128_000, maxTokens: 16_384 },
  ])
  const block = gatewayPatchBlock({ baseUrl: 'https://gateway.example', models: GATEWAY_MODELS })
  expect(block).toContain('model: "standard"')
  expect(block).toContain('name: "DeepSeek-V4.1-Flash"')
  expect(block).toContain('name: "DeepSeek-V4-Pro"')
})

it('fills an empty patch, keeps other rows, and re-runs without drift', () => {
  const block = gatewayPatchBlock(config)
  const empty = '# comment\n[]\n'
  const once = applyGatewayPatch(empty, block)
  expect(once).toContain('# comment')
  expect(once.trimEnd().endsWith('# zr-model-gateway:end')).toBe(true)
  expect(applyGatewayPatch(once, block)).toBe(once)

  const withRows = '- id: plugin-market\n  config:\n    indexes: []\n'
  const appended = applyGatewayPatch(withRows, block)
  expect(appended.startsWith(withRows.trimEnd())).toBe(true)
  expect(applyGatewayPatch(appended, block)).toBe(appended)
})

it('replaces a previously written block when the gateway changes', () => {
  const first = applyGatewayPatch('[]\n', gatewayPatchBlock(config))
  const moved = gatewayPatchBlock({ ...config, baseUrl: 'https://other.example' })
  const second = applyGatewayPatch(first, moved)
  expect(second).toContain('https://other.example/api/ai')
  expect(second).not.toContain('https://gateway.example/api/ai')
  expect(second.match(/zr-model-gateway:begin/u)).toHaveLength(1)
})

it('writes the profile only when the result differs', () => {
  const root = directory()
  ensureGatewayProfile(root, config)
  expect(() => readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toThrow()

  const patchPath = join(root, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
  ensureGatewayProfile(root, config)
  const written = readFileSync(patchPath, 'utf8')
  expect(written).toContain('zr-gateway')
  ensureGatewayProfile(root, config)
  expect(readFileSync(patchPath, 'utf8')).toBe(written)
})

it('strips a legacy retry-only patch that would replace gateway models', () => {
  const legacy = [
    gatewayPatchBlock(config),
    '',
    LLM_RETRY_BEGIN,
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      zr-gateway:',
    '        retryPolicy:',
    '          mode: normal',
    LLM_RETRY_END,
    '',
  ].join('\n')
  expect(stripLlmRetryBlock(legacy)).not.toContain(LLM_RETRY_BEGIN)
  expect(stripLlmRetryBlock(legacy)).toContain('models:')

  const root = directory()
  const patchPath = join(root, 'cordis.patch.yml')
  writeFileSync(patchPath, legacy)
  ensureGatewayProfile(root, config)
  const written = readFileSync(patchPath, 'utf8')
  expect(written).not.toContain(LLM_RETRY_BEGIN)
  expect(written).toContain('retryPolicy:')
  expect(written).toContain('- id: "standard"')
  expect(written.match(/- id: llm-pi-ai/g)).toHaveLength(1)
})

it('reports a write failure without throwing', () => {
  const root = directory()
  mkdirSync(join(root, 'cordis.patch.yml'))
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() => ensureGatewayProfile(root, config)).not.toThrow()
  expect(error).toHaveBeenCalled()
})

it('hashes the password the way the server expects', () => {
  expect(gatewayLoginPassword('secret')).toBe('ecd0e0f08eab7690')
  expect(gatewayLoginPassword('admin123')).toBe('7bbd73250516f069')
})

it('parses .NET expiry headers and drops unusable values', () => {
  expect(parseTokenExpires('2026-11-03T09:19:00.1234567Z', 1_000)).toBe(1_793_697_540_123)
  expect(parseTokenExpires(' 2026-11-03T09:19:00Z ', 1_000)).toBe(Date.parse('2026-11-03T09:19:00Z'))
  expect(parseTokenExpires('soon', 1_000)).toBeUndefined()
  expect(parseTokenExpires('2026-11-03T09:19:00Z', Date.parse('2026-11-04T00:00:00Z'))).toBeUndefined()
  expect(parseTokenExpires(null, 1_000)).toBeUndefined()
})

it('refuses empty or oversized credentials before any request', async () => {
  const fetchImpl = vi.fn<GatewayFetch>()
  expect(await loginWithGateway(config, { ...input, username: ' ' }, { fetch: fetchImpl })).toEqual({
    ok: false, code: 'empty', detail: '请输入账号和密码',
  })
  expect(await loginWithGateway(config, { ...input, password: 'x'.repeat(257) }, { fetch: fetchImpl })).toEqual({
    ok: false, code: 'invalid', detail: '用户名或密码错误',
  })
  expect(fetchImpl).not.toHaveBeenCalled()
})

it('posts the transformed password to UserLogin and reads the token from headers', async () => {
  const calls: Call[] = []
  const outcome = await loginWithGateway(config, input, {
    fetch: respond(200, envelope({ CUSER_NAME: 'louis', CDISPLAY_NAME: '路易' }), calls, {
      Token: 'header-token',
      TokenExpires: '2026-11-03T09:19:00.1234567Z',
    }),
    now: 1_000,
  })
  expect(outcome).toEqual({
    ok: true,
    token: 'header-token',
    expiresAt: 1_793_697_540_123,
    username: 'louis',
    displayName: '路易',
    enterpriseKey: 'jxzr',
  })
  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call?.url).toBe('https://gateway.example/api/sys/user/UserLogin')
  expect(call?.init.method).toBe('POST')
  expect(call?.init.headers['content-type']).toBe('application/json')
  const body = JSON.parse(call?.init.body ?? '{}') as Record<string, string>
  expect(body).toEqual({ UserName: 'louis', Password: 'ecd0e0f08eab7690' })
  expect(JSON.stringify(body)).not.toContain('secret')
})

it('falls back to the account name and the standard lifetime', async () => {
  const viaName = await loginWithGateway(config, input, {
    fetch: respond(200, envelope({ CUSER_NAME: 'louis' }), [], { Token: 'token-value' }),
    now: 1_000,
  })
  expect(viaName).toMatchObject({ ok: true, displayName: 'louis', expiresAt: 1_000 + SEVEN_DAYS_MS })

  const bare = await loginWithGateway(config, { ...input, enterpriseKey: 'unknown' }, {
    fetch: respond(200, envelope({ CUSER_NAME: 'louis' }), [], { Token: 'token-value', TokenExpires: 'soon' }),
    now: 1_000,
  })
  expect(bare).toMatchObject({ ok: true, username: 'louis', displayName: 'louis', enterpriseKey: 'jxzr' })

  const stale = await loginWithGateway(config, input, {
    fetch: respond(200, envelope({ CUSER_NAME: 'louis' }), [], { Token: 'token-value', TokenExpires: '2026-01-01T00:00:00Z' }),
    now: Date.parse('2026-06-01T00:00:00Z'),
  })
  expect(stale).toMatchObject({ ok: true, expiresAt: Date.parse('2026-06-01T00:00:00Z') + SEVEN_DAYS_MS })
})

it('shows the server content when the credentials are rejected', async () => {
  expect(await loginWithGateway(config, input, { fetch: respond(200, rejection('用户名或密码不正确!')) })).toEqual({
    ok: false, code: 'invalid', detail: '用户名或密码不正确!',
  })
  expect(await loginWithGateway(config, input, { fetch: respond(200, rejection('用户名或密码不正确，请输入验证码')) })).toMatchObject({
    ok: false, code: 'captcha', needCaptcha: true, detail: '用户名或密码不正确，请输入验证码',
  })
  expect(await loginWithGateway(config, input, {
    fetch: respond(200, {
      code: 200,
      success: true,
      data: { Success: false, Content: '用户名或密码不正确，请输入验证码', Datas: { NeedCaptcha: true, Locked: false } },
    }),
  })).toMatchObject({ ok: false, code: 'captcha', needCaptcha: true })
  expect(await loginWithGateway(config, input, { fetch: respond(200, rejection('')) })).toMatchObject({
    ok: false, code: 'invalid', detail: '用户名或密码错误',
  })
})

it('posts captcha fields only when the card supplies both', async () => {
  const calls: Call[] = []
  await loginWithGateway(config, { ...input, captchaId: 'c1', captchaCode: 'AB12' }, {
    fetch: respond(200, envelope({ CUSER_NAME: 'louis' }), calls, { Token: 'tok' }),
  })
  expect(JSON.parse(calls[0]?.init.body ?? '{}')).toMatchObject({
    UserName: 'louis', CaptchaId: 'c1', CaptchaCode: 'AB12',
  })
})

it('treats ValidateToken 401 as expired and network errors as still usable', async () => {
  expect(await validateGatewayToken(config, 'tok', { fetch: respond(401, {}) })).toBe(false)
  expect(await validateGatewayToken(config, 'tok', { fetch: respond(200, envelope(null)) })).toBe(true)
  expect(await validateGatewayToken(config, 'tok', {
    fetch: respond(200, { code: 200, success: true, data: { Success: false, Content: 'Token已失效' } }),
  })).toBe(false)
  const offline: GatewayFetch = async () => { throw new Error('offline') }
  expect(await validateGatewayToken(config, 'tok', { fetch: offline })).toBe(true)
})

it('soft-probes a remembered token without inventing a blocking failure', async () => {
  expect(await softValidateStoredGatewayToken({ config, token: undefined })).toBe('skipped')
  expect(await softValidateStoredGatewayToken({ config, token: '  ' })).toBe('skipped')
  expect(await softValidateStoredGatewayToken({
    config, token: 'tok', validate: async () => true,
  })).toBe('valid')
  expect(await softValidateStoredGatewayToken({
    config, token: 'tok', validate: async () => false,
  })).toBe('expired')
})

it('loads a captcha image from GetCaptcha', async () => {
  const captcha = await fetchGatewayCaptcha(config, {
    fetch: respond(200, envelope({ CaptchaId: 'id-1', ImageBase64: 'YWFh' })),
  })
  expect(captcha).toEqual({ captchaId: 'id-1', imageBase64: 'YWFh' })
  expect(await fetchGatewayCaptcha(config, { fetch: respond(500, {}) })).toBeUndefined()
})

it('rejects unsafe captcha payloads before they reach the card', () => {
  expect(normalizeCaptchaImageBase64('YWFh')).toBe('YWFh')
  expect(normalizeCaptchaImageBase64('data:image/png;base64,YWFh')).toBe('')
  expect(normalizeCaptchaImageBase64('YWFh!')).toBe('')
  expect(normalizeCaptchaImageBase64('a'.repeat(300_000))).toBe('')
  expect(normalizeCaptchaField('ok-id', 128)).toBe('ok-id')
  expect(normalizeCaptchaField('x'.repeat(200), 128)).toBe('')
  expect(normalizeCaptchaField('bad id', 128)).toBe('')
})

it('drops GetCaptcha rows with oversized or non-base64 images', async () => {
  expect(await fetchGatewayCaptcha(config, {
    fetch: respond(200, envelope({ CaptchaId: 'id-1', ImageBase64: 'data:image/png;base64,YWFh' })),
  })).toBeUndefined()
  expect(await fetchGatewayCaptcha(config, {
    fetch: respond(200, envelope({ CaptchaId: 'id-1', ImageBase64: 'not base64!!' })),
  })).toBeUndefined()
})

it('maps gateway rejections to card copy', async () => {
  expect(await loginWithGateway(config, input, { fetch: respond(401, {}) })).toMatchObject({ ok: false, code: 'invalid' })
  expect(await loginWithGateway(config, input, { fetch: respond(403, {}) })).toMatchObject({ ok: false, code: 'forbidden' })
  expect(await loginWithGateway(config, input, { fetch: respond(429, {}) })).toMatchObject({ ok: false, code: 'busy' })
  expect(await loginWithGateway(config, input, { fetch: respond(500, {}) })).toMatchObject({ ok: false, code: 'server' })
})

it('never surfaces transport or payload details', async () => {
  const offline: GatewayFetch = async () => { throw new Error('ECONNREFUSED 10.0.0.1') }
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const root = directory()
  expect(await loginWithGateway(config, input, { fetch: offline, traceDirectory: root })).toEqual({
    ok: false, code: 'unreachable', detail: '无法连接登录服务，请检查网络后重试',
  })
  const trace = readFileSync(join(root, 'login-last.json'), 'utf8')
  expect(trace).toContain('ECONNREFUSED')
  expect(trace).toContain('/api/sys/user/UserLogin')
  expect(trace).not.toContain(input.password)
  expect(trace).not.toContain(input.username)
  expect(describeGatewayLoginAttempt('http://g/api/sys/user/UserLogin', { UserName: 'a', Password: 'x'.repeat(16) }, {
    ok: false, ms: 1, error: 'TypeError: fetch failed',
  })).toContain('passwordChars":16')
  expect(describeGatewayLoginAttempt('http://g/api/sys/user/UserLogin', { UserName: 'secret-user', Password: 'x'.repeat(16) }, {
    ok: false, ms: 1, error: 'TypeError: fetch failed',
  })).not.toContain('secret-user')
  error.mockRestore()

  const brokenJson: GatewayFetch = async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('unexpected token <') },
  })
  expect(await loginWithGateway(config, input, { fetch: brokenJson })).toMatchObject({ ok: false, code: 'server' })

  expect(await loginWithGateway(config, input, { fetch: respond(200, null) })).toMatchObject({ ok: false, code: 'server' })
  expect(await loginWithGateway(config, input, { fetch: respond(200, { data: { Success: 'yes' } }) })).toMatchObject({ ok: false, code: 'server' })
  expect(await loginWithGateway(config, input, { fetch: respond(200, envelope({ CUSER_NAME: 'louis' })) })).toMatchObject({ ok: false, code: 'server' })
  expect(await loginWithGateway(config, input, {
    fetch: respond(200, envelope({ CUSER_NAME: 'louis' }), [], { Token: 'has space' }),
  })).toMatchObject({ ok: false, code: 'server' })
})

it('logs out with a bearer token and accepts the success envelope', async () => {
  const calls: Call[] = []
  const ok = await logoutWithGateway(config, ' session-tok ', { fetch: respond(200, { data: { Success: true, Content: '', Datas: null } }, calls) })
  expect(ok).toBe(true)
  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call?.url).toBe('https://gateway.example/api/sys/user/UserLogout')
  expect(call?.init.method).toBe('POST')
  expect(call?.init.headers.authorization).toBe('Bearer session-tok')
  expect(call?.init.headers['content-type']).toBe('application/json')
  expect(call?.init.body).toBe('{}')
})

it('treats an expired token as already signed out', async () => {
  expect(await logoutWithGateway(config, 'tok', { fetch: respond(401, {}) })).toBe(true)
})

it('never throws: offline, server error, business rejection, and empty token all resolve false', async () => {
  const offline: GatewayFetch = async () => { throw new Error('ECONNREFUSED') }
  expect(await logoutWithGateway(config, 'tok', { fetch: offline })).toBe(false)
  expect(await logoutWithGateway(config, 'tok', { fetch: respond(500, {}) })).toBe(false)
  expect(await logoutWithGateway(config, 'tok', { fetch: respond(200, rejection('退出失败：请携带当前登录 Token')) })).toBe(false)

  let called = false
  const unused: GatewayFetch = async () => { called = true; throw new Error('must not be called') }
  expect(await logoutWithGateway(config, '   ', { fetch: unused })).toBe(false)
  expect(called).toBe(false)
})

const catalogDatas = (models: unknown[], defaultAlias = 'standard') => ({
  data: { Success: true, Content: '', Datas: { models, defaultAlias } },
})

it('fetches the model catalog and puts the default alias first', async () => {
  const calls: Call[] = []
  const catalog = await fetchGatewayModels(config, ' tok ', {
    fetch: respond(200, catalogDatas([
      { alias: 'standard', displayName: 'Flash', contextWindow: 128000, maxTokens: 8192 },
      { alias: 'deep', displayName: 'Pro', contextWindow: 64000, maxTokens: 16384 },
    ]), calls),
  })
  expect(catalog?.defaultAlias).toBe('standard')
  expect(catalog?.models.map(model => model.id)).toEqual(['standard', 'deep'])
  expect(catalog?.models[0]).toEqual({ id: 'standard', name: 'Flash', contextWindow: 128000, maxTokens: 8192 })
  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call?.url).toBe('https://gateway.example/api/ai/Models/Get')
  expect(call?.init.method).toBe('GET')
  expect(call?.init.headers.authorization).toBe('Bearer tok')
  expect(call?.init.body).toBeUndefined()

  const reordered = await fetchGatewayModels(config, 'tok', {
    fetch: respond(200, catalogDatas([
      { alias: 'standard', displayName: 'Flash', contextWindow: 128000, maxTokens: 8192 },
      { alias: 'deep', displayName: 'Pro', contextWindow: 64000, maxTokens: 16384 },
    ], 'deep')),
  })
  expect(reordered?.models.map(model => model.id)).toEqual(['deep', 'standard'])
})

it('drops invalid catalog rows and resolves undefined on any failure', async () => {
  const sparse = await fetchGatewayModels(config, 'tok', {
    fetch: respond(200, catalogDatas([
      { alias: 'ok', displayName: 'Fine', contextWindow: 1000, maxTokens: 100 },
      { alias: '', displayName: 'No id', contextWindow: 1000, maxTokens: 100 },
      { alias: 'bad-window', displayName: 'X', contextWindow: 0, maxTokens: 100 },
      { alias: 'no-name', contextWindow: 1000, maxTokens: 100 },
      'garbage',
    ])),
  })
  expect(sparse?.models).toEqual([{ id: 'ok', name: 'Fine', contextWindow: 1000, maxTokens: 100 }, { id: 'no-name', name: 'no-name', contextWindow: 1000, maxTokens: 100 }])

  const offline: GatewayFetch = async () => { throw new Error('ECONNREFUSED') }
  expect(await fetchGatewayModels(config, 'tok', { fetch: offline })).toBeUndefined()
  expect(await fetchGatewayModels(config, 'tok', { fetch: respond(401, {}) })).toBeUndefined()
  expect(await fetchGatewayModels(config, 'tok', { fetch: respond(500, {}) })).toBeUndefined()
  expect(await fetchGatewayModels(config, 'tok', { fetch: respond(200, rejection('当前登录用户无效')) })).toBeUndefined()
  expect(await fetchGatewayModels(config, 'tok', { fetch: respond(200, { data: { Success: true, Datas: { models: [] } } }) })).toBeUndefined()

  let called = false
  const unused: GatewayFetch = async () => { called = true; throw new Error('must not be called') }
  expect(await fetchGatewayModels(config, '  ', { fetch: unused })).toBeUndefined()
  expect(called).toBe(false)
})

it('round-trips the catalog through the cache and tolerates a broken one', async () => {
  const dir = directory()
  expect(readGatewayModelsCache(dir)).toBeUndefined()
  writeGatewayModelsCache(dir, {
    models: [{ id: 'deep', name: 'Pro', contextWindow: 64000, maxTokens: 16384 }],
    defaultAlias: 'deep',
  })
  expect(readGatewayModelsCache(dir)).toEqual([{ id: 'deep', name: 'Pro', contextWindow: 64000, maxTokens: 16384 }])

  writeFileSync(join(dir, 'models.json'), '{not json')
  expect(readGatewayModelsCache(dir)).toBeUndefined()
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, models: [{ alias: 'x' }] }))
  expect(readGatewayModelsCache(dir)).toBeUndefined()
})
