// The CLI's vehicle-terms file (terms.json): carry terms, partners, and an optional waterfall
// state for running a distribution without a ledger. Schema documented in the README.

import { NO_CARRY, resolveCarryRecipients, type CarryKind, type VehicleCarryTerms } from './carry.ts'
import type { CarryStep, WaterfallState } from './waterfall.ts'
import type { RealizedCapital } from './replay.ts'
import type { PartnerMapping } from './books.ts'

export interface TermsPartner extends PartnerMapping {
  name?: string
  commitment?: number
}

export interface VehicleTerms {
  vehicle?: string
  carry: VehicleCarryTerms
  partners: TermsPartner[]
  capitalAccountPattern?: RegExp
  /** Cumulative waterfall state, for `waterfall` without a ledger. */
  state?: WaterfallState
  /** American terms: LP capital in realized deals, the deal-by-deal capital tier. */
  realizedCapital?: RealizedCapital[]
}

const KINDS: CarryKind[] = ['none', 'straight', 'american', 'european']

function num(v: unknown, field: string, fallback: number): number {
  if (v === undefined || v === null) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`terms: ${field} must be a number`)
  return n
}

/** Validate and normalize a parsed terms.json. Throws with the offending field on bad input. */
export function parseVehicleTerms(raw: unknown): VehicleTerms {
  if (!raw || typeof raw !== 'object') throw new Error('terms: expected a JSON object')
  const t = raw as Record<string, any>

  const c = (t.carry ?? {}) as Record<string, any>
  const kind = c.kind ?? 'none'
  if (!KINDS.includes(kind)) throw new Error(`terms: carry.kind must be one of ${KINDS.join(', ')}`)
  const carryRate = num(c.carryRate ?? c.carry_rate, 'carry.carryRate', 0)
  const prefRate = num(c.prefRate ?? c.pref_rate ?? c.hurdleRate, 'carry.prefRate', 0)
  const catchupRate = num(c.catchupRate ?? c.catchup_rate ?? c.catchUpRate, 'carry.catchupRate', 1)
  for (const [field, v] of [['carryRate', carryRate], ['prefRate', prefRate], ['catchupRate', catchupRate]] as const) {
    if (v < 0 || v > 1) throw new Error(`terms: carry.${field} is a fraction (0.2 for 20%), got ${v}`)
  }
  const catchupSize = num(c.catchupSize ?? c.catchup_size, 'carry.catchupSize', 1)
  if (catchupSize < 0 || catchupSize > 1) throw new Error(`terms: carry.catchupSize is a fraction of a full catch-up (1 = full), got ${catchupSize}`)
  const prefCompounds = (c.prefCompounds ?? c.pref_compounds) !== false
  const prefBaseRaw = c.prefBase ?? c.pref_base ?? 'contributed'
  if (prefBaseRaw !== 'contributed' && prefBaseRaw !== 'unreturned') throw new Error('terms: carry.prefBase must be contributed or unreturned')
  const prefBase = prefBaseRaw as 'contributed' | 'unreturned'
  const multipleRaw = c.prefMultiple ?? c.pref_multiple
  const prefMultiple = multipleRaw == null ? undefined : num(multipleRaw, 'carry.prefMultiple', 1)
  if (prefMultiple !== undefined && prefMultiple < 1) throw new Error(`terms: carry.prefMultiple is a multiple of capital (1.08 for an 8% hurdle), got ${prefMultiple}`)
  const dayCountRaw = c.prefDayCount ?? c.pref_day_count ?? 'act/365'
  if (dayCountRaw !== 'act/365' && dayCountRaw !== '30/360') throw new Error('terms: carry.prefDayCount must be act/365 or 30/360')
  const measureRaw = c.catchupMeasure ?? c.catchup_measure ?? 'preferred'
  if (measureRaw !== 'preferred' && measureRaw !== 'profit') throw new Error('terms: carry.catchupMeasure must be preferred or profit')
  const scopeRaw = c.waterfallScope ?? c.waterfall_scope ?? 'fund'
  if (scopeRaw !== 'fund' && scopeRaw !== 'per_lp') throw new Error('terms: carry.waterfallScope must be fund or per_lp')
  if (scopeRaw === 'per_lp' && kind === 'american') throw new Error('terms: carry.waterfallScope per_lp is not supported with american terms')
  const stepsRaw = c.carrySteps ?? c.carry_steps
  if (stepsRaw != null && !Array.isArray(stepsRaw)) throw new Error('terms: carry.carrySteps must be a list')
  const carrySteps: CarryStep[] = ((stepsRaw ?? []) as any[]).map((st, i) => {
    const field = `carry.carrySteps[${i}]`
    const rate = num(st?.carryRate, `${field}.carryRate`, NaN)
    if (!(rate > 0 && rate < 1)) throw new Error(`terms: ${field}.carryRate is a fraction (0.25 for 25%), got ${rate}`)
    const hasM = st?.lpMultiple != null
    const hasI = st?.lpIrr != null
    if (hasM === hasI) throw new Error(`terms: ${field} needs lpMultiple or lpIrr, not both`)
    const cu = st?.catchUpRate == null ? undefined : num(st.catchUpRate, `${field}.catchUpRate`, 0)
    return {
      carryRate: rate,
      ...(hasM ? { lpMultiple: num(st.lpMultiple, `${field}.lpMultiple`, 0) } : { lpIrr: num(st.lpIrr, `${field}.lpIrr`, 0) }),
      ...(cu ? { catchUpRate: cu } : {}),
    }
  })
  const includesRaw = c.capitalIncludes ?? c.capital_includes
  const PURPOSES = ['investments', 'fees', 'expenses', 'other'] as const
  if (includesRaw != null && (!Array.isArray(includesRaw) || includesRaw.some((p: unknown) => !(PURPOSES as readonly unknown[]).includes(p)))) {
    throw new Error('terms: carry.capitalIncludes lists investments, fees, expenses or other')
  }
  const capitalIncludes = includesRaw ? PURPOSES.filter(p => includesRaw.includes(p)) : undefined
  const extra = {
    ...(carrySteps.length > 0 ? { carrySteps } : {}),
    ...(capitalIncludes && capitalIncludes.length < PURPOSES.length ? { capitalIncludes } : {}),
    ...(prefMultiple !== undefined ? { prefMultiple } : {}),
    ...(dayCountRaw === '30/360' ? { prefDayCount: '30/360' as const } : {}),
    ...(measureRaw === 'profit' ? { catchupMeasure: 'profit' as const } : {}),
    ...((c.gpCommitBearsCarry ?? c.gp_commit_bears_carry) === true ? { gpCommitBearsCarry: true } : {}),
    ...(scopeRaw === 'per_lp' ? { waterfallScope: 'per_lp' as const } : {}),
  }
  const gpEntityId = typeof (c.gpEntityId ?? c.gp_entity_id) === 'string' ? (c.gpEntityId ?? c.gp_entity_id) : null
  const recipientsRaw = Array.isArray(c.recipients)
    ? c.recipients.map((r: any) => ({ lpEntityId: r?.partner ?? r?.lpEntityId, pct: r?.pct }))
    : c.carry_recipients
  const recipients = resolveCarryRecipients(recipientsRaw, gpEntityId)
  if (recipients.length > 0) {
    const total = recipients.reduce((s, r) => s + r.pct, 0)
    if (Math.abs(total - 100) > 1e-9) throw new Error(`terms: carry.recipients pct must sum to 100, got ${total}`)
  }
  const carry: VehicleCarryTerms = kind === 'none'
    ? { ...NO_CARRY, recipients }
    : { kind, carryRate, prefRate, catchupRate, catchupSize, prefCompounds, prefBase, ...extra, gpEntityId, recipients }

  const partners: TermsPartner[] = []
  for (const [i, p] of (Array.isArray(t.partners) ? t.partners : []).entries()) {
    if (!p || typeof p.id !== 'string' || !p.id) throw new Error(`terms: partners[${i}].id is required`)
    partners.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : undefined,
      account: typeof p.account === 'string' ? p.account : undefined,
      commitment: p.commitment === undefined ? undefined : num(p.commitment, `partners[${i}].commitment`, 0),
    })
  }

  let capitalAccountPattern: RegExp | undefined
  if (typeof t.capitalAccountPattern === 'string') {
    try { capitalAccountPattern = new RegExp(t.capitalAccountPattern) } catch { throw new Error('terms: capitalAccountPattern is not a valid regular expression') }
  }

  let state: WaterfallState | undefined
  if (t.state && typeof t.state === 'object') {
    const s = t.state as Record<string, unknown>
    state = {
      contributedCapital: num(s.contributedCapital, 'state.contributedCapital', 0),
      returnedCapital: num(s.returnedCapital, 'state.returnedCapital', 0),
      preferredPaid: num(s.preferredPaid, 'state.preferredPaid', 0),
      preferredTarget: num(s.preferredTarget, 'state.preferredTarget', 0),
      gpCarryPaid: num(s.gpCarryPaid, 'state.gpCarryPaid', 0),
      ...(s.gpCatchUpPaid === undefined ? {} : { gpCatchUpPaid: num(s.gpCatchUpPaid, 'state.gpCatchUpPaid', 0) }),
    }
  }

  let realizedCapital: RealizedCapital[] | undefined
  if (Array.isArray(t.realizedCapital)) {
    realizedCapital = t.realizedCapital.map((rc: any, i: number) => {
      const date = rc?.date, realizedOn = rc?.realizedOn
      if (typeof date !== 'string' || typeof realizedOn !== 'string') throw new Error(`terms: realizedCapital[${i}] needs date and realizedOn (YYYY-MM-DD)`)
      return { companyId: typeof rc.companyId === 'string' ? rc.companyId : undefined, date, realizedOn, amount: num(rc.amount, `realizedCapital[${i}].amount`, 0) }
    })
  }

  return {
    vehicle: typeof t.vehicle === 'string' ? t.vehicle : undefined,
    carry,
    partners,
    capitalAccountPattern,
    state,
    realizedCapital,
  }
}
