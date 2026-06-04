import type { MealSession } from './mealSessions'

export type FoodPassStatus = 'ok' | 'already_used' | 'needs_payment' | 'not_found' | 'error'

export type QrPayload = {
  raw: string
  token: string
  personId?: string
  personLabel?: string
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
  return validateDemoPass(payload, serviceDay, mealSession)
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

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function getLocalStorage(): Storage | undefined {
  return globalThis.window?.localStorage
}
