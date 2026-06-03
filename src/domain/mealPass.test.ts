import { beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeValidationResponse,
  parseQrPayload,
  resetDemoStorageForTests,
  serviceDayFor,
  validateDemoPass,
} from './mealPass'

describe('meal pass parsing', () => {
  it('accepts a plain token', () => {
    expect(parseQrPayload('PASS-123')).toEqual({
      raw: 'PASS-123',
      token: 'PASS-123',
    })
  })

  it('accepts JSON QR payloads', () => {
    expect(parseQrPayload('{"token":"abc","personId":"user-1","name":"Ada","paid":false}')).toMatchObject({
      token: 'abc',
      personId: 'user-1',
      personLabel: 'Ada',
      paid: false,
    })
  })

  it('accepts URL QR payloads', () => {
    expect(parseQrPayload('https://festival.test/food?token=abc&personId=user-1&day=2026-06-03')).toMatchObject({
      token: 'abc',
      personId: 'user-1',
      day: '2026-06-03',
    })
  })
})

describe('service day', () => {
  it('formats day in the configured festival timezone', () => {
    const day = serviceDayFor(new Date('2026-06-03T23:30:00.000Z'), 'Europe/Paris')
    expect(day).toBe('2026-06-04')
  })
})

describe('validation normalization', () => {
  it('maps flexible no-code DB status shapes', () => {
    const result = normalizeValidationResponse(
      { usedToday: true, personName: 'Ada Lovelace', message: 'Lunch already scanned' },
      { raw: 'abc', token: 'abc' },
      '2026-06-03',
    )

    expect(result).toMatchObject({
      status: 'already_used',
      personLabel: 'Ada Lovelace',
      message: 'Lunch already scanned',
    })
  })
})

describe('demo validation', () => {
  beforeEach(() => {
    resetDemoStorageForTests()
  })

  it('marks token used once per service day', () => {
    const payload = { raw: 'PASS-1', token: 'PASS-1' }

    expect(validateDemoPass(payload, '2026-06-03').status).toBe('ok')
    expect(validateDemoPass(payload, '2026-06-03').status).toBe('already_used')
    expect(validateDemoPass(payload, '2026-06-04').status).toBe('ok')
  })

  it('flags unpaid demo tokens', () => {
    expect(validateDemoPass({ raw: 'pay:PASS-2', token: 'pay:PASS-2' }, '2026-06-03').status).toBe('needs_payment')
    expect(validateDemoPass({ raw: 'PASS-3', token: 'PASS-3', paid: false }, '2026-06-03').status).toBe('needs_payment')
  })
})
