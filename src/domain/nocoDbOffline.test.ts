import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mealSessions } from './mealSessions'
import {
  resetOfflineStoreForTests,
  validateOfflineScan,
} from './nocoDbOffline'
import type { ScanSessionSnapshot, StoredMealRecord } from './nocoDbOffline'

const mealSession = mealSessions[0]

describe('offline NocoDB scan validation', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_NOCODB_BASE_URL', 'https://sheets.example')
    vi.stubEnv('VITE_NOCODB_TABLE_ID', 'table-id')
    vi.stubEnv('VITE_NOCODB_TOKEN', 'token')
    resetOfflineStoreForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetOfflineStoreForTests()
  })

  it('uses duplicate email rows as multiple passes for the same meal', () => {
    const snapshot = snapshotWithRecords([
      record({ id: 1, personLabel: 'Ada One' }),
      record({ id: 2, personLabel: 'Ada Two' }),
    ])
    const payload = { raw: 'ada@example.com', token: 'ada@example.com' }

    const first = validateOfflineScan(snapshot, payload, mealSession, '2026-06-05')
    expect(first.result).toMatchObject({
      status: 'ok',
      personLabel: 'Ada One',
    })
    expect(first.pendingCount).toBe(1)

    const second = validateOfflineScan(first.snapshot, payload, mealSession, '2026-06-05')
    expect(second.result).toMatchObject({
      status: 'ok',
      personLabel: 'Ada Two',
    })
    expect(second.pendingCount).toBe(2)

    const third = validateOfflineScan(second.snapshot, payload, mealSession, '2026-06-05')
    expect(third.result.status).toBe('already_used')
  })

  it('blocks an email when no duplicate row is paid and entitled for the meal', () => {
    const snapshot = snapshotWithRecords([
      record({ id: 1, paymentDate: undefined }),
      record({ id: 2, entitlements: { [mealSession.key]: false } }),
    ])

    const result = validateOfflineScan(
      snapshot,
      { raw: 'ada@example.com', token: 'ada@example.com' },
      mealSession,
      '2026-06-05',
    )

    expect(result.result.status).toBe('needs_payment')
    expect(result.pendingCount).toBe(0)
  })
})

function snapshotWithRecords(records: StoredMealRecord[]): ScanSessionSnapshot {
  return {
    serviceDay: '2026-06-05',
    downloadedAt: '2026-06-05T08:00:00.000Z',
    source: 'remote',
    records,
  }
}

function record(overrides: Partial<StoredMealRecord>): StoredMealRecord {
  return {
    id: 1,
    email: 'ada@example.com',
    personLabel: 'Ada',
    paymentDate: '2026-06-01 10:00:00+00:00',
    entitlements: { [mealSession.key]: true },
    scannedAt: {},
    scannedFieldPresent: { [mealSession.key]: true },
    ...overrides,
  }
}
