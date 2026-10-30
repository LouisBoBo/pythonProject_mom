import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  GATEWAY_MODELS,
  applyGatewayPatch,
  ensureGatewayProfile,
  gatewayPatchBlock,
  loginWithGateway,
  parseGatewayBaseUrl,
  resolveGatewayConfig,
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

function respond(status: number, payload: unknown, calls: Call[] = []): GatewayFetch {
  return async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
}

it('accepts HTTPS origins and loopback HTTP only', () => {
  expect(parseGatewayBaseUrl('https://gateway.example')).toBe('https://gateway.example')
  expect(parseGatewayBaseUrl('https://gateway.example/')).toBe('https://gateway.example')
  expect(parseGatewayBaseUrl('https://gateway.example:8443')).toBe('https://gateway.example:8443')
  expect(parseGatewayBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  expect(parseGatewayBaseUrl('http://localhost:8787')).toBe('http://localhost:8787')
  expect(parseGatewayBaseUrl('http://[::1]:8787')).toBe('http://[::1]:8787')
  expect(parseGatewayBaseUrl('http://gateway.example')).toBeUndefined()
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

it('ignores an unusable URL instead of failing startup', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(resolveGatewayConfig({ ZR_MODEL_GATEWAY_URL: 'http://gateway.example' }, '')).toBeUndefined()
  expect(error).toHaveBeenCalledOnce()
})

it('generates a block that registers the route and the default model', () => {
  const block = gatewayPatchBlock(config)
  expect(block).toContain('baseURL: https://gateway.example/v1')
  expect(block).toContain('apiKeyEnv: ZR_GATEWAY_TOKEN')
  expect(block).toContain('provider: zr-gateway')
  expect(block).toContain('model: standard')
  expect(block).toContain('- id: standard\n            name: Flash')
  expect(block).toContain('- id: deep\n            name: Pro')
  expect(block).not.toContain('sk-')
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
  expect(block).toContain('model: standard')
  expect(block).toContain('name: DeepSeek-V4.1-Flash')
  expect(block).toContain('name: DeepSeek-V4-Pro')
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
  expect(second).toContain('https://other.example/v1')
  expect(second).not.toContain('https://gateway.example/v1')
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

it('reports a write failure without throwing', () => {
  const root = directory()
  mkdirSync(join(root, 'cordis.patch.yml'))
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() => ensureGatewayProfile(root, config)).not.toThrow()
  expect(error).toHaveBeenCalled()
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

it('exchanges credentials for a token', async () => {
  const calls: Call[] = []
  const outcome = await loginWithGateway(config, input, {
    fetch: respond(200, { token: 'token-value', expiresAt: 2_000, user: { name: 'louis', displayName: '路易' } }, calls),
    now: 1_000,
  })
  expect(outcome).toEqual({
    ok: true, token: 'token-value', expiresAt: 2_000, username: 'louis', displayName: '路易', enterpriseKey: 'jxzr',
  })
  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call?.url).toBe('https://gateway.example/api/login')
  expect(call?.init.method).toBe('POST')
  expect(call?.init.headers['content-type']).toBe('application/json')
  expect(JSON.parse(call?.init.body ?? '{}')).toEqual({ enterprise: 'jxzr', username: 'louis', password: 'secret' })
})

it('falls back to the account name and the standard lifetime', async () => {
  const viaName = await loginWithGateway(config, input, {
    fetch: respond(200, { token: 'token-value', user: { name: 'louis' } }),
    now: 1_000,
  })
  expect(viaName).toMatchObject({ ok: true, displayName: 'louis', expiresAt: 1_000 + 7 * 24 * 60 * 60 * 1000 })

  const bare = await loginWithGateway(config, { ...input, enterpriseKey: 'unknown' }, {
    fetch: respond(200, { token: 'token-value', expiresAt: 'soon' }),
    now: 1_000,
  })
  expect(bare).toMatchObject({ ok: true, username: 'louis', displayName: 'louis', enterpriseKey: 'jxzr' })

  const stale = await loginWithGateway(config, input, {
    fetch: respond(200, { token: 'token-value', expiresAt: 10 }),
    now: 1_000,
  })
  expect(stale).toMatchObject({ ok: true, expiresAt: 1_000 + 7 * 24 * 60 * 60 * 1000 })
})

it('maps gateway rejections to card copy', async () => {
  expect(await loginWithGateway(config, input, { fetch: respond(401, {}) })).toMatchObject({ ok: false, code: 'invalid' })
  expect(await loginWithGateway(config, input, { fetch: respond(403, {}) })).toMatchObject({ ok: false, code: 'forbidden' })
  expect(await loginWithGateway(config, input, { fetch: respond(429, {}) })).toMatchObject({ ok: false, code: 'busy' })
  expect(await loginWithGateway(config, input, { fetch: respond(500, {}) })).toMatchObject({ ok: false, code: 'server' })
})

it('never surfaces transport or payload details', async () => {
  const offline: GatewayFetch = async () => { throw new Error('ECONNREFUSED 10.0.0.1') }
  expect(await loginWithGateway(config, input, { fetch: offline })).toEqual({
    ok: false, code: 'unreachable', detail: '无法连接登录服务，请检查网络后重试',
  })

  const brokenJson: GatewayFetch = async () => ({
    ok: true, status: 200, json: async () => { throw new Error('unexpected token <') },
  })
  expect(await loginWithGateway(config, input, { fetch: brokenJson })).toMatchObject({ ok: false, code: 'server' })

  expect(await loginWithGateway(config, input, { fetch: respond(200, null) })).toMatchObject({ ok: false, code: 'server' })
  expect(await loginWithGateway(config, input, { fetch: respond(200, { token: 42 }) })).toMatchObject({ ok: false, code: 'server' })
  expect(await loginWithGateway(config, input, { fetch: respond(200, { token: 'has space' }) })).toMatchObject({ ok: false, code: 'server' })
})
