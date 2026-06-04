import type { MealSession } from './mealSessions'

export type FoodPassStatus = 'ok' | 'already_used' | 'needs_payment' | 'not_found' | 'error'

export type QrPayload = {
  raw: string
  token: string
  personId?: string
  personLabel?: string
  day?: string
  paid?: boolean
}

export type FoodPassResult = {
  status: FoodPassStatus
  title: string
  message: string
  serviceDay: string
  token: string
  personId?: string
  personLabel?: string
  mealSessionKey?: string
  mealSessionLabel?: string
  usedAt?: string
}

type FlexibleRecord = Record<string, unknown>

const demoStoragePrefix = 'festival-food-scan'
const memoryStorage = new Map<string, string>()

export function serviceDayFor(date: Date, timeZone = import.meta.env.VITE_FESTIVAL_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function parseQrPayload(rawValue: string): QrPayload {
  const raw = rawValue.trim()
  if (!raw) {
    throw new Error('Empty QR payload')
  }

  const jsonPayload = parseJsonPayload(raw)
  if (jsonPayload) {
    return jsonPayload
  }

  const urlPayload = parseUrlPayload(raw)
  if (urlPayload) {
    return urlPayload
  }

  return {
    raw,
    token: raw,
  }
}

export async function validateFoodPass(
  payload: QrPayload,
  serviceDay: string,
  mealSession: MealSession,
): Promise<FoodPassResult> {
  const endpoint = import.meta.env.VITE_VALIDATE_ENDPOINT
  if (!endpoint) {
    return validateDemoPass(payload, serviceDay, mealSession)
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: validationHeaders(),
    body: JSON.stringify({
      token: payload.token,
      personId: payload.personId,
      personLabel: payload.personLabel,
      qrDay: payload.day,
      serviceDay,
      mealSessionKey: mealSession.key,
      mealSessionLabel: mealSession.label,
      raw: payload.raw,
      scannedAt: new Date().toISOString(),
    }),
  })

  const body = await safeJson(response)
  const record = isRecord(body) ? body : {}
  if (!response.ok) {
    return {
      status: 'error',
      title: 'Check failed',
      message: readString(record, 'message') ?? `HTTP ${response.status}`,
      serviceDay,
      token: payload.token,
      personId: payload.personId,
      personLabel: payload.personLabel,
      mealSessionKey: mealSession.key,
      mealSessionLabel: mealSession.label,
    }
  }

  return normalizeValidationResponse(record, payload, serviceDay, mealSession)
}

export function normalizeValidationResponse(
  body: unknown,
  payload: QrPayload,
  serviceDay: string,
  mealSession?: MealSession,
): FoodPassResult {
  const record = isRecord(body) ? body : {}
  const rawStatus = readString(record, 'status') ?? readString(record, 'state') ?? readString(record, 'result')
  const status = resolveStatus(rawStatus, record)
  const personLabel =
    readString(record, 'personLabel') ??
    readString(record, 'personName') ??
    readString(record, 'name') ??
    payload.personLabel
  const personId = readString(record, 'personId') ?? readString(record, 'userId') ?? payload.personId
  const message = readString(record, 'message') ?? defaultMessage(status)

  return {
    status,
    title: statusLabel(status),
    message,
    serviceDay: readString(record, 'serviceDay') ?? serviceDay,
    token: readString(record, 'token') ?? payload.token,
    personId,
    personLabel,
    mealSessionKey: readString(record, 'mealSessionKey') ?? mealSession?.key,
    mealSessionLabel: readString(record, 'mealSessionLabel') ?? mealSession?.label,
    usedAt: readString(record, 'usedAt') ?? readString(record, 'used_at'),
  }
}

export function validateDemoPass(
  payload: QrPayload,
  serviceDay: string,
  mealSession?: MealSession,
): FoodPassResult {
  const token = payload.token.trim()
  const personLabel = payload.personLabel ?? payload.personId ?? token

  if (token.toLowerCase().includes('notfound') || token.toLowerCase().includes('invalid')) {
    return result('not_found', payload, serviceDay, 'No matching meal row', personLabel, mealSession)
  }

  if (payload.paid === false || token.toLowerCase().startsWith('pay:')) {
    return result('needs_payment', payload, serviceDay, 'Meal payment missing', personLabel, mealSession)
  }

  const key = `${demoStoragePrefix}:${serviceDay}:${mealSession?.key ?? 'default'}`
  const used = readUsedTokens(key)
  if (used[token]) {
    return {
      ...result('already_used', payload, serviceDay, `Used at ${formatTime(used[token])}`, personLabel, mealSession),
      usedAt: used[token],
    }
  }

  const usedAt = new Date().toISOString()
  used[token] = usedAt
  writeUsedTokens(key, used)

  return {
    ...result('ok', payload, serviceDay, 'Meal marked as used', personLabel, mealSession),
    usedAt,
  }
}

export function resetDemoStorageForTests() {
  memoryStorage.clear()
  getLocalStorage()?.clear()
}

function parseJsonPayload(raw: string): QrPayload | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) {
      return null
    }

    const token =
      readString(value, 'token') ??
      readString(value, 'code') ??
      readString(value, 'passId') ??
      readString(value, 'userId') ??
      readString(value, 'personId')

    if (!token) {
      return null
    }

    return {
      raw,
      token,
      personId: readString(value, 'personId') ?? readString(value, 'userId'),
      personLabel: readString(value, 'personLabel') ?? readString(value, 'name'),
      day: readString(value, 'day') ?? readString(value, 'serviceDay'),
      paid: readBoolean(value, 'paid'),
    }
  } catch {
    return null
  }
}

function parseUrlPayload(raw: string): QrPayload | null {
  try {
    const url = new URL(raw)
    const params = url.searchParams
    const token =
      params.get('token') ??
      params.get('code') ??
      params.get('passId') ??
      params.get('userId') ??
      params.get('personId')

    if (!token) {
      return null
    }

    return {
      raw,
      token,
      personId: params.get('personId') ?? params.get('userId') ?? undefined,
      personLabel: params.get('personLabel') ?? params.get('name') ?? undefined,
      day: params.get('day') ?? params.get('serviceDay') ?? undefined,
      paid: parseBooleanParam(params.get('paid')),
    }
  } catch {
    return null
  }
}

function validationHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const apiToken = import.meta.env.VITE_VALIDATE_API_TOKEN
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`
  }

  const apiKey = import.meta.env.VITE_VALIDATE_API_KEY
  if (apiKey) {
    headers['X-API-Key'] = apiKey
  }

  return headers
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

function resolveStatus(rawStatus: string | undefined, record: FlexibleRecord): FoodPassStatus {
  const status = rawStatus?.toLowerCase().replaceAll('-', '_')
  if (status === 'ok' || status === 'valid' || status === 'allowed' || status === 'success') {
    return 'ok'
  }
  if (status === 'already_used' || status === 'used' || status === 'duplicate') {
    return 'already_used'
  }
  if (status === 'needs_payment' || status === 'payment_required' || status === 'unpaid') {
    return 'needs_payment'
  }
  if (status === 'not_found' || status === 'unknown' || status === 'invalid') {
    return 'not_found'
  }

  if (readBoolean(record, 'needsPayment') || readBoolean(record, 'paymentRequired')) {
    return 'needs_payment'
  }
  if (readBoolean(record, 'usedToday') || readBoolean(record, 'used')) {
    return 'already_used'
  }
  if (readBoolean(record, 'allowed') || readBoolean(record, 'valid')) {
    return 'ok'
  }

  return 'error'
}

function readUsedTokens(key: string): Record<string, string> {
  try {
    const value = getLocalStorage()?.getItem(key) ?? memoryStorage.get(key)
    if (!value) {
      return {}
    }
    const parsed = JSON.parse(value) as unknown
    return isStringMap(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeUsedTokens(key: string, used: Record<string, string>) {
  const value = JSON.stringify(used)
  const storage = getLocalStorage()
  if (storage) {
    storage.setItem(key, value)
    return
  }
  memoryStorage.set(key, value)
}

function result(
  status: FoodPassStatus,
  payload: QrPayload,
  serviceDay: string,
  message: string,
  personLabel?: string,
  mealSession?: MealSession,
): FoodPassResult {
  return {
    status,
    title: statusLabel(status),
    message,
    serviceDay,
    token: payload.token,
    personId: payload.personId,
    personLabel,
    mealSessionKey: mealSession?.key,
    mealSessionLabel: mealSession?.label,
  }
}

function statusLabel(status: FoodPassStatus): string {
  switch (status) {
    case 'ok':
      return 'Meal valid'
    case 'already_used':
      return 'Already used'
    case 'needs_payment':
      return 'Payment needed'
    case 'not_found':
      return 'Unknown pass'
    case 'error':
      return 'Check failed'
  }
}

function defaultMessage(status: FoodPassStatus): string {
  switch (status) {
    case 'ok':
      return 'Meal marked as used for today'
    case 'already_used':
      return 'Pass already used today'
    case 'needs_payment':
      return 'Meal payment missing'
    case 'not_found':
      return 'No matching meal row'
    case 'error':
      return 'Validation response was not recognized'
  }
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

function readBoolean(record: FlexibleRecord, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function parseBooleanParam(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined
  }
  if (value === 'true' || value === '1') {
    return true
  }
  if (value === 'false' || value === '0') {
    return false
  }
  return undefined
}

function isRecord(value: unknown): value is FlexibleRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function getLocalStorage(): Storage | undefined {
  return globalThis.window?.localStorage
}
