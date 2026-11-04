import { describe, expect, it } from 'vitest'
import { guardStreamResponseFetch, isEventStream, plainBodyFailure, readBusinessMessage, requestsStream } from '../src/stream-guard.ts'

const envelope = JSON.stringify({
  data: { Success: false, Content: '模型服务异常', code: '0', msg: '' },
  code: 200,
  success: true,
})
const streamInit = { body: JSON.stringify({ model: 'standard', stream: true }) }
const plainInit = { body: JSON.stringify({ model: 'standard', stream: false }) }

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

describe('requestsStream', () => {
  it('reads the JSON flag instead of guessing from the method', () => {
    expect(requestsStream(streamInit)).toBe(true)
    expect(requestsStream(plainInit)).toBe(false)
    expect(requestsStream({ body: 'not json' })).toBe(false)
    expect(requestsStream(undefined)).toBe(false)
  })
})

describe('isEventStream', () => {
  it('matches the media type case-insensitively', () => {
    expect(isEventStream(new Response('', { headers: { 'content-type': 'Text/Event-Stream' } }))).toBe(true)
    expect(isEventStream(jsonResponse('{}'))).toBe(false)
  })
})

describe('readBusinessMessage', () => {
  it('prefers the gateway envelope and falls back to OpenAI shapes', () => {
    expect(readBusinessMessage(envelope)).toBe('模型服务异常')
    expect(readBusinessMessage(JSON.stringify({ data: { Success: false, msg: '渠道未配置' } }))).toBe('渠道未配置')
    expect(readBusinessMessage(JSON.stringify({ error: { message: 'invalid key' } }))).toBe('invalid key')
    expect(readBusinessMessage(JSON.stringify({ message: 'busy' }))).toBe('busy')
    expect(readBusinessMessage('<html>not json</html>')).toBeUndefined()
  })
})

describe('plainBodyFailure', () => {
  it('keeps rate limiting retryable and everything else invalid', () => {
    expect(plainBodyFailure(envelope)).toEqual({ status: 400, message: '模型服务异常' })
    expect(plainBodyFailure(JSON.stringify({ data: { Content: '请求过于频繁，请稍后重试' } })))
      .toEqual({ status: 429, message: '请求过于频繁，请稍后重试' })
  })

  it('turns empty and unreadable bodies into a Chinese sentence', () => {
    expect(plainBodyFailure('   ')).toEqual({ status: 400, message: '模型服务返回了空响应，请稍后重试' })
    expect(plainBodyFailure('<html>404</html>')?.message).toBe('<html>404</html>')
    expect(plainBodyFailure('x'.repeat(400))?.message).toHaveLength(200)
  })

  it('leaves a body that really is an event stream alone', () => {
    expect(plainBodyFailure('data: {"choices":[]}\n\n')).toBeUndefined()
  })
})

describe('guardStreamResponseFetch', () => {
  it('turns a 200 JSON answer to a streaming call into the server message', async () => {
    const fetch = guardStreamResponseFetch(async () => jsonResponse(envelope))
    const response = await fetch('https://gateway.example/api/ai/Chat/Completions', streamInit)
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('模型服务异常')
  })

  it('answers 429 when the server asks to retry later', async () => {
    const fetch = guardStreamResponseFetch(async () => jsonResponse(JSON.stringify({ data: { Content: '调用频率超限' } })))
    const response = await fetch('https://gateway.example/api/ai/Chat/Completions', streamInit)
    expect(response.status).toBe(429)
  })

  it('passes real streams, plain calls, and non-200 answers through untouched', async () => {
    const stream = new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    expect(await guardStreamResponseFetch(async () => stream)('u', streamInit)).toBe(stream)

    const plain = jsonResponse('{"choices":[]}')
    expect(await guardStreamResponseFetch(async () => plain)('u', plainInit)).toBe(plain)

    const failure = jsonResponse(envelope, 500)
    expect(await guardStreamResponseFetch(async () => failure)('u', streamInit)).toBe(failure)
  })

  it('keeps a mislabeled event stream readable', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    const response = await guardStreamResponseFetch(async () => jsonResponse(body))('u', streamInit)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
    expect(response.headers.get('content-length')).toBeNull()
  })
})
