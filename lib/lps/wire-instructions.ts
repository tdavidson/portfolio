// Partners' bank details for distributions: entered, checked, encrypted, verified by callback.
//
// The fund pays money against these, and a changed bank account is the shape of nearly every wire
// fraud. So:
//
//   * Account and routing numbers are encrypted here, before they reach the database, with a key
//     derived from ENCRYPTION_KEY (which the database never sees). Only the last four digits are
//     stored in clear, and every listing shows them masked.
//   * A full number leaves this module only through `loadFullWires`, which the admin-only reveal
//     and the admin-only payout sheet call, and both of those log who asked.
//   * Any change to a field clears the verification, and when the details had been verified every
//     admin is emailed to call back before paying.
//   * Verification is a callback (who was called, on which number, when), and the person who
//     entered or last changed the details cannot verify them.
//
// The table is service-role only (20261123160000_lp_wire_instructions.sql).

import { hkdfSync } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/crypto'
import { notifyFundAdmins } from '@/lib/lp-onboarding-notify'
import { siteUrl } from '@/lib/lp-email'

export interface WireInput {
  beneficiaryName: string
  beneficiaryAddress?: string | null
  bankName: string
  bankAddress?: string | null
  /** US ABA routing number (9 digits). Either this or swiftCode. */
  routingNumber?: string | null
  /** SWIFT/BIC, 8 or 11 characters. */
  swiftCode?: string | null
  /** Account number or IBAN. */
  accountNumber: string
  intermediaryBank?: string | null
  intermediarySwift?: string | null
  /** For further credit / reference to quote on the wire. */
  reference?: string | null
  currency?: string | null
}

/** What every listing shows: no full number. */
export interface WireSummary {
  lpEntityId: string
  beneficiaryName: string
  beneficiaryAddress: string | null
  bankName: string
  bankAddress: string | null
  routingMasked: string | null
  swiftCode: string | null
  accountMasked: string
  intermediaryBank: string | null
  intermediarySwift: string | null
  reference: string | null
  currency: string | null
  status: 'unverified' | 'verified'
  enteredBy: string | null
  enteredAt: string
  verifiedBy: string | null
  verifiedAt: string | null
  verificationNote: string | null
}

export interface WireFull extends WireSummary {
  routingNumber: string | null
  accountNumber: string
}

export interface Callback {
  /** Who at the investor confirmed the details. */
  calledName: string
  /** The number called: one the fund already held, never one printed on the instructions. */
  calledNumber: string
  /** YYYY-MM-DD. */
  calledOn: string
  note?: string | null
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number }
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status })

// ── Validation ─────────────────────────────────────────────────────────────────────────────

const clean = (v: unknown, max = 300): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, max) : null
}
const compact = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() : ''
  return t || null
}

/** The ABA checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function validAba(n: string): boolean {
  if (!/^\d{9}$/.test(n)) return false
  const d = n.split('').map(Number)
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0
}

export const SWIFT = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/

export type NormalizedWire = Required<{ [K in keyof WireInput]: Exclude<WireInput[K], undefined> }>

export function validateWire(input: Partial<WireInput> | null | undefined): Result<NormalizedWire> {
  const beneficiaryName = clean(input?.beneficiaryName, 200)
  const bankName = clean(input?.bankName, 200)
  const accountNumber = compact(input?.accountNumber)
  const routingNumber = compact(input?.routingNumber)
  const swiftCode = compact(input?.swiftCode)
  const intermediarySwift = compact(input?.intermediarySwift)
  if (!beneficiaryName) return fail('The beneficiary name (the account holder) is required.')
  if (!bankName) return fail('The bank name is required.')
  if (!accountNumber) return fail('The account number (or IBAN) is required.')
  if (!/^[A-Z0-9]{4,34}$/.test(accountNumber)) return fail('The account number should be 4 to 34 letters and digits.')
  if (!routingNumber && !swiftCode) return fail('Give the ABA routing number, or the SWIFT/BIC for an international wire.')
  if (routingNumber && !validAba(routingNumber)) return fail('That ABA routing number is not valid (9 digits with a check digit). Check it against the instructions.')
  if (swiftCode && !SWIFT.test(swiftCode)) return fail('That SWIFT/BIC is not valid: 8 or 11 letters and digits.')
  if (intermediarySwift && !SWIFT.test(intermediarySwift)) return fail('The intermediary bank\'s SWIFT/BIC is not valid.')
  const currency = compact(input?.currency)
  if (currency && !/^[A-Z]{3}$/.test(currency)) return fail('Currency should be a three-letter code such as USD.')
  return {
    ok: true,
    value: {
      beneficiaryName, bankName, accountNumber, routingNumber, swiftCode, intermediarySwift, currency,
      beneficiaryAddress: clean(input?.beneficiaryAddress, 500),
      bankAddress: clean(input?.bankAddress, 500),
      intermediaryBank: clean(input?.intermediaryBank, 200),
      reference: clean(input?.reference, 300),
    },
  }
}

export function validateCallback(input: Partial<Callback> | null | undefined, today = new Date().toISOString().slice(0, 10)): Result<Callback> {
  const calledName = clean(input?.calledName, 200)
  const calledNumber = clean(input?.calledNumber, 50)
  const calledOn = clean(input?.calledOn, 10)
  if (!calledName || !calledNumber || !calledOn) return fail('Verifying needs the callback: who you spoke to, the number you called and the date.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calledOn)) return fail('The callback date must be YYYY-MM-DD.')
  if (calledOn > today) return fail('The callback date cannot be in the future.')
  return { ok: true, value: { calledName, calledNumber, calledOn, note: clean(input?.note, 1000) } }
}

export const mask = (last4: string | null | undefined): string | null => (last4 ? `••••${last4}` : null)
const last4 = (v: string) => v.slice(-4)

// ── Encryption ─────────────────────────────────────────────────────────────────────────────

function wireKey(): string {
  const secret = process.env.ENCRYPTION_KEY
  if (!secret) throw new Error('ENCRYPTION_KEY environment variable is not set')
  return Buffer.from(hkdfSync('sha256', secret, 'portfolio', 'lp-wire-instructions-v1', 32)).toString('hex')
}
export const sealNumber = (plain: string): string => encrypt(plain, wireKey())
export const openNumber = (sealed: string): string => decrypt(sealed, wireKey())

// ── Rows ───────────────────────────────────────────────────────────────────────────────────

const COLUMNS = 'lp_entity_id, beneficiary_name, beneficiary_address, bank_name, bank_address, routing_number_encrypted, routing_last4, swift_code, account_number_encrypted, account_last4, intermediary_bank, intermediary_swift, reference, currency, status, entered_by, entered_at, verified_by, verified_at, verification_note'

async function emailsOf(admin: SupabaseClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const id of Array.from(new Set(ids.filter(Boolean) as string[]))) {
    try {
      const { data } = await admin.auth.admin.getUserById(id)
      if (data?.user?.email) out.set(id, data.user.email)
    } catch { /* a removed user shows as a team member */ }
  }
  return out
}

function summaryOf(r: any, emails: Map<string, string>): WireSummary {
  return {
    lpEntityId: r.lp_entity_id,
    beneficiaryName: r.beneficiary_name,
    beneficiaryAddress: r.beneficiary_address ?? null,
    bankName: r.bank_name,
    bankAddress: r.bank_address ?? null,
    routingMasked: mask(r.routing_last4),
    swiftCode: r.swift_code ?? null,
    accountMasked: mask(r.account_last4) ?? '••••',
    intermediaryBank: r.intermediary_bank ?? null,
    intermediarySwift: r.intermediary_swift ?? null,
    reference: r.reference ?? null,
    currency: r.currency ?? null,
    status: r.status === 'verified' ? 'verified' : 'unverified',
    enteredBy: r.entered_by ? emails.get(r.entered_by) ?? 'a team member' : null,
    enteredAt: r.entered_at,
    verifiedBy: r.verified_by ? emails.get(r.verified_by) ?? 'a team member' : null,
    verifiedAt: r.verified_at ?? null,
    verificationNote: r.verification_note ?? null,
  }
}

async function rowsFor(admin: SupabaseClient, fundId: string, entityIds?: string[]): Promise<any[] | { missingTable: true }> {
  let q = (admin as any).from('lp_wire_instructions').select(COLUMNS).eq('fund_id', fundId)
  if (entityIds) {
    if (entityIds.length === 0) return []
    q = q.in('lp_entity_id', entityIds)
  }
  const { data, error } = await q
  if (error) {
    // The release is live but 20261123160000 is not applied yet: nothing is on file.
    if (/lp_wire_instructions/.test(error.message ?? '') || error.code === '42P01') return { missingTable: true }
    throw new Error(error.message)
  }
  return (data as any[]) ?? []
}

/** Masked details per entity, for every listing. Empty before the migration is applied. */
export async function loadWireSummaries(admin: SupabaseClient, fundId: string, entityIds?: string[]): Promise<Map<string, WireSummary>> {
  const rows = await rowsFor(admin, fundId, entityIds)
  if (!Array.isArray(rows)) return new Map()
  const emails = await emailsOf(admin, rows.flatMap(r => [r.entered_by, r.verified_by]))
  return new Map(rows.map(r => [r.lp_entity_id as string, summaryOf(r, emails)]))
}

/**
 * Full details, numbers decrypted. Only for the admin-only reveal and payout sheet, which log the
 * access; nothing else should call it.
 */
export async function loadFullWires(admin: SupabaseClient, fundId: string, entityIds: string[]): Promise<Map<string, WireFull>> {
  const rows = await rowsFor(admin, fundId, entityIds)
  if (!Array.isArray(rows)) return new Map()
  const emails = await emailsOf(admin, rows.flatMap(r => [r.entered_by, r.verified_by]))
  return new Map(rows.map(r => [r.lp_entity_id as string, {
    ...summaryOf(r, emails),
    accountNumber: openNumber(r.account_number_encrypted),
    routingNumber: r.routing_number_encrypted ? openNumber(r.routing_number_encrypted) : null,
  }]))
}

async function entityOf(admin: SupabaseClient, fundId: string, entityId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await (admin as any).from('lp_entities').select('id, entity_name').eq('id', entityId).eq('fund_id', fundId).maybeSingle()
  return data ? { id: data.id, name: data.entity_name } : null
}

const FIELD_LABEL: Record<keyof NormalizedWire, string> = {
  beneficiaryName: 'beneficiary name', beneficiaryAddress: 'beneficiary address', bankName: 'bank name', bankAddress: 'bank address',
  routingNumber: 'routing number', swiftCode: 'SWIFT/BIC', accountNumber: 'account number', intermediaryBank: 'intermediary bank',
  intermediarySwift: 'intermediary SWIFT/BIC', reference: 'reference', currency: 'currency',
}

/** Which fields differ, by label. Pure, so the change rule is pinned by a test. */
export function changedFields(before: NormalizedWire | null, after: NormalizedWire): string[] {
  if (!before) return []
  return (Object.keys(FIELD_LABEL) as (keyof NormalizedWire)[]).filter(k => (before[k] ?? null) !== (after[k] ?? null)).map(k => FIELD_LABEL[k])
}

function normalizedOf(full: WireFull): NormalizedWire {
  return {
    beneficiaryName: full.beneficiaryName, beneficiaryAddress: full.beneficiaryAddress, bankName: full.bankName, bankAddress: full.bankAddress,
    routingNumber: full.routingNumber, swiftCode: full.swiftCode, accountNumber: full.accountNumber, intermediaryBank: full.intermediaryBank,
    intermediarySwift: full.intermediarySwift, reference: full.reference, currency: full.currency,
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/**
 * Enter or change an entity's details. A change to any field clears the verification; changing
 * details that were verified emails every admin to call back before paying. Saving the same
 * details again changes nothing.
 */
export async function saveWire(
  admin: SupabaseClient,
  fundId: string,
  entityId: string,
  userId: string,
  input: Partial<WireInput>,
): Promise<Result<{ summary: WireSummary; created: boolean; changed: string[]; verificationCleared: boolean; adminsAlerted: number }>> {
  const v = validateWire(input)
  if (!v.ok) return v
  const entity = await entityOf(admin, fundId, entityId)
  if (!entity) return fail('That LP entity is not in this fund.', 404)
  const existing = (await loadFullWires(admin, fundId, [entityId])).get(entityId) ?? null
  const before = existing ? normalizedOf(existing) : null
  const changed = changedFields(before, v.value)
  if (existing && changed.length === 0) {
    return { ok: true, value: { summary: existing, created: false, changed: [], verificationCleared: false, adminsAlerted: 0 } }
  }
  const w = v.value
  const now = new Date().toISOString()
  const row = {
    fund_id: fundId, lp_entity_id: entityId,
    beneficiary_name: w.beneficiaryName, beneficiary_address: w.beneficiaryAddress, bank_name: w.bankName, bank_address: w.bankAddress,
    routing_number_encrypted: w.routingNumber ? sealNumber(w.routingNumber) : null, routing_last4: w.routingNumber ? last4(w.routingNumber) : null,
    swift_code: w.swiftCode,
    account_number_encrypted: sealNumber(w.accountNumber), account_last4: last4(w.accountNumber),
    intermediary_bank: w.intermediaryBank, intermediary_swift: w.intermediarySwift, reference: w.reference, currency: w.currency,
    status: 'unverified', entered_by: userId, entered_at: now, verified_by: null, verified_at: null, verification_note: null, updated_at: now,
  }
  const { error } = await (admin as any).from('lp_wire_instructions').upsert(row, { onConflict: 'fund_id,lp_entity_id' })
  if (error) {
    return /lp_wire_instructions/.test(error.message ?? '')
      ? fail('Bank details need migration 20261123160000_lp_wire_instructions.sql. Apply it, then try again.')
      : fail(error.message, 500)
  }
  const verificationCleared = existing?.status === 'verified'
  let adminsAlerted = 0
  if (verificationCleared) {
    adminsAlerted = await notifyFundAdmins(admin, fundId, `Wire instructions changed — ${entity.name} — verify by callback`,
      `<p><strong>Bank details you had verified for ${esc(entity.name)} were changed in the app.</strong></p>` +
      `<p>Changed: ${esc(changed.join(', '))}. The verification no longer stands, and the payout sheet leaves this partner's details out until someone other than the person who changed them verifies them again.</p>` +
      `<p>Do not pay against the new details until you have confirmed them by calling a number you already hold for this investor, not one given with the new details.</p>` +
      `<p><a href="${esc(siteUrl())}/lp-portal">Open LP Portal → Onboarding</a>.</p>`)
  }
  const summary = (await loadWireSummaries(admin, fundId, [entityId])).get(entityId)!
  return { ok: true, value: { summary, created: !existing, changed, verificationCleared, adminsAlerted } }
}

/** Record the callback. Refused for the person who entered or last changed the details. */
export async function verifyWire(
  admin: SupabaseClient,
  fundId: string,
  entityId: string,
  userId: string,
  input: Partial<Callback>,
): Promise<Result<WireSummary>> {
  const cb = validateCallback(input)
  if (!cb.ok) return cb
  const rows = await rowsFor(admin, fundId, [entityId])
  if (!Array.isArray(rows)) return fail('Bank details need migration 20261123160000_lp_wire_instructions.sql.')
  const row = rows[0]
  if (!row) return fail('No bank details are on file for this entity.', 404)
  if (row.entered_by && row.entered_by === userId) {
    return fail('You entered or last changed these details, so someone else has to verify them by callback.', 403)
  }
  const { calledName, calledNumber, calledOn, note } = cb.value
  const verificationNote = `Callback ${calledOn} to ${calledName} at ${calledNumber}${note ? `. ${note}` : ''}`
  const { error } = await (admin as any).from('lp_wire_instructions')
    .update({ status: 'verified', verified_by: userId, verified_at: new Date().toISOString(), verification_note: verificationNote, updated_at: new Date().toISOString() })
    .eq('fund_id', fundId).eq('lp_entity_id', entityId).eq('entered_at', row.entered_at)
  if (error) return fail(error.message, 500)
  const summary = (await loadWireSummaries(admin, fundId, [entityId])).get(entityId)
  if (!summary || summary.status !== 'verified') return fail('The details changed while you were verifying them. Review them again.', 409)
  return { ok: true, value: summary }
}

/** Days between two YYYY-MM-DD (or ISO) dates, b − a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000)
}

/** Details changed this close to a payment are flagged on the payout sheet even once verified. */
export const RECENT_CHANGE_DAYS = 14
