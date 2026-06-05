import { mealSessions } from './mealSessions'
import type { MealSession } from './mealSessions'
import type { FoodPassResult, QrPayload } from './mealPass'

type FlexibleRecord = Record<string, unknown>

export type StoredMealRecord = {
  id: number
  email: string
  personLabel: string
  paymentDate?: string
  arrived: boolean
  entitlements: Record<string, boolean>
  scannedAt: Record<string, string | undefined>
  scannedFieldPresent: Record<string, boolean>
}

export type ScanSessionSnapshot = {
  serviceDay: string
  downloadedAt: string
  source: 'remote' | 'cache' | 'demo'
  records: StoredMealRecord[]
}

type BasePendingScanWrite = {
  id: string
  recordId: number
  email: string
  personLabel: string
  serviceDay: string
  scannedAt: string
  createdAt: string
}

export type MealPendingScanWrite = BasePendingScanWrite & {
  kind?: 'meal'
  mealSessionKey: string
  mealSessionLabel: string
}

export type ArrivalPendingScanWrite = BasePendingScanWrite & {
  kind: 'arrival'
}

export type PendingScanWrite = MealPendingScanWrite | ArrivalPendingScanWrite

export type SessionStartResult = {
  snapshot: ScanSessionSnapshot
  source: ScanSessionSnapshot['source']
  message: string
  pendingCount: number
}

export type StartScanSessionOptions = {
  skipRemote?: boolean
  timeoutMs?: number
  targetLabel?: string
}

export type SnapshotRefreshResult = {
  snapshot: ScanSessionSnapshot
  message: string
  pendingCount: number
}

export type OfflineScanResult = {
  result: FoodPassResult
  snapshot: ScanSessionSnapshot
  pendingCount: number
}

export type SyncResult = {
  pendingCount: number
  syncedCount: number
  failedCount: number
  message: string
}

export type SyncPendingScansOptions = {
  timeoutMs?: number
}

const snapshotStorageKey = 'festival-food-scan:nocodb:snapshot'
const pendingStorageKey = 'festival-food-scan:nocodb:pending'
const nocoDbReadTimeoutMs = 2200
const nocoDbWriteTimeoutMs = 1800
const memoryStorage = new Map<string, string>()

export function hasNocoDbConfig(): boolean {
  return Boolean(
    import.meta.env.VITE_NOCODB_BASE_URL &&
      import.meta.env.VITE_NOCODB_TABLE_ID &&
      import.meta.env.VITE_NOCODB_TOKEN,
  )
}

export async function startScanSession(
  mealSession: MealSession,
  serviceDay: string,
  options: StartScanSessionOptions = {},
): Promise<SessionStartResult> {
  const targetLabel = options.targetLabel ?? mealSession.label

  if (!hasNocoDbConfig()) {
    const snapshot = applyPendingScans({
      serviceDay,
      downloadedAt: new Date().toISOString(),
      source: 'demo',
      records: [],
    })
    saveSnapshot(snapshot)

    return {
      snapshot,
      source: 'demo',
      message: `Demo session ready for ${targetLabel}`,
      pendingCount: loadPendingScans().length,
    }
  }

  if (options.skipRemote) {
    return startCachedSession(targetLabel, 'Offline mode')
  }

  const syncResult = await syncPendingScans({ timeoutMs: options.timeoutMs })

  try {
    const snapshot = applyPendingScans({
      serviceDay,
      downloadedAt: new Date().toISOString(),
      source: 'remote',
      records: await fetchAllRecords(undefined, options.timeoutMs ?? nocoDbReadTimeoutMs),
    })
    saveSnapshot(snapshot)

    return {
      snapshot,
      source: 'remote',
      message: `Downloaded ${snapshot.records.length} rows`,
      pendingCount: syncResult.pendingCount,
    }
  } catch (error) {
    const cached = loadSnapshot()
    if (!cached) {
      throw new Error(error instanceof Error ? error.message : 'Cannot download NocoDB rows and no cache exists', {
        cause: error,
      })
    }

    const snapshot = applyPendingScans({
      ...cached,
      source: 'cache',
    })
    saveSnapshot(snapshot)

    return {
      snapshot,
      source: 'cache',
      message: `Offline mode using ${snapshot.records.length} cached rows`,
      pendingCount: loadPendingScans().length,
    }
  }
}

export async function refreshScanSessionSnapshot(
  serviceDay: string,
  signal?: AbortSignal,
  timeoutMs = nocoDbReadTimeoutMs,
): Promise<SnapshotRefreshResult> {
  if (!hasNocoDbConfig()) {
    const cached = loadSnapshot()
    const snapshot = applyPendingScans(
      cached ?? {
        serviceDay,
        downloadedAt: new Date().toISOString(),
        source: 'demo',
        records: [],
      },
    )
    saveSnapshot(snapshot)

    return {
      snapshot,
      message: 'Demo cache ready',
      pendingCount: loadPendingScans().length,
    }
  }

  const snapshot = applyPendingScans({
    serviceDay,
    downloadedAt: new Date().toISOString(),
    source: 'remote',
    records: await fetchAllRecords(signal, timeoutMs),
  })
  saveSnapshot(snapshot)

  return {
    snapshot,
    message: `DB checked ${snapshot.records.length} rows`,
    pendingCount: loadPendingScans().length,
  }
}

export function validateOfflineScan(
  snapshot: ScanSessionSnapshot,
  payload: QrPayload,
  mealSession: MealSession,
  serviceDay: string,
): OfflineScanResult {
  if (!hasNocoDbConfig()) {
    const result = validateDemoSnapshot(payload, serviceDay, mealSession)
    return {
      result,
      snapshot,
      pendingCount: loadPendingScans().length,
    }
  }

  const email = normalizeEmail(payload.token)
  if (!email) {
    return unchanged(snapshot, result('not_found', payload, serviceDay, 'QR code must contain an email', undefined, mealSession))
  }

  const matchingRecords = snapshot.records.filter((record) => record.email === email)
  if (matchingRecords.length === 0) {
    return unchanged(snapshot, result('not_found', payload, serviceDay, 'No row found for this email', email, mealSession))
  }

  if (matchingRecords.every((record) => record.scannedFieldPresent[mealSession.key] !== true)) {
    return unchanged(
      snapshot,
      result(
        'error',
        payload,
        serviceDay,
        `Missing "${mealSession.scannedAtField}" DateTime column in NocoDB`,
        matchingRecords[0].personLabel,
        mealSession,
      ),
    )
  }

  const eligibleRecords = matchingRecords
    .filter(
      (record) =>
        record.paymentDate &&
        record.entitlements[mealSession.key] === true &&
        record.scannedFieldPresent[mealSession.key] === true,
    )
    .sort((a, b) => a.id - b.id)

  const availableRecord = eligibleRecords.find((record) => !record.scannedAt[mealSession.key])
  if (!availableRecord && eligibleRecords.length > 0) {
    const latestScan = eligibleRecords
      .map((record) => record.scannedAt[mealSession.key])
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1)

    return unchanged(
      snapshot,
      {
        ...result(
          'already_used',
          payload,
          serviceDay,
          `All ${eligibleRecords.length} pass${eligibleRecords.length === 1 ? '' : 'es'} for ${mealSession.label} are used`,
          email,
          mealSession,
        ),
        usedAt: latestScan,
      },
    )
  }

  if (!availableRecord) {
    return unchanged(
      snapshot,
      result('needs_payment', payload, serviceDay, `No paid pass for ${mealSession.label}`, email, mealSession),
    )
  }

  const record = availableRecord
  const scannedAt = formatNocoDbDateTime(new Date())
  const updatedRecord: StoredMealRecord = {
    ...record,
    scannedAt: {
      ...record.scannedAt,
      [mealSession.key]: scannedAt,
    },
  }
  const updatedSnapshot = {
    ...snapshot,
    records: snapshot.records.map((item) => (item.id === record.id ? updatedRecord : item)),
  }

  enqueuePendingScan({
    id: crypto.randomUUID(),
    recordId: record.id,
    email: record.email,
    personLabel: record.personLabel,
    serviceDay,
    mealSessionKey: mealSession.key,
    mealSessionLabel: mealSession.label,
    scannedAt,
    createdAt: new Date().toISOString(),
  })
  saveSnapshot(updatedSnapshot)

  return {
    result: {
      ...result('ok', payload, serviceDay, `Marked ${mealSession.label}. Sync queued.`, record.personLabel, mealSession),
      usedAt: scannedAt,
    },
    snapshot: updatedSnapshot,
    pendingCount: loadPendingScans().length,
  }
}

export function validateOfflineArrival(
  snapshot: ScanSessionSnapshot,
  payload: QrPayload,
  serviceDay: string,
): OfflineScanResult {
  if (!hasNocoDbConfig()) {
    const result = validateDemoArrival(payload, serviceDay)
    return {
      result,
      snapshot,
      pendingCount: loadPendingScans().length,
    }
  }

  const email = normalizeEmail(payload.token)
  if (!email) {
    return unchanged(snapshot, arrivalResult('not_found', payload, serviceDay, 'QR code must contain an email', undefined))
  }

  const matchingRecords = snapshot.records.filter((record) => record.email === email)
  if (matchingRecords.length === 0) {
    return unchanged(snapshot, arrivalResult('not_found', payload, serviceDay, 'No row found for this email', email))
  }

  const paidRecords = matchingRecords.filter((record) => record.paymentDate).sort((a, b) => a.id - b.id)
  const availableRecord = paidRecords.find((record) => !record.arrived)
  if (!availableRecord && paidRecords.length > 0) {
    return unchanged(
      snapshot,
      arrivalResult(
        'already_used',
        payload,
        serviceDay,
        `All ${paidRecords.length} arrival pass${paidRecords.length === 1 ? '' : 'es'} are already used`,
        email,
      ),
    )
  }

  if (!availableRecord) {
    return unchanged(snapshot, arrivalResult('needs_payment', payload, serviceDay, 'Payment missing', email))
  }

  const scannedAt = formatNocoDbDateTime(new Date())
  const updatedRecord: StoredMealRecord = {
    ...availableRecord,
    arrived: true,
  }
  const updatedSnapshot = {
    ...snapshot,
    records: snapshot.records.map((item) => (item.id === availableRecord.id ? updatedRecord : item)),
  }

  enqueuePendingScan({
    kind: 'arrival',
    id: crypto.randomUUID(),
    recordId: availableRecord.id,
    email: availableRecord.email,
    personLabel: availableRecord.personLabel,
    serviceDay,
    scannedAt,
    createdAt: new Date().toISOString(),
  })
  saveSnapshot(updatedSnapshot)

  return {
    result: {
      ...arrivalResult('ok', payload, serviceDay, 'Arrival marked. Sync queued.', availableRecord.personLabel),
      usedAt: scannedAt,
    },
    snapshot: updatedSnapshot,
    pendingCount: loadPendingScans().length,
  }
}

export async function syncPendingScans(options: SyncPendingScansOptions = {}): Promise<SyncResult> {
  const pending = loadPendingScans()
  if (pending.length === 0) {
    return {
      pendingCount: 0,
      syncedCount: 0,
      failedCount: 0,
      message: 'No pending writes',
    }
  }

  if (!hasNocoDbConfig()) {
    return {
      pendingCount: pending.length,
      syncedCount: 0,
      failedCount: pending.length,
      message: 'NocoDB is not configured',
    }
  }

  const remaining: PendingScanWrite[] = []
  let syncedCount = 0

  for (const [index, scan] of pending.entries()) {
    try {
      await patchNocoDbScan(scan, options.timeoutMs ?? nocoDbWriteTimeoutMs)
      syncedCount += 1
    } catch {
      remaining.push(scan)
      remaining.push(...pending.slice(index + 1))
      break
    }
  }

  savePendingScans(remaining)
  return {
    pendingCount: remaining.length,
    syncedCount,
    failedCount: remaining.length,
    message:
      remaining.length === 0
        ? `Synced ${syncedCount} write${syncedCount === 1 ? '' : 's'}`
        : `Synced ${syncedCount}, ${remaining.length} still queued`,
  }
}

export function pendingScanCount(): number {
  return loadPendingScans().length
}

export function loadCachedSnapshot(): ScanSessionSnapshot | null {
  const snapshot = loadSnapshot()
  return snapshot ? applyPendingScans(snapshot) : null
}

export function resetOfflineStoreForTests() {
  getLocalStorage()?.removeItem(snapshotStorageKey)
  getLocalStorage()?.removeItem(pendingStorageKey)
  memoryStorage.clear()
}

function startCachedSession(targetLabel: string, prefix: string): SessionStartResult {
  const cached = loadSnapshot()
  if (!cached) {
    throw new Error('Cannot download NocoDB rows and no cache exists')
  }

  const snapshot = applyPendingScans({
    ...cached,
    source: 'cache',
  })
  saveSnapshot(snapshot)

  return {
    snapshot,
    source: 'cache',
    message: `${prefix} using ${snapshot.records.length} cached rows for ${targetLabel}`,
    pendingCount: loadPendingScans().length,
  }
}

async function fetchAllRecords(signal?: AbortSignal, timeoutMs = nocoDbReadTimeoutMs): Promise<StoredMealRecord[]> {
  const rows: FlexibleRecord[] = []
  let page = 1
  let isLastPage = false

  while (!isLastPage) {
    const url = nocoDbUrl(`/api/v2/tables/${import.meta.env.VITE_NOCODB_TABLE_ID}/records`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', '1000')

    const timeout = timeoutSignal(timeoutMs, signal)
    try {
      const response = await fetch(url, {
        headers: nocoDbHeaders(),
        signal: timeout.signal,
      })
      const body = await safeJson(response)
      if (!response.ok) {
        throw new Error(nocoDbErrorMessage(body, `NocoDB download failed with HTTP ${response.status}`))
      }

      rows.push(...nocoDbRecords(body))
      isLastPage = nocoDbIsLastPage(body)
      page += 1
    } finally {
      timeout.cleanup()
    }
  }

  return rows.map(nocoDbRowToStoredRecord).filter((record) => record.email)
}

function nocoDbRowToStoredRecord(row: FlexibleRecord): StoredMealRecord {
  const email = normalizeEmail(readString(row, 'Email') ?? '')
  const personLabel = readString(row, 'Nom') ?? email
  const entitlements: Record<string, boolean> = {}
  const scannedAt: Record<string, string | undefined> = {}
  const scannedFieldPresent: Record<string, boolean> = {}

  for (const session of mealSessions) {
    entitlements[session.key] = readBoolean(row, session.entitlementField) === true
    scannedAt[session.key] = readString(row, session.scannedAtField)
    scannedFieldPresent[session.key] = session.scannedAtField in row
  }

  return {
    id: readNumber(row, 'Id') ?? 0,
    email,
    personLabel,
    paymentDate: readString(row, 'Date paiement'),
    arrived: readBoolean(row, 'Arrivé') === true,
    entitlements,
    scannedAt,
    scannedFieldPresent,
  }
}

async function patchNocoDbScan(scan: PendingScanWrite, timeoutMs = nocoDbWriteTimeoutMs): Promise<void> {
  const patch =
    scan.kind === 'arrival'
      ? {
          Id: scan.recordId,
          Arrivé: true,
        }
      : mealScanPatch(scan)
  if (!patch) {
    throw new Error(`Unknown meal session ${'mealSessionKey' in scan ? scan.mealSessionKey : ''}`)
  }

  const timeout = timeoutSignal(timeoutMs)
  try {
    const response = await fetch(nocoDbUrl(`/api/v2/tables/${import.meta.env.VITE_NOCODB_TABLE_ID}/records`), {
      method: 'PATCH',
      headers: {
        ...nocoDbHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([patch]),
      signal: timeout.signal,
    })

    if (!response.ok) {
      const body = await safeJson(response)
      throw new Error(nocoDbErrorMessage(body, `NocoDB update failed with HTTP ${response.status}`))
    }
  } finally {
    timeout.cleanup()
  }
}

function mealScanPatch(scan: MealPendingScanWrite): Record<string, unknown> | null {
  const mealSession = mealSessions.find((session) => session.key === scan.mealSessionKey)
  if (!mealSession) {
    return null
  }

  return {
    Id: scan.recordId,
    [mealSession.scannedAtField]: scan.scannedAt,
    Arrivé: true,
  }
}

function validateDemoSnapshot(
  payload: QrPayload,
  serviceDay: string,
  mealSession: MealSession,
): FoodPassResult {
  const key = `festival-food-scan:demo:${serviceDay}:${mealSession.key}`
  const email = normalizeEmail(payload.token) || payload.token.trim()
  const used = readStringMap(key)
  if (payload.paid === false || email.toLowerCase().startsWith('pay:')) {
    return result('needs_payment', payload, serviceDay, 'Meal payment missing', email, mealSession)
  }
  if (email.toLowerCase().includes('notfound') || email.toLowerCase().includes('invalid')) {
    return result('not_found', payload, serviceDay, 'No matching meal row', email, mealSession)
  }
  if (used[email]) {
    return {
      ...result('already_used', payload, serviceDay, `Used at ${formatTime(used[email])}`, email, mealSession),
      usedAt: used[email],
    }
  }

  const scannedAt = new Date().toISOString()
  used[email] = scannedAt
  writeStringMap(key, used)
  return {
    ...result('ok', payload, serviceDay, `Marked ${mealSession.label}`, email, mealSession),
    usedAt: scannedAt,
  }
}

function validateDemoArrival(payload: QrPayload, serviceDay: string): FoodPassResult {
  const key = `festival-food-scan:demo:arrival:${serviceDay}`
  const email = normalizeEmail(payload.token) || payload.token.trim()
  const used = readStringMap(key)
  if (payload.paid === false || email.toLowerCase().startsWith('pay:')) {
    return arrivalResult('needs_payment', payload, serviceDay, 'Payment missing', email)
  }
  if (email.toLowerCase().includes('notfound') || email.toLowerCase().includes('invalid')) {
    return arrivalResult('not_found', payload, serviceDay, 'No matching row', email)
  }
  if (used[email]) {
    return {
      ...arrivalResult('already_used', payload, serviceDay, `Used at ${formatTime(used[email])}`, email),
      usedAt: used[email],
    }
  }

  const scannedAt = new Date().toISOString()
  used[email] = scannedAt
  writeStringMap(key, used)
  return {
    ...arrivalResult('ok', payload, serviceDay, 'Arrival marked', email),
    usedAt: scannedAt,
  }
}

function applyPendingScans(snapshot: ScanSessionSnapshot): ScanSessionSnapshot {
  const pending = loadPendingScans()
  if (pending.length === 0) {
    return snapshot
  }

  return {
    ...snapshot,
    records: snapshot.records.map((record) => {
      const recordWrites = pending.filter((scan) => scan.recordId === record.id)
      if (recordWrites.length === 0) {
        return record
      }

      return {
        ...record,
        arrived: recordWrites.some((scan) => scan.kind === 'arrival') || record.arrived,
        scannedAt: recordWrites.reduce(
          (acc, scan) => ({
            ...acc,
            ...('mealSessionKey' in scan ? { [scan.mealSessionKey]: scan.scannedAt } : {}),
          }),
          record.scannedAt,
        ),
      }
    }),
  }
}

function arrivalResult(
  status: FoodPassResult['status'],
  payload: QrPayload,
  serviceDay: string,
  message: string,
  personLabel: string | undefined,
): FoodPassResult {
  return {
    status,
    title: statusLabel(status),
    message,
    serviceDay,
    token: payload.token,
    personLabel,
  }
}

function unchanged(snapshot: ScanSessionSnapshot, result: FoodPassResult): OfflineScanResult {
  return {
    result,
    snapshot,
    pendingCount: loadPendingScans().length,
  }
}

function enqueuePendingScan(scan: PendingScanWrite) {
  savePendingScans([...loadPendingScans(), scan])
}

function loadSnapshot(): ScanSessionSnapshot | null {
  return readJson(snapshotStorageKey)
}

function saveSnapshot(snapshot: ScanSessionSnapshot) {
  writeJson(snapshotStorageKey, snapshot)
}

function loadPendingScans(): PendingScanWrite[] {
  const value = readJson<unknown>(pendingStorageKey)
  return Array.isArray(value) ? value.filter(isPendingScanWrite) : []
}

function savePendingScans(scans: PendingScanWrite[]) {
  writeJson(pendingStorageKey, scans)
}

function nocoDbUrl(path: string): URL {
  const baseUrl = String(import.meta.env.VITE_NOCODB_BASE_URL).replace(/\/$/, '')
  return new URL(path, baseUrl)
}

function nocoDbHeaders(): HeadersInit {
  return {
    'xc-token': import.meta.env.VITE_NOCODB_TOKEN,
  }
}

function timeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  const timeoutId = window.setTimeout(() => controller.abort(new Error('NocoDB request timeout')), timeoutMs)

  if (parentSignal?.aborted) {
    abortFromParent()
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timeoutId)
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

async function safeJson(response: Response): Promise<unknown | null> {
  const text = await response.text()
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text }
  }
}

function nocoDbRecords(body: unknown): FlexibleRecord[] {
  if (!isRecord(body) || !Array.isArray(body.list)) {
    return []
  }
  return body.list.filter(isRecord)
}

function nocoDbIsLastPage(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.pageInfo)) {
    return true
  }
  return body.pageInfo.isLastPage === true
}

function nocoDbErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    return readString(body, 'msg') ?? readString(body, 'message') ?? fallback
  }
  return fallback
}

function result(
  status: FoodPassResult['status'],
  payload: QrPayload,
  serviceDay: string,
  message: string,
  personLabel: string | undefined,
  mealSession: MealSession,
): FoodPassResult {
  return {
    status,
    title: statusLabel(status),
    message,
    serviceDay,
    token: payload.token,
    personLabel,
    mealSessionKey: mealSession.key,
    mealSessionLabel: mealSession.label,
  }
}

function statusLabel(status: FoodPassResult['status']): string {
  switch (status) {
    case 'ok':
      return 'Oui'
    case 'already_used':
      return 'Déjà scanné'
    case 'needs_payment':
      return 'Non payé'
    case 'not_found':
      return 'Inconnu'
    case 'error':
      return 'Erreur'
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  return email.includes('@') ? email : ''
}

function formatNocoDbDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '+00:00')
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function readString(record: FlexibleRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(record: FlexibleRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: FlexibleRecord, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function readStringMap(key: string): Record<string, string> {
  const value = readJson<unknown>(key)
  return isStringMap(value) ? value : {}
}

function writeStringMap(key: string, value: Record<string, string>) {
  writeJson(key, value)
}

function readJson<T>(key: string): T | null {
  try {
    const value = getLocalStorage()?.getItem(key) ?? memoryStorage.get(key)
    return value ? (JSON.parse(value) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  const serialized = JSON.stringify(value)
  const storage = getLocalStorage()
  if (storage) {
    storage.setItem(key, serialized)
    return
  }
  memoryStorage.set(key, serialized)
}

function getLocalStorage(): Storage | undefined {
  return globalThis.window?.localStorage
}

function isRecord(value: unknown): value is FlexibleRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

function isPendingScanWrite(value: unknown): value is PendingScanWrite {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.recordId !== 'number' ||
    typeof value.email !== 'string' ||
    typeof value.personLabel !== 'string' ||
    typeof value.serviceDay !== 'string' ||
    typeof value.scannedAt !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return false
  }

  if (value.kind === 'arrival') {
    return true
  }

  return (
    (value.kind === undefined || value.kind === 'meal') &&
    typeof value.mealSessionKey === 'string' &&
    typeof value.mealSessionLabel === 'string'
  )
}
