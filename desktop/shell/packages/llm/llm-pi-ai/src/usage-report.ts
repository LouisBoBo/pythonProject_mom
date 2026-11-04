/**
 * One usage record per finished model call, posted to a deployment-configured
 * endpoint.
 *
 * Reporting is opt-in per route (`usageReportUrl`), so the generic adapter
 * stays provider-neutral and a route without a URL sends nothing. The record
 * carries no prompt text, only counts, status, and a failure message.
 */

import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'

export type UsageReportStatus = 'ok' | 'error' | 'aborted'

/** The wire shape of `POST /api/ai/Usage/Report`. */
export interface UsageRecord {
  readonly requestId: string
  readonly modelAlias: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costYuan: number
  readonly status: UsageReportStatus
  readonly clientTs: number
  readonly latencyMs?: number
  readonly errorMessage?: string
}

export interface UsageRecordInput {
  /** Stable per call; the endpoint keeps the first row for a repeated id. */
  readonly requestId: string
  readonly modelAlias: string
  /** Provider-reported usage; absent when the call failed before reporting any. */
  readonly usage: TokenUsage | undefined
  /** Terminal finish event, absent when the consumer stopped before one arrived. */
  readonly finish: FinishReason | undefined
  /** Whether the caller's own signal aborted the request. */
  readonly callerAborted: boolean
  readonly clientTs: number
  readonly latencyMs: number
  /** Error thrown by the stream; absent on a normal finish. */
  readonly error?: unknown
  /** Credential value to scrub from the failure message. */
  readonly secret?: string
}

export interface UsageRecordTransport {
  readonly url: string
  readonly token: string
  /** Enterprise id the endpoint stamps on the row, taken from the token. */
  readonly enterpriseId?: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
}

/** The company gateway closes idle requests well before this; a report is best-effort. */
export const USAGE_REPORT_TIMEOUT_MS = 3_000
const MAX_ERROR_MESSAGE = 1_000

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Billed prompt tokens: the adapter's `inputTokens` excludes cache reads and
 * writes, while the endpoint's `inputTokens` is the whole prompt.
 * @param usage - provider-reported usage.
 * @returns the prompt total, or undefined when any bucket is not a count.
 */
export function totalInputTokens(usage: TokenUsage): number | undefined {
  const buckets = [usage.inputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  if (!buckets.every(isCount)) return undefined
  const total = buckets.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

/**
 * Map the harness finish reason to the endpoint's status vocabulary.
 * @param finish - terminal finish reason, if one arrived.
 * @param callerAborted - whether the caller cancelled the request.
 * @param error - error thrown by the stream, if any.
 * @returns the status to report.
 */
export function reportStatus(
  finish: FinishReason | undefined,
  callerAborted: boolean,
  error: unknown,
): UsageReportStatus {
  if (callerAborted) return 'aborted'
  if (finish === undefined) return error === undefined ? 'aborted' : 'error'
  switch (finish.kind) {
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
    default:
      return 'ok'
  }
}

/**
 * Strip control characters and the request credential from a failure message.
 * @param text - raw failure text.
 * @param secret - credential value to replace, when one is known.
 * @returns a single-line message no longer than the endpoint's limit.
 */
export function sanitizeErrorMessage(text: string, secret?: string): string {
  let clean = text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (secret !== undefined && secret.length >= 8) clean = clean.split(secret).join('***')
  clean = clean.replace(/\bBearer\s+[\x21-\x7e]+/giu, 'Bearer ***')
  return [...clean].slice(0, MAX_ERROR_MESSAGE).join('')
}

function failureText(finish: FinishReason | undefined, error: unknown): string | undefined {
  if (error !== undefined) return error instanceof Error ? error.message : String(error)
  if (finish?.kind === 'error' || finish?.kind === 'aborted') return finish.failure.message
  return undefined
}

/**
 * Build one usage record, or skip the call when it succeeded without usage.
 *
 * A successful call with no provider usage is a contract violation: writing
 * zeros would silently under-count, so it is dropped and the caller logs.
 * Failed calls are still reported with zero counts, because the endpoint's
 * status field is what records the failure.
 * @param input - observed call facts.
 * @returns the record, or undefined when nothing truthfully can be reported.
 */
export function createUsageRecord(input: UsageRecordInput): UsageRecord | undefined {
  const alias = input.modelAlias.trim()
  if (alias === '' || alias.length > 64) return undefined
  if (input.requestId.length === 0 || input.requestId.length > 64) return undefined
  if (!Number.isSafeInteger(input.clientTs) || input.clientTs <= 0) return undefined

  const status = reportStatus(input.finish, input.callerAborted, input.error)
  const inputTokens = input.usage === undefined ? undefined : totalInputTokens(input.usage)
  const outputTokens = input.usage === undefined ? undefined : input.usage.outputTokens
  const counts = inputTokens !== undefined && isCount(outputTokens)
  if (!counts && status === 'ok') return undefined

  const latency = Number.isFinite(input.latencyMs) && input.latencyMs >= 0
    ? Math.round(input.latencyMs)
    : undefined
  const message = status === 'ok' ? undefined : failureText(input.finish, input.error)

  return {
    requestId: input.requestId,
    modelAlias: alias,
    inputTokens: counts ? inputTokens : 0,
    outputTokens: counts ? outputTokens : 0,
    costYuan: 0,
    status,
    clientTs: input.clientTs,
    ...latency === undefined ? {} : { latencyMs: latency },
    ...message === undefined ? {} : { errorMessage: sanitizeErrorMessage(message, input.secret) },
  }
}

/**
 * Read the enterprise id the gateway wrote into its own JWT.
 *
 * The endpoint takes the usage row's enterprise from `Accept`, while the login
 * token already carries the same value. Echoing it keeps the row attributed
 * without another configuration key, and an absent or zero claim simply sends
 * no segment. The claim is not verified here: the token is sent as the bearer
 * credential anyway, so a tampered payload gains nothing.
 * @param token - the gateway access token, which may not be a JWT at all.
 * @returns the decimal enterprise id, or undefined when the token carries none.
 */
export function enterpriseIdFromToken(token: string): string | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return undefined
    const raw = (payload as Record<string, unknown>).enterprisecid
    const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    return /^[1-9]\d*$/u.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function readFunctionResult(payload: unknown): { Success?: unknown; Content?: unknown } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  return data as { Success?: unknown; Content?: unknown }
}

/**
 * Post one record. Never throws and never waits on retries: a failed report
 * must not reach the conversation, and a repeated request would need the
 * queue/Batch path that reporting does not own yet.
 * @param record - the record to send.
 * @param transport - endpoint, credential, optional fetch override, and log sink.
 * @returns true when the endpoint accepted the record.
 */
export async function postUsageRecord(
  record: UsageRecord,
  transport: UsageRecordTransport,
): Promise<boolean> {
  const log = transport.log ?? ((message: string) => { console.error(message) })
  // The gateway reads the usage row's enterprise from this header; the login
  // token already carries the same id, so no separate setting is needed.
  const accept = transport.enterpriseId === undefined
    ? 'application/json'
    : `application/json, enterprisecode$$${transport.enterpriseId}`
  try {
    const response = await (transport.fetch ?? globalThis.fetch)(transport.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept,
        authorization: `Bearer ${transport.token}`,
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(transport.timeoutMs ?? USAGE_REPORT_TIMEOUT_MS),
    })
    if (!response.ok) {
      log(`usage report failed: HTTP ${response.status}`)
      return false
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      log('usage report failed: unreadable response body')
      return false
    }
    const result = readFunctionResult(payload)
    if (result === undefined) {
      log('usage report failed: unrecognized response envelope')
      return false
    }
    if (result.Success !== true) {
      const content = typeof result.Content === 'string' ? result.Content.trim() : ''
      log(`usage report rejected: ${content === '' ? 'no reason given' : content}`)
      return false
    }
    return true
  } catch (error) {
    log(`usage report failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
