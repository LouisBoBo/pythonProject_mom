/**
 * A provider that answers a streaming request with a plain body instead of SSE.
 *
 * The company gateway reports business failures as HTTP 200 plus a JSON envelope
 * (`data.Success === false`, reason in `data.Content`). An SSE parser reads that
 * as a stream that ended before its terminal event, so the harness retries five
 * times and reports an English transport error. Rewriting the response into 4xx
 * with the server's own sentence makes the failure non-retryable and readable.
 */

import type { FetchFunction } from '@earendil-works/pi-ai'

/** Business failures that ask the caller to come back later keep 429 semantics. */
const RETRYABLE = /限流|频率|请求过多|稍后重试|rate.?limit|too many requests/i

const EMPTY_BODY = '模型服务返回了空响应，请稍后重试'
const MAX_MESSAGE = 200

/**
 * Whether the request asked the provider to stream.
 * @param init - the fetch init pi-ai built for this call.
 * @returns true when the JSON body carries `stream: true`.
 */
export function requestsStream(init: RequestInit | undefined): boolean {
  if (typeof init?.body !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(init.body)
    return typeof parsed === 'object' && parsed !== null && (parsed as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

/**
 * Whether the response promises an event stream.
 * @param response - provider response.
 * @returns true when the content type is `text/event-stream`.
 */
export function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
}

/**
 * Pull the server's own explanation out of a JSON body.
 * @param text - response body.
 * @returns the business message, or undefined when the body carries none.
 */
export function readBusinessMessage(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const data = typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : undefined
  const error = typeof record.error === 'object' && record.error !== null
    ? record.error as Record<string, unknown>
    : undefined
  for (const candidate of [data?.Content, data?.msg, error?.message, record.message, record.msg]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * Turn a plain body into the 4xx the SSE path never produced.
 * @param text - response body of a streaming request that did not stream.
 * @returns the status and message to answer with, or undefined when the body is
 *   still an SSE stream that only lacked the content type.
 */
export function plainBodyFailure(text: string): { status: number; message: string } | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('data:')) return undefined
  if (trimmed === '') return { status: 400, message: EMPTY_BODY }
  const message = readBusinessMessage(trimmed) ?? firstLine(trimmed)
  return { status: RETRYABLE.test(message) ? 429 : 400, message: message.slice(0, MAX_MESSAGE) }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u)[0]?.trim() || text.slice(0, 40)
}

/**
 * Wrap a fetch so a streaming call answered with a plain body fails fast with
 * the server's message instead of a retried transport error.
 * @param base - fetch pi-ai would use; global fetch when omitted.
 * @returns a fetch that passes everything else through untouched.
 */
export function guardStreamResponseFetch(base?: FetchFunction): FetchFunction {
  const underlying = base ?? globalThis.fetch
  return async (input, init) => {
    const response = await underlying(input, init)
    if (!response.ok || !requestsStream(init) || isEventStream(response)) return response
    const text = await response.text()
    const failure = plainBodyFailure(text)
    if (failure === undefined) {
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      return new Response(text, { status: response.status, statusText: response.statusText, headers })
    }
    return new Response(failure.message, {
      status: failure.status,
      statusText: failure.status === 429 ? 'Too Many Requests' : 'Bad Request',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}
