import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL, ...overrides } },
  })
  return ctx
}

function ack(): string {
  return JSON.stringify({ data: { Success: true, Content: '', Datas: { ok: true } } })
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

it('posts one usage record for a finished call when the route names a report URL', async () => {
  const server = await mockServer([
    { events: textEvents },
    { body: ack() },
  ])
  const ctx = await harness(server.url, { usageReportUrl: `${server.url}/api/ai/Usage/Report` })

  const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  expect(result.finish.kind).toBe('stop')

  await vi.waitFor(() => { expect(server.paths).toHaveLength(2) })
  expect(server.paths[1]).toBe('/api/ai/Usage/Report')
  expect(server.headers[1]?.authorization).toBe('Bearer test-key')
  expect(server.requests[1]).toMatchObject({
    modelAlias: 'deepseek-flash',
    inputTokens: 3,
    outputTokens: 1,
    costYuan: 0,
    status: 'ok',
  })
  expect(server.requests[1]).toHaveProperty('clientTs')
  expect(server.requests[1]).toHaveProperty('latencyMs')
})

it('names the enterprise from the gateway token in the accept header', async () => {
  const server = await mockServer([{ events: textEvents }, { body: ack() }])
  vi.stubEnv('PI_TEST_KEY', jwt({ enterprisecid: 987 }))
  const ctx = await harness(server.url, { usageReportUrl: `${server.url}/api/ai/Usage/Report` })

  await assemble(ctx, { model: 'deepseek-flash', messages: [] })

  await vi.waitFor(() => { expect(server.paths).toHaveLength(2) })
  expect(server.headers[1]?.accept).toBe('application/json, enterprisecode$$987')
})

it('refuses a report URL that is not absolute http(s)', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await expect(ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: 'http://127.0.0.1:1', usageReportUrl: 'ftp://reports' } },
  })).rejects.toThrow(/usageReportUrl/u)
})

it('sends nothing when the route names no report URL', async () => {
  const server = await mockServer([{ events: textEvents }])
  const ctx = await harness(server.url)

  await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(server.paths).toHaveLength(1)
})

it('posts a failed call with zero counts and the failure text', async () => {
  const server = await mockServer([
    { status: 400, body: JSON.stringify({ error: { message: 'upstream rejected the request' } }) },
    { body: ack() },
  ])
  const ctx = await harness(server.url, { usageReportUrl: `${server.url}/api/ai/Usage/Report` })

  const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  expect(result.finish.kind).toBe('error')

  await vi.waitFor(() => { expect(server.paths).toHaveLength(2) })
  const report = server.requests[1] as Record<string, unknown>
  expect(report).toMatchObject({ modelAlias: 'deepseek-flash', status: 'error', inputTokens: 0, outputTokens: 0, costYuan: 0 })
  expect(typeof report['errorMessage']).toBe('string')
  expect(String(report['errorMessage']).length).toBeGreaterThan(0)
})

it('keeps the credential out of the failure text', async () => {
  const server = await mockServer([
    { status: 400, body: JSON.stringify({ error: { message: 'bad key test-key' } }) },
    { body: ack() },
  ])
  const ctx = await harness(server.url, { usageReportUrl: `${server.url}/api/ai/Usage/Report` })

  const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  expect(result.finish.kind).toBe('error')

  await vi.waitFor(() => { expect(server.paths).toHaveLength(2) })
  const report = server.requests[1] as Record<string, unknown>
  expect(String(report['errorMessage'])).not.toContain('test-key')
})
