import { describe, it, expect, beforeAll } from 'vitest'
import { changedFields, daysBetween, mask, openNumber, sealBroken, sealNumber, validAba, validateCallback, validateWire, verificationDigest } from './wire-instructions'

beforeAll(() => { process.env.ENCRYPTION_KEY ??= 'a'.repeat(64) })

// 011000015 and 021000021 are published Federal Reserve / clearing routing numbers (not accounts).
const base = { beneficiaryName: 'Acme Capital LP', bankName: 'Example Bank', accountNumber: '0012 3456 789', routingNumber: '011000015' }

describe('validateWire', () => {
  it('normalizes and accepts a domestic wire', () => {
    const v = validateWire(base)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toMatchObject({ accountNumber: '00123456789', routingNumber: '011000015', swiftCode: null })
  })
  it('needs a beneficiary, a bank, an account, and a routing number or SWIFT', () => {
    expect(validateWire({ ...base, beneficiaryName: ' ' }).ok).toBe(false)
    expect(validateWire({ ...base, bankName: '' }).ok).toBe(false)
    expect(validateWire({ ...base, accountNumber: '' }).ok).toBe(false)
    expect(validateWire({ ...base, routingNumber: null }).ok).toBe(false)
    expect(validateWire({ ...base, routingNumber: null, swiftCode: 'exabus33' }).ok).toBe(true)
  })
  it('refuses a routing number that fails the ABA check digit, and a malformed SWIFT', () => {
    expect(validAba('011000015')).toBe(true)
    expect(validAba('021000021')).toBe(true)
    expect(validAba('011000016')).toBe(false)
    expect(validateWire({ ...base, routingNumber: '123456789' }).ok).toBe(false)
    expect(validateWire({ ...base, swiftCode: 'EXAB' }).ok).toBe(false)
  })
})

describe('validateCallback', () => {
  it('needs who, the number and a date not in the future', () => {
    expect(validateCallback({ calledName: 'Jane Doe', calledNumber: '+1 555 0100', calledOn: '2026-11-20' }, '2026-11-23').ok).toBe(true)
    expect(validateCallback({ calledName: 'Jane Doe', calledOn: '2026-11-20' }, '2026-11-23').ok).toBe(false)
    expect(validateCallback({ calledName: 'Jane Doe', calledNumber: '+1 555 0100', calledOn: '2026-11-24' }, '2026-11-23').ok).toBe(false)
  })
})

describe('numbers', () => {
  it('are sealed with a fresh IV each time and open back to the original', () => {
    const a = sealNumber('00123456789')
    const b = sealNumber('00123456789')
    expect(a).not.toBe(b)
    expect(a).not.toContain('00123456789')
    expect(openNumber(a)).toBe('00123456789')
  })
  it('are shown as the last four digits', () => {
    expect(mask('6789')).toBe('••••6789')
    expect(mask(null)).toBeNull()
  })
})

describe('changedFields', () => {
  it('names each field that changed, and nothing for a first entry', () => {
    const before = validateWire(base)
    const after = validateWire({ ...base, accountNumber: '99887766', reference: 'FFC Acme' })
    if (!before.ok || !after.ok) throw new Error('fixture')
    expect(changedFields(null, after.value)).toEqual([])
    expect(changedFields(before.value, before.value)).toEqual([])
    expect(changedFields(before.value, after.value)).toEqual(['account number', 'reference'])
  })
})

it('counts days between dates', () => {
  expect(daysBetween('2026-06-20T10:00:00Z', '2026-06-30')).toBe(10)
  expect(daysBetween('2026-07-02', '2026-06-30')).toBe(-2)
})

describe('the verification seal', () => {
  const row = () => ({
    fund_id: 'f1', lp_entity_id: 'e1', beneficiary_name: 'Acme Capital LP', bank_name: 'Example Bank',
    routing_number_encrypted: sealNumber('011000015'), routing_last4: '0015', account_number_encrypted: sealNumber('00123456789'), account_last4: '6789',
    status: 'verified', entered_by: 'u1', entered_at: '2026-01-05T00:00:00.000Z', verified_by: 'u2', verified_at: '2026-01-06T10:00:00.123Z',
    verification_note: 'Callback 2026-01-06 to Jane Doe at 555-0100',
  } as Record<string, any>)
  const sealed = () => { const r = row(); r.verified_digest = verificationDigest(r); return r }

  it('holds for the details that were verified, whatever format the timestamps come back in', () => {
    const r = sealed()
    expect(sealBroken(r)).toBe(false)
    expect(sealBroken({ ...r, verified_at: '2026-01-06 10:00:00.123+00', entered_at: '2026-01-05T00:00:00+00:00' })).toBe(false)
  })
  it('breaks when a number, a name, the entity or the verifier changes in the database', () => {
    const r = sealed()
    expect(sealBroken({ ...r, account_number_encrypted: sealNumber('99999999') })).toBe(true)
    expect(sealBroken({ ...r, beneficiary_name: 'Someone Else LLC' })).toBe(true)
    expect(sealBroken({ ...r, lp_entity_id: 'e2' })).toBe(true)
    expect(sealBroken({ ...r, verified_by: 'u1' })).toBe(true)
  })
  it('treats verified with no seal as broken, and unverified rows as never broken', () => {
    expect(sealBroken(row())).toBe(true)
    expect(sealBroken({ ...row(), status: 'unverified' })).toBe(false)
  })
})
