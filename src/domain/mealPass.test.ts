import { beforeEach, describe, expect, it } from 'vitest'
import {
  parseQrPayload,
  resetDemoStorageForTests,
  serviceDayFor,
  validateDemoPass,
} from './mealPass'

describe('meal pass parsing', () => {
  it('accepts a plain email QR payload', () => {
    expect(parseQrPayload(' ada@example.com ')).toEqual({
      raw: 'ada@example.com',
      token: 'ada@example.com',
    })
  })
})

describe('service day', () => {
  it('formats day in the configured festival timezone', () => {
    const day = serviceDayFor(new Date('2026-06-03T23:30:00.000Z'), 'Europe/Paris')
    expect(day).toBe('2026-06-04')
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
