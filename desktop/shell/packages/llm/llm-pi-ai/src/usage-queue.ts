/**
 * On-disk queue for usage records that failed a best-effort Report post.
 * Stores only UsageRecord bodies — never credentials.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageRecord } from './usage-report.ts'

export const USAGE_QUEUE_MAX = 1_000
const QUEUE_FILE = 'records.json'
const QUEUE_VERSION = 1

interface UsageQueueFile {
  readonly version: number
  readonly records: UsageRecord[]
}

function queuePath(directory: string): string {
  return join(directory, QUEUE_FILE)
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.requestId === 'string'
    && typeof record.modelAlias === 'string'
    && typeof record.inputTokens === 'number'
    && typeof record.outputTokens === 'number'
    && typeof record.costYuan === 'number'
    && typeof record.status === 'string'
    && typeof record.clientTs === 'number'
}

function readQueue(directory: string): UsageRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(queuePath(directory), 'utf8').replace(/^\uFEFF/u, ''))
    if (typeof parsed !== 'object' || parsed === null) return []
    const records = (parsed as { records?: unknown }).records
    if (!Array.isArray(records)) return []
    return records.filter(isUsageRecord)
  } catch {
    return []
  }
}

function writeQueue(directory: string, records: readonly UsageRecord[]): boolean {
  try {
    mkdirSync(directory, { recursive: true })
    const path = queuePath(directory)
    const temporary = `${path}.tmp`
    const body: UsageQueueFile = { version: QUEUE_VERSION, records: [...records] }
    writeFileSync(temporary, `${JSON.stringify(body)}\n`)
    try {
      renameSync(temporary, path)
    } catch {
      rmSync(path, { force: true })
      renameSync(temporary, path)
    }
    return true
  } catch {
    try { rmSync(queuePath(directory) + '.tmp', { force: true }) } catch { /* ignore */ }
    return false
  }
}

/**
 * Append one record. Same requestId keeps the first row. Over the cap, oldest drop.
 * @param directory - queue directory under DSH_HOME.
 * @param record - usage row to keep.
 * @returns false when the directory cannot be written.
 */
export function enqueueUsageRecord(directory: string, record: UsageRecord): boolean {
  const existing = readQueue(directory)
  if (existing.some(row => row.requestId === record.requestId)) return true
  const next = [...existing, record]
  const trimmed = next.length <= USAGE_QUEUE_MAX ? next : next.slice(next.length - USAGE_QUEUE_MAX)
  return writeQueue(directory, trimmed)
}

/**
 * @param directory - queue directory.
 * @returns stored records, or [] when missing/corrupt.
 */
export function listUsageQueue(directory: string): UsageRecord[] {
  if (!existsSync(queuePath(directory))) return []
  return readQueue(directory)
}

/**
 * Drop rows whose requestId is in `requestIds`.
 * @param directory - queue directory.
 * @param requestIds - ids accepted or duplicated by Batch.
 * @returns number of rows removed.
 */
export function removeUsageRecords(directory: string, requestIds: readonly string[]): number {
  if (requestIds.length === 0) return 0
  const drop = new Set(requestIds)
  const existing = readQueue(directory)
  const kept = existing.filter(row => !drop.has(row.requestId))
  const removed = existing.length - kept.length
  if (removed === 0) return 0
  return writeQueue(directory, kept) ? removed : 0
}
