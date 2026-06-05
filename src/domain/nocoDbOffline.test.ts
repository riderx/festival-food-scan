import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mealSessions } from './mealSessions'
import {
  refreshScanSessionSnapshot,
  resetOfflineStoreForTests,
  startScanSession,
  syncPendingScans,
  validateOfflineArrival,
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
    vi.unstubAllGlobals()
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

  it('uses fresh NocoDB rows to catch a scan from another phone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse([nocoRow({ [mealSession.scannedAtField]: '2026-06-05 12:00:00+00:00' })])),
    )

    const refresh = await refreshScanSessionSnapshot('2026-06-05')
    const result = validateOfflineScan(
      refresh.snapshot,
      { raw: 'ada@example.com', token: 'ada@example.com' },
      mealSession,
      '2026-06-05',
    )

    expect(result.result).toMatchObject({
      status: 'already_used',
      usedAt: '2026-06-05 12:00:00+00:00',
    })
  })

  it('keeps queued local scans applied after a remote refresh', async () => {
    const localScan = validateOfflineScan(
      snapshotWithRecords([record({ id: 1 })]),
      { raw: 'ada@example.com', token: 'ada@example.com' },
      mealSession,
      '2026-06-05',
    )
    expect(localScan.result.status).toBe('ok')

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([nocoRow()])))

    const refresh = await refreshScanSessionSnapshot('2026-06-05')

    expect(refresh.snapshot.records[0].scannedAt[mealSession.key]).toBe(localScan.result.usedAt)
    expect(refresh.pendingCount).toBe(1)
  })

  it('starts from cached rows without remote work when the network is skipped', async () => {
    validateOfflineScan(
      snapshotWithRecords([record({ id: 1 })]),
      { raw: 'ada@example.com', token: 'ada@example.com' },
      mealSession,
      '2026-06-05',
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await startScanSession(mealSession, '2026-06-05', { skipRemote: true })

    expect(result.source).toBe('cache')
    expect(result.snapshot.records).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops sync after the first network failure and keeps the full queue', async () => {
    const first = validateOfflineScan(
      snapshotWithRecords([record({ id: 1 }), record({ id: 2 })]),
      { raw: 'ada@example.com', token: 'ada@example.com' },
      mealSession,
      '2026-06-05',
    )
    validateOfflineScan(first.snapshot, { raw: 'ada@example.com', token: 'ada@example.com' }, mealSession, '2026-06-05')
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncPendingScans({ timeoutMs: 10 })

    expect(result).toMatchObject({
      pendingCount: 2,
      syncedCount: 0,
      failedCount: 2,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses duplicate email rows as multiple arrival passes', () => {
    const snapshot = snapshotWithRecords([
      record({ id: 1, personLabel: 'Ada One' }),
      record({ id: 2, personLabel: 'Ada Two' }),
    ])
    const payload = { raw: 'ada@example.com', token: 'ada@example.com' }

    const first = validateOfflineArrival(snapshot, payload, '2026-06-05')
    expect(first.result).toMatchObject({
      status: 'ok',
      personLabel: 'Ada One',
    })

    const second = validateOfflineArrival(first.snapshot, payload, '2026-06-05')
    expect(second.result).toMatchObject({
      status: 'ok',
      personLabel: 'Ada Two',
    })

    const third = validateOfflineArrival(second.snapshot, payload, '2026-06-05')
    expect(third.result.status).toBe('already_used')
  })

  it('syncs arrival scans by setting Arrivé only', async () => {
    validateOfflineArrival(
      snapshotWithRecords([record({ id: 1 })]),
      { raw: 'ada@example.com', token: 'ada@example.com' },
      '2026-06-05',
    )
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[1]?.method).toBe('PATCH')
      return jsonResponse([])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncPendingScans()
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>[]

    expect(result.pendingCount).toBe(0)
    expect(body).toEqual([{ Id: 1, Arrivé: true }])
  })
})

function jsonResponse(rows: Record<string, unknown>[]): Response {
  return new Response(
    JSON.stringify({
      list: rows,
      pageInfo: { isLastPage: true },
    }),
    { status: 200 },
  )
}

function nocoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 1,
    Nom: 'Ada',
    Email: 'ada@example.com',
    'Date paiement': '2026-06-01 10:00:00+00:00',
    [mealSession.entitlementField]: true,
    [mealSession.scannedAtField]: undefined,
    ...overrides,
  }
}

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
    arrived: false,
    entitlements: { [mealSession.key]: true },
    scannedAt: {},
    scannedFieldPresent: { [mealSession.key]: true },
    ...overrides,
  }
}
