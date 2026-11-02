// Setting a vehicle's carry (waterfall) terms: ONE write path, used by the web route
// (PUT /api/accounting/waterfall-terms) and by the approved `set_waterfall_terms` pending action, so
// a term proposed from an LPA is checked and stored exactly as one typed into the settings page.
//
// The spec for what these terms mean is docs/spec/waterfall-terms.md.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CarryKind, CarryRecipient, CarryStep, ContributionPurpose, DayCount, PrefBase } from './carry'
import { vehicleIdByName } from './vehicle-id'

export const CARRY_KINDS: CarryKind[] = ['none', 'straight', 'american', 'european']
export const PREF_BASES: PrefBase[] = ['contributed', 'unreturned']
export const DAY_COUNTS: DayCount[] = ['act/365', '30/360']
export const CATCHUP_MEASURES = ['preferred', 'profit'] as const
export const CONTRIBUTION_PURPOSES: ContributionPurpose[] = ['investments', 'fees', 'expenses', 'other']

/** The terms as a caller supplies them (the route's PUT body, the pending action's input). */
export interface WaterfallTermsInput {
  kind?: unknown
  carryRate?: unknown
  prefRate?: unknown
  catchupRate?: unknown
  catchupSize?: unknown
  prefCompounds?: unknown
  prefBase?: unknown
  prefMultiple?: unknown
  prefDayCount?: unknown
  catchupMeasure?: unknown
  carrySteps?: unknown
  capitalIncludes?: unknown
  gpCommitBearsCarry?: unknown
  gpEntityId?: unknown
  carryRecipients?: unknown
}

/** Validated terms, ready to store. Rates are fractions (0.2 = 20%). */
export interface ValidWaterfallTerms {
  kind: CarryKind
  carryRate: number
  prefRate: number
  catchupRate: number
  /** How much of a full catch-up the GP gets, 0–1 (1 = full). `catchupRate` is how fast it gets it. */
  catchupSize: number
  prefCompounds: boolean
  /** What the hurdle accrues on: all contributions, or only capital not yet returned. */
  prefBase: PrefBase
  /** A hurdle set as a multiple of capital (1.08 = 8%, never accruing) instead of the rate. Null: the rate. */
  prefMultiple: number | null
  /** How the rate's years are counted. */
  prefDayCount: DayCount
  /** What the catch-up is measured on: the pref paid, or all the profit distributed. */
  catchupMeasure: 'preferred' | 'profit'
  /** Where the carry steps up at an LP multiple or IRR, in order. Empty: one carry rate. */
  carrySteps: CarryStep[]
  /** What contributions are returned as capital and accrued on. All four is the default. */
  capitalIncludes: ContributionPurpose[]
  /** The recipients' own commitments (the GP commit) bear carry like an LP's. False: carry-free. */
  gpCommitBearsCarry: boolean
  gpEntityId: string | null
  recipients: CarryRecipient[]
}

/** As the route always read them: `Number(v)`, or the fallback when that is not finite. */
function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Check the terms without touching the database: the kind, each rate's range (the table's CHECKs),
 * a recipient whenever carry is on, and recipient percentages that total 100. Messages are the
 * route's, word for word, because a person reads them in the settings page.
 */
export function parseWaterfallTermsInput(body: WaterfallTermsInput): { ok: true; value: ValidWaterfallTerms } | { error: string } {
  const kind = body?.kind
  if (typeof kind !== 'string' || !(CARRY_KINDS as string[]).includes(kind)) {
    return { error: 'kind must be none, straight, american, or european.' }
  }
  const carryRate = num(body?.carryRate)
  const prefRate = num(body?.prefRate)
  const catchupRate = num(body?.catchupRate, 1)

  if (carryRate < 0 || carryRate >= 1) return { error: 'Carry rate must be a fraction between 0 and 1 (0.2 = 20%).' }
  if (prefRate < 0 || prefRate >= 1) return { error: 'Preferred return must be a fraction between 0 and 1 (0.08 = 8%).' }
  if (catchupRate < 0 || catchupRate > 1) return { error: 'Catch-up rate must be between 0 and 1.' }
  const catchupSize = num(body?.catchupSize, 1)
  if (catchupSize < 0 || catchupSize > 1) return { error: 'Catch-up size must be between 0 and 1 (1 = a full catch-up).' }
  const prefBase = body?.prefBase ?? 'contributed'
  if (!(PREF_BASES as unknown[]).includes(prefBase)) return { error: 'The preferred return must accrue on contributed or unreturned capital.' }
  const prefMultiple = body?.prefMultiple == null || body.prefMultiple === '' ? null : num(body.prefMultiple, NaN)
  if (prefMultiple !== null && !(prefMultiple >= 1 && prefMultiple <= 10)) return { error: 'A hurdle multiple must be between 1 and 10 (1.08 = 8%).' }
  const prefDayCount = body?.prefDayCount ?? 'act/365'
  if (!(DAY_COUNTS as unknown[]).includes(prefDayCount)) return { error: 'The day count must be act/365 or 30/360.' }
  const catchupMeasure = body?.catchupMeasure ?? 'preferred'
  if (!(CATCHUP_MEASURES as readonly unknown[]).includes(catchupMeasure)) return { error: 'The catch-up must be measured on the preferred return or on profit.' }
  if (catchupMeasure === 'profit' && kind !== 'straight' && carryRate > 0 && catchupRate > 0) {
    // Measured on profit, the GP only gains ground while its share of each dollar is above its target.
    const x = (catchupSize * carryRate) / (1 - carryRate)
    if (catchupRate <= x / (1 + x)) return { error: 'Measured on profit, the catch-up rate must be above the share of profit the GP catches up to.' }
  }

  // Carry that steps up: each step ends the split before it at an LP multiple or IRR, and the rate
  // only goes up, because a step down would hand the LPs back carry the GP already holds.
  const carrySteps: CarryStep[] = []
  if (body?.carrySteps != null && !Array.isArray(body.carrySteps)) return { error: 'Carry steps must be a list.' }
  let lastRate = carryRate
  let lastMultiple = 1
  let lastIrr = 0
  for (const raw of (body?.carrySteps as any[] | undefined) ?? []) {
    const blank = (v: unknown) => v == null || v === ''
    const rate = num(raw?.carryRate, NaN)
    const lpMultiple = blank(raw?.lpMultiple) ? null : num(raw.lpMultiple, NaN)
    const lpIrr = blank(raw?.lpIrr) ? null : num(raw.lpIrr, NaN)
    if (!(rate > 0 && rate < 1)) return { error: 'Each carry step needs a carry rate between 0 and 1.' }
    if (rate <= lastRate) return { error: 'Each carry step must raise the carry rate.' }
    if ((lpMultiple === null) === (lpIrr === null)) return { error: 'Each carry step starts at an LP multiple or an LP IRR, not both.' }
    if (lpMultiple !== null && !(lpMultiple > lastMultiple && lpMultiple <= 20)) return { error: 'Carry step multiples must rise, from above 1 up to 20.' }
    if (lpIrr !== null && !(lpIrr > lastIrr && lpIrr < 1)) return { error: 'Carry step IRRs must rise, from above 0 up to 1 (0.15 = 15%).' }
    const catchUpRate = blank(raw?.catchUpRate) ? null : num(raw.catchUpRate, NaN)
    if (catchUpRate !== null && !(catchUpRate > rate && catchUpRate <= 1)) return { error: 'A catch-up at a carry step must give the GP more of each dollar than the new rate, up to 1.' }
    const measure = blank(raw?.catchUpMeasure) ? 'profit' : raw.catchUpMeasure
    if (measure !== 'profit' && measure !== 'split') return { error: 'A carry step\'s catch-up is measured on profit or on the split.' }
    if (measure === 'split' && catchUpRate === null) return { error: 'A carry step measured on the split needs a catch-up rate.' }
    carrySteps.push({
      carryRate: rate,
      ...(lpMultiple !== null ? { lpMultiple } : { lpIrr: lpIrr! }),
      ...(catchUpRate !== null ? { catchUpRate } : {}),
      ...(measure === 'split' ? { catchUpMeasure: 'split' as const } : {}),
    })
    lastRate = rate
    if (lpMultiple !== null) lastMultiple = lpMultiple
    if (lpIrr !== null) lastIrr = lpIrr
  }
  if (carrySteps.length > 0 && (kind === 'none' || carryRate <= 0)) return { error: 'Carry steps need a carry rate to step up from.' }

  const includesRaw = body?.capitalIncludes ?? CONTRIBUTION_PURPOSES
  if (!Array.isArray(includesRaw) || includesRaw.some(p => !(CONTRIBUTION_PURPOSES as unknown[]).includes(p))) {
    return { error: 'Capital returned must list investments, fees, expenses or other.' }
  }
  if (!includesRaw.includes('investments')) return { error: 'Capital returned must include invested capital.' }
  const capitalIncludes = CONTRIBUTION_PURPOSES.filter(p => includesRaw.includes(p))

  // Carry has to accrue TO somebody. A vehicle may have ONE recipient (legacy gpEntityId) or a
  // split across several (carryRecipients: [{lpEntityId, pct}] summing to 100). Without any the
  // close would compute an accrual it cannot post — refuse here rather than fail mid-close.
  const gpEntityId = typeof body?.gpEntityId === 'string' && body.gpEntityId ? body.gpEntityId : null
  const recipients: CarryRecipient[] = Array.isArray(body?.carryRecipients)
    ? (body.carryRecipients as any[])
        .filter(r => r && typeof r.lpEntityId === 'string')
        .map(r => ({ lpEntityId: String(r.lpEntityId), pct: Number(r.pct) }))
        .filter(r => Number.isFinite(r.pct) && r.pct > 0)
    : []
  const carryOn = kind !== 'none' && carryRate > 0
  if (carryOn && recipients.length === 0 && !gpEntityId) return { error: 'Choose who receives the carry.' }
  if (recipients.length > 0) {
    const sum = recipients.reduce((s, r) => s + r.pct, 0)
    if (Math.abs(sum - 100) > 0.01) return { error: `Carry recipient percentages must total 100 (they total ${sum}).` }
  }

  return {
    ok: true,
    value: {
      kind: kind as CarryKind,
      carryRate,
      prefRate,
      catchupRate,
      catchupSize,
      prefCompounds: body?.prefCompounds !== false,
      prefBase: prefBase as PrefBase,
      prefMultiple,
      prefDayCount: prefDayCount as DayCount,
      catchupMeasure: catchupMeasure as 'preferred' | 'profit',
      carrySteps,
      capitalIncludes,
      gpCommitBearsCarry: body?.gpCommitBearsCarry === true,
      gpEntityId,
      recipients,
    },
  }
}

/** Every recipient id the terms name (the list and the legacy single GP). */
export function recipientIdsOf(terms: Pick<ValidWaterfallTerms, 'recipients' | 'gpEntityId'>): string[] {
  return Array.from(new Set([...terms.recipients.map(r => r.lpEntityId), ...(terms.gpEntityId ? [terms.gpEntityId] : [])]))
}

/**
 * Validate and store a vehicle's terms. `status` is the HTTP status the route answers with; a
 * pending action throws the message.
 */
export async function saveWaterfallTerms(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  body: WaterfallTermsInput,
): Promise<{ ok: true; terms: ValidWaterfallTerms } | { error: string; status: number; dbError?: { message: string } }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".`, status: 400 }

  const parsed = parseWaterfallTermsInput(body)
  if ('error' in parsed) return { error: parsed.error, status: 400 }
  const terms = parsed.value

  // Every named recipient (and the legacy single GP) must be a partner in this fund.
  const idsToCheck = recipientIdsOf(terms)
  if (idsToCheck.length > 0) {
    const { data: ents } = await admin.from('lp_entities' as any).select('id').eq('fund_id', fundId).in('id', idsToCheck)
    const known = new Set(((ents as any[]) ?? []).map(e => e.id))
    if (idsToCheck.some(id => !known.has(id))) return { error: 'A carry recipient is not in this fund.', status: 400 }
  }

  // Keep gp_entity_id meaningful as the single-recipient fallback: the sole recipient when there
  // is exactly one, otherwise the explicit legacy value (or null).
  const { recipients } = terms
  const singleGp = recipients.length === 1 ? recipients[0].lpEntityId : recipients.length === 0 ? terms.gpEntityId : null

  const { error } = await admin
    .from('vehicle_waterfall_terms' as any)
    .upsert(
      {
        fund_id: fundId,
        vehicle_id: vehicleId,
        kind: terms.kind,
        carry_rate: terms.carryRate,
        pref_rate: terms.prefRate,
        catchup_rate: terms.catchupRate,
        catchup_size: terms.catchupSize,
        pref_compounds: terms.prefCompounds,
        pref_base: terms.prefBase,
        pref_multiple: terms.prefMultiple,
        pref_day_count: terms.prefDayCount,
        catchup_measure: terms.catchupMeasure,
        carry_steps: terms.carrySteps.length > 0 ? terms.carrySteps : null,
        capital_includes: terms.capitalIncludes.length < CONTRIBUTION_PURPOSES.length ? terms.capitalIncludes : null,
        gp_commit_bears_carry: terms.gpCommitBearsCarry,
        gp_entity_id: singleGp,
        carry_recipients: recipients.length > 0 ? recipients : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'fund_id,vehicle_id' }
    )
  if (error) return { error: 'The terms could not be saved.', status: 500, dbError: error }
  return { ok: true, terms }
}
