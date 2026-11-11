import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageRecord } from '../src/usage-report.ts'
import {
  USAGE_QUEUE_MAX,
  enqueueUsageRecord,
  listUsageQueue,
  removeUsageRecords,
} from '../src/usage-queue.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function queueDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-queue-'))
  directories.push(directory)
  return directory
}

function record(requestId: string): UsageRecord {
  return {
    requestId,
    modelAlias: 'standard',
    inputTokens: 1,
    outputTokens: 2,
    costYuan: 0,
    status: 'ok',
    clientTs: 1_760_000_000_000,
  }
}

describe('usage queue', () => {
  it('persists records and reads them back without a BOM', () => {
    const directory = queueDir()
    expect(enqueueUsageRecord(directory, record('a'))).toBe(true)
    expect(listUsageQueue(directory)).toEqual([record('a')])
    const text = readFileSync(join(directory, 'records.json'), 'utf8')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(JSON.parse(text)).toEqual({ version: 1, records: [record('a')] })
  })

  it('deduplicates by requestId and keeps the first row', () => {
    const directory = queueDir()
    enqueueUsageRecord(directory, record('a'))
    enqueueUsageRecord(directory, { ...record('a'), outputTokens: 99 })
    enqueueUsageRecord(directory, record('b'))
    expect(listUsageQueue(directory)).toEqual([record('a'), record('b')])
  })

  it('drops the oldest rows when the queue exceeds the cap', () => {
    const directory = queueDir()
    for (let index = 0; index < USAGE_QUEUE_MAX + 3; index += 1) {
      enqueueUsageRecord(directory, record(`id-${index}`))
    }
    const listed = listUsageQueue(directory)
    expect(listed).toHaveLength(USAGE_QUEUE_MAX)
    expect(listed[0]?.requestId).toBe('id-3')
    expect(listed.at(-1)?.requestId).toBe(`id-${USAGE_QUEUE_MAX + 2}`)
  })

  it('removes accepted request ids and leaves the rest', () => {
    const directory = queueDir()
    enqueueUsageRecord(directory, record('a'))
    enqueueUsageRecord(directory, record('b'))
    enqueueUsageRecord(directory, record('c'))
    expect(removeUsageRecords(directory, ['a', 'c'])).toBe(2)
    expect(listUsageQueue(directory)).toEqual([record('b')])
  })

  it('returns an empty list when the queue directory is missing', () => {
    expect(listUsageQueue(join(tmpdir(), 'dsh-usage-queue-missing-dir'))).toEqual([])
  })

  it('creates the directory on first enqueue', () => {
    const parent = queueDir()
    const directory = join(parent, 'nested')
    expect(enqueueUsageRecord(directory, record('a'))).toBe(true)
    expect(listUsageQueue(directory)).toEqual([record('a')])
  })
})
