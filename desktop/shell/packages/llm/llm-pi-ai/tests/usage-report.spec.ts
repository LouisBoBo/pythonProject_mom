import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'
import { listUsageQueue } from '../src/usage-queue.ts'
import {
  classifyUsageReportFailure,
  createUsageRecord,
  enterpriseIdFromToken,
  postUsageBatch,
  postUsageRecord,
  reportStatus,
  reportUsageWithQueue,
  sanitizeErrorMessage,
  totalInputTokens,
  usageBatchUrl,
} from '../src/usage-report.ts'
import type { UsageRecord, UsageRecordTransport } from '../src/usage-report.ts'

const queueDirs: string[] = []
afterEach(() => {
  for (const directory of queueDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function tempQueue(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-report-queue-'))
  queueDirs.push(directory)
  return directory
}

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 }
const STOP: FinishReason = { kind: 'stop' }

function ack(): Response {
  return new Response(JSON.stringify({ data: { Success: true, Content: '', Datas: { ok: true } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function recordOf(overrides: Partial<Parameters<typeof createUsageRecord>[0]> = {}): UsageRecord {
  return createUsageRecord({
    requestId: '550e8400-e29b-41d4-a716-446655440000',
    modelAlias: 'standard',
    usage: USAGE,
    finish: STOP,
    callerAborted: false,
    clientTs: 1_760_000_000_000,
    latencyMs: 1_234.6,
    ...overrides,
  })!
}

describe('totalInputTokens', () => {
  it('adds uncached, cache-read, and cache-write buckets', () => {
    expect(totalInputTokens(USAGE)).toBe(135)
  })

  it('omits absent cache buckets', () => {
    expect(totalInputTokens({ inputTokens: 7, outputTokens: 1 })).toBe(7)
  })

  it('refuses a negative or fractional bucket', () => {
    expect(totalInputTokens({ inputTokens: -1, outputTokens: 1 })).toBeUndefined()
    expect(totalInputTokens({ inputTokens: 1.5, outputTokens: 1 })).toBeUndefined()
  })
})

describe('reportStatus', () => {
  it('maps every finish kind', () => {
    expect(reportStatus({ kind: 'stop' }, false, undefined)).toBe('ok')
    expect(reportStatus({ kind: 'tool-calls' }, false, undefined)).toBe('ok')
    expect(reportStatus({ kind: 'max-tokens' }, false, undefined)).toBe('ok')
    expect(reportStatus({ kind: 'aborted', failure: { message: 'x', code: 'ABORTED' } }, false, undefined)).toBe('aborted')
    expect(reportStatus({ kind: 'error', failure: { message: 'x', code: 'PROVIDER' } }, false, undefined)).toBe('error')
  })

  it('prefers the caller abort over a terminal error', () => {
    expect(reportStatus({ kind: 'error', failure: { message: 'x', code: 'PROVIDER' } }, true, new Error('y'))).toBe('aborted')
  })

  it('treats a stream that ended without finish as an error when one was thrown', () => {
    expect(reportStatus(undefined, false, new Error('boom'))).toBe('error')
    expect(reportStatus(undefined, false, undefined)).toBe('aborted')
  })
})

describe('sanitizeErrorMessage', () => {
  it('collapses control characters and removes the credential and bearer tokens', () => {
    const token = 'abcdefghijklmnop'
    expect(sanitizeErrorMessage(`boom\n${token}\r\nAuthorization: Bearer ${token}`, token))
      .toBe('boom *** Authorization: Bearer ***')
  })

  it('keeps short secrets because replacing them could mangle ordinary text', () => {
    expect(sanitizeErrorMessage('a b c', 'ab')).toBe('a b c')
  })
})

describe('createUsageRecord', () => {
  it('reports provider usage with the whole prompt as input and zero cost', () => {
    expect(recordOf()).toEqual({
      requestId: '550e8400-e29b-41d4-a716-446655440000',
      modelAlias: 'standard',
      inputTokens: 135,
      outputTokens: 20,
      costYuan: 0,
      status: 'ok',
      clientTs: 1_760_000_000_000,
      latencyMs: 1_235,
    })
  })

  it('skips a successful call that reported no usage', () => {
    expect(createUsageRecord({
      requestId: 'r',
      modelAlias: 'standard',
      usage: undefined,
      finish: STOP,
      callerAborted: false,
      clientTs: 1,
      latencyMs: 5,
    })).toBeUndefined()
  })

  it('reports a failed call with zero counts and the failure message', () => {
    const record = createUsageRecord({
      requestId: 'r',
      modelAlias: 'standard',
      usage: undefined,
      finish: { kind: 'error', failure: { message: '上游超时', code: 'PROVIDER' } },
      callerAborted: false,
      clientTs: 1,
      latencyMs: 5,
      secret: 'secret-value-123',
    })
    expect(record).toMatchObject({ status: 'error', inputTokens: 0, outputTokens: 0, errorMessage: '上游超时' })
  })

  it('keeps usage on a failed call when the provider reported some', () => {
    const record = createUsageRecord({
      requestId: 'r',
      modelAlias: 'standard',
      usage: { inputTokens: 9, outputTokens: 2 },
      finish: { kind: 'error', failure: { message: '断流', code: 'PROVIDER' } },
      callerAborted: false,
      clientTs: 1,
      latencyMs: 5,
    })
    expect(record).toMatchObject({ status: 'error', inputTokens: 9, outputTokens: 2 })
  })

  it('marks a caller abort and omits an invalid latency', () => {
    const record = recordOf({ callerAborted: true, latencyMs: Number.NaN })
    expect(record).toMatchObject({ status: 'aborted' })
    expect(record).not.toHaveProperty('latencyMs')
  })

  it('refuses an empty alias, an overlong request id, and a non-positive timestamp', () => {
    expect(createUsageRecord({
      requestId: 'r', modelAlias: '  ', usage: USAGE, finish: STOP, callerAborted: false, clientTs: 1, latencyMs: 1,
    })).toBeUndefined()
    expect(createUsageRecord({
      requestId: 'x'.repeat(65), modelAlias: 'standard', usage: USAGE, finish: STOP, callerAborted: false, clientTs: 1, latencyMs: 1,
    })).toBeUndefined()
    expect(createUsageRecord({
      requestId: 'r', modelAlias: 'standard', usage: USAGE, finish: STOP, callerAborted: false, clientTs: 0, latencyMs: 1,
    })).toBeUndefined()
  })

  it('truncates a long failure message to 1000 characters', () => {
    const record = createUsageRecord({
      requestId: 'r',
      modelAlias: 'standard',
      usage: undefined,
      finish: undefined,
      callerAborted: false,
      clientTs: 1,
      latencyMs: 1,
      error: new Error('界'.repeat(2_000)),
    })
    expect([...record!.errorMessage!]).toHaveLength(1_000)
  })
})

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

describe('enterpriseIdFromToken', () => {
  it('reads a positive decimal enterprise id from the payload', () => {
    expect(enterpriseIdFromToken(jwt({ enterprisecid: 123 }))).toBe('123')
    expect(enterpriseIdFromToken(jwt({ enterprisecid: '456' }))).toBe('456')
  })

  it('omits zero, missing, negative, and malformed claims', () => {
    expect(enterpriseIdFromToken(jwt({ enterprisecid: 0 }))).toBeUndefined()
    expect(enterpriseIdFromToken(jwt({}))).toBeUndefined()
    expect(enterpriseIdFromToken(jwt({ enterprisecid: '-1' }))).toBeUndefined()
    expect(enterpriseIdFromToken('not-a-jwt')).toBeUndefined()
    expect(enterpriseIdFromToken('a.b.c')).toBeUndefined()
    expect(enterpriseIdFromToken(`a.${Buffer.from('nope').toString('base64url')}.c`)).toBeUndefined()
  })
})

describe('postUsageRecord', () => {
  const record = recordOf()

  function transport(fetch: typeof globalThis.fetch, log = vi.fn()): UsageRecordTransport {
    return { url: 'http://gateway.test/api/ai/Usage/Report', token: 'token-123', fetch, log }
  }

  it('posts the record with the bearer credential and JSON body', async () => {
    const fetch = vi.fn(async () => ack())
    await expect(postUsageRecord(record, transport(fetch as unknown as typeof globalThis.fetch)))
      .resolves.toBe(true)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://gateway.test/api/ai/Usage/Report')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      authorization: 'Bearer token-123',
      'content-type': 'application/json',
      accept: 'application/json',
    })
    expect(JSON.parse(String(init.body))).toMatchObject({ modelAlias: 'standard', costYuan: 0, status: 'ok' })
  })

  it('names the enterprise in the accept header when the token carries one', async () => {
    const fetch = vi.fn(async () => ack())
    const withEnterprise = { ...transport(fetch as unknown as typeof globalThis.fetch), enterpriseId: '123' }
    await expect(postUsageRecord(record, withEnterprise)).resolves.toBe(true)
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ accept: 'application/json, enterprisecode$$123' })
  })

  it('reports a transport failure without throwing', async () => {
    const log = vi.fn()
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    await expect(postUsageRecord(record, transport(fetch as unknown as typeof globalThis.fetch, log)))
      .resolves.toBe(false)
    expect(log).toHaveBeenCalledWith('usage report failed: ECONNREFUSED')
  })

  it('reports a non-200 response without throwing', async () => {
    const log = vi.fn()
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(postUsageRecord(record, transport(fetch as unknown as typeof globalThis.fetch, log)))
      .resolves.toBe(false)
    expect(log).toHaveBeenCalledWith('usage report failed: HTTP 500')
  })

  it('treats a business failure envelope as rejected', async () => {
    const log = vi.fn()
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { Success: false, Content: '当前登录用户无效' } })))
    await expect(postUsageRecord(record, transport(fetch as unknown as typeof globalThis.fetch, log)))
      .resolves.toBe(false)
    expect(log).toHaveBeenCalledWith('usage report rejected: 当前登录用户无效')
  })

  it('treats a non-JSON body as rejected', async () => {
    const log = vi.fn()
    const fetch = vi.fn(async () => new Response('plain text'))
    await expect(postUsageRecord(record, transport(fetch as unknown as typeof globalThis.fetch, log)))
      .resolves.toBe(false)
    expect(log).toHaveBeenCalledWith('usage report failed: unreadable response body')
  })

  it('treats an unrecognized envelope as rejected', async () => {
    const log = vi.fn()
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    await expect(postUsageRecord(record, transport(fetch as unknown as typeof globalThis.fetch, log)))
      .resolves.toBe(false)
    expect(log).toHaveBeenCalledWith('usage report failed: unrecognized response envelope')
  })
})

describe('usage batch and queue', () => {
  it('derives the Batch URL from the Report URL', () => {
    expect(usageBatchUrl('https://gw.example/api/ai/Usage/Report'))
      .toBe('https://gw.example/api/ai/Usage/Batch')
    expect(usageBatchUrl('https://gw.example/api/ai/Usage/Report/'))
      .toBe('https://gw.example/api/ai/Usage/Batch')
    expect(usageBatchUrl('https://gw.example/api/ai/other')).toBeUndefined()
  })

  it('classifies transport failures as transient and auth rejects as permanent', () => {
    expect(classifyUsageReportFailure({ kind: 'http', status: 500 })).toBe('transient')
    expect(classifyUsageReportFailure({ kind: 'http', status: 429 })).toBe('transient')
    expect(classifyUsageReportFailure({ kind: 'network', message: 'ECONNREFUSED' })).toBe('transient')
    expect(classifyUsageReportFailure({ kind: 'rejected', content: '当前登录用户无效' })).toBe('rejected')
    expect(classifyUsageReportFailure({ kind: 'http', status: 401 })).toBe('rejected')
    expect(classifyUsageReportFailure({ kind: 'http', status: 403 })).toBe('rejected')
  })

  it('posts a Batch body and removes every sent id when the batch succeeds', async () => {
    const directory = tempQueue()
    const pending = [recordOf({ requestId: 'id-1' }), recordOf({ requestId: 'id-2' }), recordOf({ requestId: 'id-3' })]
    const { enqueueUsageRecord } = await import('../src/usage-queue.ts')
    for (const row of pending) enqueueUsageRecord(directory, row)

    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { Success: true, Content: '', Datas: { accepted: 2, duplicates: 1 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await postUsageBatch(pending, {
      url: 'http://gateway.test/api/ai/Usage/Report',
      token: 'token-123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      queueDir: directory,
    })
    expect(result).toEqual({ ok: true, cleared: ['id-1', 'id-2', 'id-3'] })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://gateway.test/api/ai/Usage/Batch')
    expect(JSON.parse(String(init.body))).toEqual({ records: pending })
    expect(listUsageQueue(directory)).toEqual([])
  })

  it('enqueues on transient failure and flushes on the next success', async () => {
    const directory = tempQueue()
    const first = recordOf({ requestId: '550e8400-e29b-41d4-a716-446655440001' })
    const log = vi.fn()
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(reportUsageWithQueue(first, {
      url: 'http://gateway.test/api/ai/Usage/Report',
      token: 'token-123',
      fetch: failing as unknown as typeof globalThis.fetch,
      log,
      queueDir: directory,
    })).resolves.toBe(false)
    expect(listUsageQueue(directory)).toEqual([first])

    const ok = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/Usage/Report')) return ack()
      return new Response(JSON.stringify({
        data: { Success: true, Content: '', Datas: { accepted: 1, duplicates: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const next = recordOf({ requestId: '550e8400-e29b-41d4-a716-446655440099' })
    await expect(reportUsageWithQueue(next, {
      url: 'http://gateway.test/api/ai/Usage/Report',
      token: 'token-123',
      fetch: ok as unknown as typeof globalThis.fetch,
      log,
      queueDir: directory,
    })).resolves.toBe(true)
    expect(listUsageQueue(directory)).toEqual([])
  })

  it('does not enqueue permanent auth rejection', async () => {
    const directory = tempQueue()
    const rejected = recordOf({ requestId: '550e8400-e29b-41d4-a716-446655440002' })
    const log = vi.fn()
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { Success: false, Content: '当前登录用户无效' },
    })))
    await expect(reportUsageWithQueue(rejected, {
      url: 'http://gateway.test/api/ai/Usage/Report',
      token: 'token-123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      log,
      queueDir: directory,
    })).resolves.toBe(false)
    expect(listUsageQueue(directory)).toEqual([])
  })
})
