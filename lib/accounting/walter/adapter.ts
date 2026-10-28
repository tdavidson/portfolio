// Portfolio's accounting engine, run on the Walter conformance vectors.
//
// Walter (github.com/tdavidson/walter) is an open spec for fund terms: the terms and dated flows
// go in, and every allocation the terms imply comes out. This adapter only translates. Walter's
// terms become `VehicleCarryTerms`, its flows become the capital accounts, distributions and deals
// the books would hold, and each distribution is split by `splitDistribution`, the same call a
// declared distribution makes (distributions.ts). Nothing here does waterfall math of its own.
//
// LP classes (Walter 0.2) are LPs on terms of their own: each partner in a class gets the class's
// carry terms, the engine groups LPs with identical terms (`groupLpsByTerms`), and each group runs
// its own tiers on its share (lp-groups.ts). A class's fee rates are a group in `feeSchedule`.
//
// A term the engine has no way to express is refused as `unsupported`, so the conformance table
// says the engine can't do it rather than that it does it wrongly. Everything it can express is
// passed through as is, and a wrong answer is a failure the table shows.

import {
  allocateAmount,
  CarryEscrow,
  carryTarget,
  realizedCapitalFromDeals,
  recyclingCap,
  roundCents,
  splitDistribution,
  clawbackAtFundEnd,
  feeSchedule,
  groupLpsByTerms,
  groupedClawback,
  groupedFundEndEntitlement,
  type LpGroup,
  type LpWaterfallTerms,
  type PriorDistribution,
  type CarryStep,
  type DayCount,
  type FeeFrequency,
  type FeeScheduleBasis,
  type DealHistory,
  type RealizedCapital,
  type RecyclingTerms,
  type VehicleCarryTerms,
} from '@portfolio/fund-engine'

export const ENGINE = { name: 'Hemrock Portfolio accounting', version: '@portfolio/fund-engine 0.2.0' }

class AdapterError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
const unsupported = (message: string): never => { throw new AdapterError('unsupported', message) }
const refuse = (code: string, message: string): never => { throw new AdapterError(code, message) }

type Purpose = 'investments' | 'fees' | 'expenses' | 'other'
const PURPOSES: Purpose[] = ['investments', 'fees', 'expenses', 'other']

interface WPartner { id: string; role: 'lp' | 'gp'; commitment: string; carryBearing?: boolean; feeBearing?: boolean; class?: string }
interface WFee {
  frequency: FeeFrequency
  start: string
  end?: string
  schedule: { from: string | { event: string }; rate: string; basis: FeeScheduleBasis }[]
  offsets?: Record<string, string>
  organizationalExpenseCap?: string
}
interface WTier {
  type: 'return-of-capital' | 'preferred-return' | 'catch-up' | 'split'
  id?: string
  rate?: string
  multiple?: string
  compounding?: 'annual' | 'none'
  base?: 'contributed' | 'unreturned'
  dayCount?: string
  target?: string
  gpShare?: string
  measure?: 'profit' | 'preferred'
  until?: unknown
}
interface WClass {
  id: string
  waterfall?: { preset?: string; presetTerms?: { carry?: string; pref?: string }; tiers?: WTier[] }
  managementFee?: { schedule: WFee['schedule'] }
  subordinated?: boolean
}
interface WTerms {
  walter?: '0.1' | '0.2' | '0.3'
  fund?: { investmentPeriodEnd?: string }
  classes?: WClass[]
  partners: WPartner[]
  waterfall: {
    basis?: 'whole-fund' | 'deal-by-deal'
    returnOfCapital?: { includes?: Purpose[] }
    preset?: string
    presetTerms?: { carry?: string; pref?: string }
    tiers?: WTier[]
    carryRecipients?: { partner: string; share: string }[]
  }
  clawback?: { enabled?: boolean; escrow?: { share: string; release?: 'fund-end' | { lpMultiple: string } }; netOfTax?: { rate: string } }
  recycling?: { cap: string; capBasis?: 'commitments' | 'management-fees'; until?: string; defaultTreatment?: 'never-distributed' | 'deemed' }
  managementFee?: WFee
}
type WFlow = { type: string; date: string; [k: string]: any }

interface Allocation { date: string; tier: string; partner: string; amount: string }

const num = (v: unknown, what: string): number => {
  const n = Number(v)
  if (typeof v !== 'string' || !Number.isFinite(n)) refuse('invalid-terms', `${what} must be a decimal string`)
  return n
}
const money = (n: number) => roundCents(n).toFixed(2)

// Walter's processing order on one date (spec/03-flows.md).
const ORDER: Record<string, number> = {
  contribution: 0, investment: 0, 'write-off': 1, event: 1, 'portfolio-fee': 1, 'organizational-expense': 1,
  distributable: 2, nav: 3, 'fund-end': 4,
}

/** Walter's presets (spec/02-terms.md), as tier lists. */
function expandTiers(w: WTerms['waterfall']): { tiers: WTier[]; basis: 'whole-fund' | 'deal-by-deal' } {
  if (w.preset) {
    if (w.tiers) refuse('invalid-terms', 'give a preset or tiers, not both')
    const carry = w.presetTerms?.carry ?? '0.20'
    const pref = w.presetTerms?.pref ?? '0.08'
    const tiers: WTier[] = [
      { type: 'return-of-capital' },
      { type: 'preferred-return', rate: pref, compounding: 'annual', base: 'unreturned', dayCount: 'act/365' },
      { type: 'catch-up', target: carry, gpShare: '1' },
      { type: 'split', gpShare: carry },
    ]
    if (w.preset === 'european-standard') return { tiers, basis: 'whole-fund' }
    if (w.preset === 'american-standard') return { tiers, basis: 'deal-by-deal' }
    return refuse('invalid-terms', `unknown preset ${w.preset}`)
  }
  if (!Array.isArray(w.tiers) || w.tiers.length === 0) return refuse('invalid-terms', 'give a preset or tiers')
  return { tiers: w.tiers, basis: w.basis ?? 'whole-fund' }
}

/** The tier list as the four tiers the engine runs, or a refusal saying which term it can't. */
function carryTermsOf(terms: WTerms, recipients: { lpEntityId: string; pct: number }[]) {
  const { tiers, basis } = expandTiers(terms.waterfall)
  const last = tiers[tiers.length - 1]
  if (tiers[0]?.type !== 'return-of-capital') refuse('invalid-terms', 'return-of-capital must be the first tier')
  if (last.type !== 'split' || last.until) refuse('invalid-terms', 'the last tier must be a split with no until')
  const pref = tiers.find(t => t.type === 'preferred-return')
  // The shape the engine runs: capital, pref, catch-up, then splits, each after the first with an
  // optional catch-up before it (the carry stepping up).
  let at = 1
  if (tiers[at]?.type === 'preferred-return') at++
  const catchUp = tiers[at]?.type === 'catch-up' ? tiers[at++] : undefined
  const bands: { catchUp?: WTier; split: WTier }[] = []
  while (at < tiers.length) {
    const cu = tiers[at]?.type === 'catch-up' && bands.length > 0 ? tiers[at++] : undefined
    const split = tiers[at++]
    if (split?.type !== 'split') unsupported('tiers in an order other than capital, pref, catch-up, then splits')
    bands.push({ ...(cu ? { catchUp: cu } : {}), split })
  }
  for (const b of bands.slice(0, -1)) {
    const u = b.split.until as { lpMultiple?: string; lpIrr?: string } | undefined
    if (!u || (u.lpMultiple === undefined) === (u.lpIrr === undefined)) refuse('invalid-terms', 'every split but the last needs an until: lpMultiple or lpIrr')
  }
  for (const b of bands.slice(1)) {
    if (b.catchUp && (b.catchUp.measure ?? 'preferred') !== 'profit') unsupported('a catch-up at a step measured on the pref (the engine measures it on all profit)')
  }
  const carrySteps: CarryStep[] = bands.slice(1).map((b, i) => {
    const u = bands[i].split.until as { lpMultiple?: string; lpIrr?: string }
    return {
      carryRate: num(b.split.gpShare, 'split.gpShare'),
      ...(u.lpMultiple !== undefined ? { lpMultiple: num(u.lpMultiple, 'until.lpMultiple') } : { lpIrr: num(u.lpIrr, 'until.lpIrr') }),
      ...(b.catchUp ? {
        catchUpRate: b.catchUp.gpShare === undefined ? 1 : num(b.catchUp.gpShare, 'catch-up.gpShare'),
        catchUpTarget: num(b.catchUp.target, 'catch-up.target'),
      } : {}),
    }
  })

  const carryRate = num(bands[0].split.gpShare, 'split.gpShare')
  let prefRate = 0
  let prefCompounds = true
  let prefBase: 'contributed' | 'unreturned' = 'contributed'
  let prefMultiple: number | undefined
  let prefDayCount: DayCount = 'act/365'
  if (pref) {
    if (pref.multiple !== undefined) {
      prefMultiple = num(pref.multiple, 'preferred-return.multiple')
      if (prefMultiple < 1) refuse('invalid-terms', 'preferred-return.multiple must be at least 1')
    } else {
      prefRate = num(pref.rate, 'preferred-return.rate')
      prefCompounds = (pref.compounding ?? 'annual') === 'annual'
      prefBase = pref.base ?? 'contributed'
      const dc = pref.dayCount ?? 'act/365'
      if (dc !== 'act/365' && dc !== '30/360') refuse('invalid-terms', `unknown day count ${dc}`)
      prefDayCount = dc as DayCount
    }
  }
  let catchupRate = 1
  let catchupSize = 0
  let measure: 'preferred' | 'profit' = 'preferred'
  if (catchUp) {
    const target = num(catchUp.target, 'catch-up.target')
    catchupRate = catchUp.gpShare === undefined ? 1 : num(catchUp.gpShare, 'catch-up.gpShare')
    measure = catchUp.measure ?? 'preferred'
    if (measure === 'profit' && catchupRate <= target) {
      refuse('invalid-terms', 'with measure "profit" the GP never catches up unless gpShare is above the target')
    }
    if (carryRate > 0 && carryRate < 1) {
      // The engine's catch-up gives the GP catchUpSize × c ÷ (1 − c) of the pref; Walter's gives it
      // t ÷ (1 − t). The same thing whenever the target is at or below the carry rate.
      catchupSize = (target / (1 - target)) / (carryRate / (1 - carryRate))
      if (catchupSize > 1 + 1e-12) unsupported('a catch-up to more than the carry rate')
      catchupSize = Math.min(1, catchupSize)
    }
  }
  // 'straight' is whole fund with no hurdle; deal by deal with no hurdle is American at a 0 pref.
  const kind: VehicleCarryTerms['kind'] = basis === 'deal-by-deal' ? 'american'
    : !pref ? 'straight' : 'european'
  const carry: VehicleCarryTerms = {
    kind, carryRate, prefRate, catchupRate, catchupSize, prefCompounds, prefBase,
    ...(prefMultiple !== undefined ? { prefMultiple } : {}),
    ...(prefDayCount !== 'act/365' ? { prefDayCount } : {}),
    ...(measure === 'profit' ? { catchupMeasure: 'profit' as const } : {}),
    ...(carrySteps.length > 0 ? { carrySteps } : {}),
    gpEntityId: recipients[0]?.lpEntityId ?? null,
    recipients,
  }
  const ids = {
    roc: tiers[0].id ?? 'return-of-capital',
    pref: pref?.id ?? 'preferred-return',
    catchUp: catchUp?.id ?? 'catch-up',
    split: bands[0].split.id ?? 'split',
    bands: bands.map((b, i) => ({
      catchUp: b.catchUp?.id ?? `catch-up-${i + 1}`,
      split: b.split.id ?? (i === 0 ? 'split' : `split-${i + 1}`),
    })),
  }
  return { carry, ids, hasPref: !!pref }
}

export function run(termsIn: unknown, flowsIn: unknown) {
  const terms = termsIn as WTerms
  const partners = terms.partners ?? []
  const partnerIds = new Set(partners.map(p => p.id))
  const commitment = new Map(partners.map(p => [p.id, num(p.commitment, `partner ${p.id} commitment`)]))

  // LP classes (spec/11-lp-classes.md).
  const defined = terms.classes ?? []
  if (terms.classes && terms.walter === '0.1') refuse('invalid-terms', 'LP classes need walter "0.2"')
  // 0.3 widened the kinds of portfolio-company fee to ILPA's; 0.1 and 0.2 have four.
  for (const kind of Object.keys(terms.managementFee?.offsets ?? {})) {
    if (terms.walter !== '0.3' && !['transaction', 'monitoring', 'directors', 'other'].includes(kind)) {
      refuse('invalid-terms', `managementFee.offsets.${kind} needs walter "0.3"`)
    }
  }
  const classIds = new Set<string>()
  for (const c of defined) {
    if (typeof c?.id !== 'string' || c.id === '' || classIds.has(c.id)) refuse('invalid-terms', `class ids must be unique and not empty: ${c?.id}`)
    classIds.add(c.id)
  }
  for (const p of partners) if (p.class !== undefined && !classIds.has(p.class)) refuse('unknown-class', `partner ${p.id}: unknown class ${p.class}`)

  // Who receives the carry: the named recipients, or the one GP.
  const named = terms.waterfall.carryRecipients
  const gps = partners.filter(p => p.role === 'gp')
  const recipients = named
    ? named.map(r => ({ lpEntityId: r.partner, pct: num(r.share, 'carryRecipients.share') * 100 }))
    : gps.length === 1 ? [{ lpEntityId: gps[0].id, pct: 100 }] : []
  const { carry, ids } = carryTermsOf(terms, recipients)
  // Each class's own carry terms, on the fund's basis, capital and recipients.
  const { preset: _preset, presetTerms: _presetTerms, tiers: _tiers, ...fundRules } = terms.waterfall
  const classTerms = new Map(defined.map(c => {
    if (!c.waterfall) return [c.id, { carry, ids, subordinated: !!c.subordinated }]
    const own = carryTermsOf({ ...terms, waterfall: { ...fundRules, ...c.waterfall } }, recipients)
    const kind: VehicleCarryTerms['kind'] = carry.kind === 'american' ? 'american' : own.hasPref ? 'european' : 'straight'
    return [c.id, { carry: { ...own.carry, kind }, ids: own.ids, subordinated: !!c.subordinated }]
  }))
  const paysGp = [carry, ...[...classTerms.values()].map(c => c.carry)].some(c => c.carryRate > 0)
  if (paysGp && recipients.length === 0) refuse('no-carry-recipient', 'the tiers pay the GP and nobody receives it')
  const classOf = (id: string) => partners.find(p => p.id === id)?.class
  const idsOf = (id: string) => classTerms.get(classOf(id) ?? '')?.ids ?? ids
  const lpTerms: LpWaterfallTerms[] = partners.filter(p => p.class !== undefined).map(p => {
    const c = classTerms.get(p.class!)!
    return { lpEntityId: p.id, ...(c.carry !== carry ? { terms: c.carry } : {}), subordinated: c.subordinated }
  })
  const grouped = defined.length > 0

  // The engine's LPs are the partners whose capital bears carry: everyone outside the carry
  // recipients, and a recipient whose own commit bears carry. Other recipients' capital is
  // carry-free (distribution-waterfall.ts).
  const recipientIds = new Set(recipients.map(r => r.lpEntityId))
  const bearingIds = new Set<string>()
  for (const p of partners) {
    const bearing = p.carryBearing ?? p.role === 'lp'
    if (!bearing && !recipientIds.has(p.id)) unsupported(`a carry-free partner that isn't a carry recipient (${p.id})`)
    if (bearing) bearingIds.add(p.id)
  }

  const includes = terms.waterfall.returnOfCapital?.includes ?? PURPOSES
  if (PURPOSES.some(p => !includes.includes(p))) carry.capitalIncludes = PURPOSES.filter(p => includes.includes(p))
  const flows = (Array.isArray(flowsIn) ? flowsIn : refuse('invalid-flow', 'flows must be an array')) as WFlow[]
  flows.forEach((f, i) => {
    if (!(f?.type in ORDER)) refuse('invalid-flow', `flow ${i}: unknown type ${f?.type}`)
    if ('amount' in f && !(typeof f.amount === 'string' && Number(f.amount) >= 0)) refuse('invalid-flow', `flow ${i}: amount must be a non-negative decimal string`)
    if (f.type === 'contribution' && !partnerIds.has(f.partner)) refuse('unknown-partner', `flow ${i}: unknown partner ${f.partner}`)
  })
  const ordered = flows.map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.date.localeCompare(b.f.date) || ORDER[a.f.type] - ORDER[b.f.type] || a.i - b.i)
    .map(x => x.f)
  const clawbackOn = terms.clawback?.enabled ?? true
  // Carry escrow and a net-of-tax clawback cap are 0.3 terms (spec/06).
  const cbTerms = terms.clawback ?? {}
  if ((cbTerms.escrow || cbTerms.netOfTax) && terms.walter !== '0.3') refuse('invalid-terms', 'a carry escrow or a net-of-tax clawback needs walter "0.3"')
  const release = cbTerms.escrow?.release ?? 'fund-end'
  if (cbTerms.escrow && release !== 'fund-end' && typeof release?.lpMultiple !== 'string') refuse('invalid-terms', 'clawback.escrow.release must be "fund-end" or { lpMultiple }')
  const escrow = cbTerms.escrow
    ? new CarryEscrow({
      share: num(cbTerms.escrow.share, 'clawback.escrow.share'),
      release: release === 'fund-end' ? 'fund-end' : { lpMultiple: num(release.lpMultiple, 'clawback.escrow.release.lpMultiple') },
    })
    : undefined
  if (cbTerms.netOfTax) carry.clawbackNetOfTaxRate = num(cbTerms.netOfTax.rate, 'clawback.netOfTax.rate')

  const recycling: RecyclingTerms | null = terms.recycling ? {
    capRate: num(terms.recycling.cap, 'recycling.cap'),
    capBasis: terms.recycling.capBasis === 'management-fees' ? 'management_fees' : 'commitments',
    until: terms.recycling.until ?? null,
    defaultTreatment: terms.recycling.defaultTreatment === 'deemed' ? 'deemed' : 'retained',
  } : null

  const contributions: { partner: string; date: string; amount: number; purpose: Purpose }[] = []
  const deals = new Map<string, DealHistory>()
  const invested: { date: string; amount: number }[] = []
  const priors: PriorDistribution[] = []
  const received = new Map<string, number>()
  /** Distributions of each partner's own capital and profit, carry left out (the books' distributions line). */
  const ownReceived = new Map<string, number>()
  const allocations: Allocation[] = []
  const recontributions: { date: string; partner: string; amount: string }[] = []
  const recycledOut: { date: string; amount: string; treatment: 'never-distributed' | 'deemed' }[] = []
  const accruedCarry: { date: string; nav: string; entitlement: string; paid: string; accrued: string; byPartner: Record<string, string> }[] = []
  let clawback: { date: string; paid: string; entitlement: string; amount: string; cap?: string; fromEscrow?: string } | undefined
  const escrowOut: { date: string; partner: string; amount: string }[] = []
  /** Carry the tiers have paid so far, by the LPs whose tiers paid it (one key per class). */
  const paidByGroup = new Map<string, number>()
  const warnings: string[] = []
  let recycledToDate = 0
  let gpPaid = 0

  const dealOf = (key: string) => deals.get(key) ?? (deals.set(key, { companyId: key, investments: [], realizations: [] }), deals.get(key)!)
  // Carry from both sides (Walter spec/12-reporting.md): credited to each recipient, charged to the
  // LPs whose tiers paid it, by the weights their own lines were split by.
  const carryLines: { date: string; partner: string; amount: string }[] = []
  const add = (date: string, tier: string, partner: string, amount: number, isCarry = false) => {
    if (amount === 0) return
    allocations.push({ date, tier, partner, amount: money(amount) })
    received.set(partner, roundCents((received.get(partner) ?? 0) + amount))
    if (isCarry) gpPaid = roundCents(gpPaid + amount)
    else ownReceived.set(partner, roundCents((ownReceived.get(partner) ?? 0) + amount))
  }
  const postEscrow = (date: string, lines: Map<string, number>) => {
    for (const r of recipients) {
      const x = lines.get(r.lpEntityId) ?? 0
      if (x === 0) continue
      escrowOut.push({ date, partner: r.lpEntityId, amount: money(x) })
      received.set(r.lpEntityId, roundCents((received.get(r.lpEntityId) ?? 0) + x))
    }
  }
  const contributedTo = (date: string, id?: string) =>
    roundCents(contributions.filter(c => c.date <= date && (id === undefined || c.partner === id)).reduce((s, c) => s + c.amount, 0))
  const lpIds = partners.filter(p => bearingIds.has(p.id)).map(p => p.id)
  /** Pro-rata across the LPs by what they've put in, falling back to commitments (spec 04 §1). */
  const lpWeights = (date: string) => {
    const byCapital = lpIds.map(id => ({ lpEntityId: id, commitment: contributedTo(date, id) }))
    return byCapital.some(w => w.commitment > 0) ? byCapital : lpIds.map(id => ({ lpEntityId: id, commitment: commitment.get(id) ?? 0 }))
  }

  /** The American base on `date`: the deals' realized cost, as the books measure it (realized-capital.ts). */
  const realizedOn = (date: string, ids: string[] = lpIds): RealizedCapital[] | undefined => {
    if (carry.kind !== 'american') return undefined
    if (invested.length === 0) {
      warnings.push('deal-by-deal terms with no investment flows run whole fund')
      return undefined
    }
    const all = contributedTo(date)
    const lp = ids.reduce((s, id) => s + contributedTo(date, id), 0)
    const spent = contributions.filter(c => c.date <= date && (c.purpose === 'fees' || c.purpose === 'expenses')).reduce((s, c) => s + c.amount, 0)
    const cost = invested.filter(i => i.date <= date).reduce((s, i) => s + i.amount, 0)
    const factor = all > 0 && cost > 0 ? (lp / all) * (1 + spent / cost) : 0
    return realizedCapitalFromDeals([...deals.values()], { factor })
  }
  /** The LPs in groups by their terms, with what they've put in by `date`. */
  const groupsOn = (date: string): LpGroup[] => groupLpsByTerms({
    fundTerms: carry,
    lpEntityIds: lpIds,
    lpTerms,
    contributions: contributions.filter(c => bearingIds.has(c.partner) && c.date <= date)
      .map(c => ({ lpEntityId: c.partner, date: c.date, amount: c.amount, purpose: c.purpose })),
    realizedCapitalFor: members => realizedOn(date, members),
  })

  for (const f of ordered) {
    switch (f.type) {
      case 'contribution':
        contributions.push({ partner: f.partner, date: f.date, amount: Number(f.amount), purpose: f.purpose ?? 'investments' })
        break
      case 'investment':
        dealOf(f.deal).investments.push({ date: f.date, amount: Number(f.amount) })
        invested.push({ date: f.date, amount: Number(f.amount) })
        break
      case 'write-off':
        dealOf(f.deal).realizations.push({ date: f.date, costExited: f.costExited === undefined ? null : Number(f.costExited) })
        break
      case 'distributable': {
        let total = Number(f.amount)
        if (f.deal) dealOf(f.deal).realizations.push({ date: f.date, costExited: f.costExited === undefined ? null : Number(f.costExited) })

        if (f.recycle) {
          const amount = Number(f.recycle.amount)
          if (!recycling) refuse('recycling-not-permitted', 'the terms have no recycling')
          if (amount > total) refuse('recycle-exceeds-proceeds', 'the recycle is larger than the proceeds')
          if (recycling!.until && f.date > recycling!.until) refuse('recycle-after-end', 'the recycle is after recycling ends')
          const fees = contributions.filter(c => c.date <= f.date && c.purpose === 'fees').reduce((s, c) => s + c.amount, 0)
          const cap = recyclingCap(recycling!, { commitments: [...commitment.values()].reduce((s, c) => s + c, 0), managementFees: fees })
          if (roundCents(recycledToDate + amount) > cap + 0.005) refuse('recycle-over-cap', 'the recycle passes the cap')
          recycledToDate = roundCents(recycledToDate + amount)
          const treatment = f.recycle.treatment === 'deemed' ? 'deemed'
            : f.recycle.treatment === 'never-distributed' ? 'retained'
            : recycling!.defaultTreatment
          recycledOut.push({ date: f.date, amount: money(amount), treatment: treatment === 'deemed' ? 'deemed' : 'never-distributed' })
          if (treatment === 'deemed' && amount > 0) {
            // The books' one netted entry (lib/accounting/recycling.ts): each partner's share, by
            // commitment, is distributed and recontributed the same day, and the distribution is
            // a prior the waterfall replays as a return of the capital recontributed with it.
            const shares = allocateAmount(amount, partners.map(p => ({ lpEntityId: p.id, commitment: commitment.get(p.id) ?? 0 })))
            for (const [id, a] of shares) {
              if (a <= 0) continue
              add(f.date, 'recycled', id, a)
              recontributions.push({ date: f.date, partner: id, amount: money(a) })
              contributions.push({ partner: id, date: f.date, amount: a, purpose: 'investments' })
            }
            const lpShare = lpIds.reduce((s, id) => s + (shares.get(id) ?? 0), 0)
            const byLp = Object.fromEntries(lpIds.map(id => [id, shares.get(id) ?? 0]))
            if (lpShare > 0) priors.push({ date: f.date, amount: roundCents(lpShare), byLp })
          }
          total = roundCents(total - amount)
        }
        if (total <= 0) break

        const split = splitDistribution({
          total,
          terms: carry,
          partners: partners.map(p => ({
            lpEntityId: p.id,
            contributed: contributedTo(f.date, p.id),
            distributed: ownReceived.get(p.id) ?? 0,
            ending: roundCents(contributedTo(f.date, p.id) - (ownReceived.get(p.id) ?? 0)),
            ...(recipientIds.has(p.id) && bearingIds.has(p.id) ? { carryBearing: true } : {}),
          })),
          contributions: contributions.filter(c => bearingIds.has(c.partner) && c.date <= f.date).map(c => ({ date: c.date, amount: c.amount, purpose: c.purpose })),
          priors: [...priors],
          asOf: f.date,
          realizedCapital: realizedOn(f.date),
          ...(grouped ? { groups: groupsOn(f.date) } : {}),
        })
        // What the tiers divided, for the next replay: the carry-free slices sat outside them.
        priors.push({ date: f.date, amount: roundCents(total - (split.tiers.carryFree ?? 0)) })

        if (split.method === 'pro_rata') {
          for (const l of split.lines) add(f.date, ids.roc, l.lpEntityId, l.amount)
          break
        }
        // The engine gives each tier's total; spread each across the partners as its lines are.
        const allWeights = lpWeights(f.date)
        const lpTier = (tier: string, amount: number, members?: string[]) => {
          const weights = members ? allWeights.filter(w => members.includes(w.lpEntityId)) : allWeights
          if (amount > 0) for (const [id, a] of allocateAmount(amount, weights)) add(f.date, tier, id, a)
        }
        const carryNet = new Map<string, number>()
        const carryReceived = new Map<string, number>()
        const carryBy = new Map<string[] | undefined, number>()
        const gpTier = (tier: string, amount: number, members?: string[]) => {
          if (amount <= 0) return
          for (const [id, a] of allocateAmount(amount, recipients.map(r => ({ lpEntityId: r.lpEntityId, commitment: r.pct })))) {
            add(f.date, tier, id, a, true)
            carryNet.set(id, roundCents((carryNet.get(id) ?? 0) + a))
            carryReceived.set(id, roundCents((carryReceived.get(id) ?? 0) + a))
            carryBy.set(members, roundCents((carryBy.get(members) ?? 0) + a))
          }
        }
        const bookCarry = () => {
          if (escrow) {
            const lpReceived = lpIds.filter(id => partners.find(p => p.id === id)?.role === 'lp')
            const held = escrow.distribution(
              new Map(recipients.map(r => [r.lpEntityId, carryReceived.get(r.lpEntityId) ?? 0])),
              lpReceived.reduce((s, id) => s + (received.get(id) ?? 0), 0),
              lpReceived.reduce((s, id) => s + contributedTo(f.date, id), 0),
            )
            postEscrow(f.date, held)
          }
          for (const [members, amount] of carryBy) {
            const key = (members ?? lpIds).join(',')
            paidByGroup.set(key, roundCents((paidByGroup.get(key) ?? 0) + amount))
            const weights = members ? allWeights.filter(w => members.includes(w.lpEntityId)) : allWeights
            for (const [id, a] of allocateAmount(amount, weights)) carryNet.set(id, roundCents((carryNet.get(id) ?? 0) - a))
          }
          for (const p of partners) {
            const x = carryNet.get(p.id) ?? 0
            if (x !== 0) carryLines.push({ date: f.date, partner: p.id, amount: money(x) })
          }
        }
        for (const l of split.carryFreeLines ?? []) {
          add(f.date, ids.roc, l.lpEntityId, l.capital)
          add(f.date, 'carry-free', l.lpEntityId, l.profit)
        }
        if (split.groups) {
          // Each group's tiers, under its class's tier ids, across its own LPs.
          for (const g of split.groups) {
            const gi = idsOf(g.lpEntityIds[0])
            const t = g.tiers
            lpTier(gi.roc, t.returnOfCapital, g.lpEntityIds)
            lpTier(gi.pref, t.preferred, g.lpEntityIds)
            lpTier(gi.catchUp, t.catchUpToLP ?? 0, g.lpEntityIds)
            gpTier(gi.catchUp, t.catchUp, g.lpEntityIds)
            if (t.bands) {
              t.bands.forEach((b, i) => {
                lpTier(gi.bands[i].catchUp, b.catchUpToLP, g.lpEntityIds)
                gpTier(gi.bands[i].catchUp, b.catchUp, g.lpEntityIds)
                lpTier(gi.bands[i].split, b.toLP, g.lpEntityIds)
                gpTier(gi.bands[i].split, b.toGP, g.lpEntityIds)
              })
            } else {
              lpTier(gi.split, t.profitToLP, g.lpEntityIds)
              gpTier(gi.split, t.carry, g.lpEntityIds)
            }
          }
          bookCarry()
          break
        }
        lpTier(ids.roc, split.tiers.returnOfCapital)
        lpTier(ids.pref, split.tiers.preferred)
        lpTier(ids.catchUp, split.tiers.catchUpToLP ?? 0)
        gpTier(ids.catchUp, split.tiers.catchUp)
        if (split.tiers.bands) {
          split.tiers.bands.forEach((b, i) => {
            lpTier(ids.bands[i].catchUp, b.catchUpToLP)
            gpTier(ids.bands[i].catchUp, b.catchUp)
            lpTier(ids.bands[i].split, b.toLP)
            gpTier(ids.bands[i].split, b.toGP)
          })
        } else {
          lpTier(ids.split, split.tiers.profitToLP)
          gpTier(ids.split, split.tiers.carry)
        }
        bookCarry()
        break
      }
      case 'nav': {
        // The close's accrual: the GP's whole-fund entitlement if the fund sold at this NAV.
        const nav = Number(f.amount)
        const lpCapital = lpIds.reduce((s, id) => s + contributedTo(f.date, id), 0)
        const allCapital = contributedTo(f.date)
        const lpNav = allCapital > 0 ? nav * (lpCapital / allCapital) : nav
        const lpReceived = lpIds.reduce((s, id) => s + (ownReceived.get(id) ?? 0), 0)
        const groups = grouped ? groupsOn(f.date) : []
        const ent = grouped ? groupedFundEndEntitlement([...priors, { date: f.date, amount: roundCents(lpNav) }], groups, f.date) : undefined
        const target = ent
          ? ent.total
          : carryTarget({
          // The LPs' NAV gross of the carry they've borne, as the close measures it (carryAccrualInputs):
          // every dollar the tiers paid the GP came out of the carry-bearing side.
          lps: [{ lpEntityId: 'lps', contributed: roundCents(lpCapital), distributed: roundCents(lpReceived), nav: roundCents(lpNav + gpPaid) }],
          contributions: contributions.filter(c => bearingIds.has(c.partner) && c.date <= f.date).map(c => ({ date: c.date, amount: c.amount, purpose: c.purpose })),
          asOf: f.date,
          distributions: priors,
        }, carry)
        const accrued = roundCents(Math.max(0, target - gpPaid))
        // From both sides (spec/06): the recipients credited by share, and each class's own accrual
        // (its entitlement less what its tiers have paid) charged to its LPs by capital.
        const byPartner = new Map<string, number>()
        const put = (id: string, x: number) => byPartner.set(id, roundCents((byPartner.get(id) ?? 0) + x))
        signedShares(accrued, recipients.map(r => r.pct)).forEach((x, k) => put(recipients[k].lpEntityId, x))
        const weights = lpWeights(f.date)
        const sets = ent ? groups.map(g => g.lpEntityIds) : [lpIds]
        const owe = sets.map((ids, k) => (ent ? ent.byGroup[k] : target) - (paidByGroup.get(ids.join(',')) ?? 0))
        const members = sets.flatMap(ids => ids)
        const exact = sets.flatMap((ids, k) => {
          const ws = ids.map(id => weights.find(w => w.lpEntityId === id)?.commitment ?? 0)
          const all = ws.reduce((s, v) => s + v, 0)
          return ws.map(w => (all > 0 ? (owe[k] * w) / all : owe[k] / ids.length))
        })
        signedShares(accrued, exact).forEach((x, k) => put(members[k], -x))
        accruedCarry.push({
          date: f.date, nav: money(nav), entitlement: money(target), paid: money(gpPaid), accrued: money(accrued),
          byPartner: Object.fromEntries(partners.filter(p => (byPartner.get(p.id) ?? 0) !== 0).map(p => [p.id, money(byPartner.get(p.id)!)])),
        })
        break
      }
      case 'fund-end': {
        const repaid = new Map<string, number>()
        settleClawback(f.date, repaid)
        // What's still in escrow is released at fund end, after the clawback is taken from it.
        if (escrow) {
          const out = escrow.fundEnd(repaid)
          if (clawback) clawback.fromEscrow = money(out.fromEscrow)
          postEscrow(f.date, out.lines)
        }
        break
      }
      default:
        break
    }
  }

  /** The clawback at fund end, the recipients' repayments noted in `repaid` for the escrow. */
  function settleClawback(date: string, repaid: Map<string, number>) {
    if (!clawbackOn || !paysGp) return
    if (grouped) {
      // Netted across the classes, and back to the ones that were overpaid, by capital within each.
      const groups = groupsOn(date)
      const c = groupedClawback(priors, groups, date, gpPaid, carry.clawbackNetOfTaxRate)
      clawback = { date, paid: money(c.paid), entitlement: money(c.entitlement), amount: money(c.amount), ...(c.cap !== undefined ? { cap: money(c.cap) } : {}) }
      if (c.amount > 0) {
        for (const [id, a] of allocateAmount(c.amount, recipients.map(r => ({ lpEntityId: r.lpEntityId, commitment: r.pct })))) {
          if (a > 0) add(date, 'clawback', id, -a, true)
          repaid.set(id, a)
        }
        const weights = lpWeights(date)
        const back = groups.flatMap((g, k) => {
          const ws = weights.filter(w => g.lpEntityIds.includes(w.lpEntityId))
          const all = ws.reduce((s, w) => s + w.commitment, 0)
          return ws.map(w => ({ lpEntityId: w.lpEntityId, commitment: all > 0 ? (c.back[k] * w.commitment) / all : 0 }))
        })
        for (const [id, a] of allocateAmount(c.amount, back)) {
          if (a > 0) add(date, 'clawback', id, a)
        }
      }
      return
    }
    const lpContributions = contributions.filter(c => bearingIds.has(c.partner) && c.date <= date).map(c => ({ date: c.date, amount: c.amount, purpose: c.purpose }))
    const c = clawbackAtFundEnd(priors, lpContributions, carry, date, gpPaid)
    clawback = { date, paid: money(c.paid), entitlement: money(c.entitlement), amount: money(c.amount), ...(c.cap !== undefined ? { cap: money(c.cap) } : {}) }
    if (c.amount > 0) {
      // The recipients give it back by share, and the LPs receive it by capital.
      for (const [id, a] of allocateAmount(c.amount, recipients.map(r => ({ lpEntityId: r.lpEntityId, commitment: r.pct })))) {
        if (a > 0) add(date, 'clawback', id, -a, true)
        repaid.set(id, a)
      }
      for (const [id, a] of allocateAmount(c.amount, lpWeights(date))) {
        if (a > 0) add(date, 'clawback', id, a)
      }
    }
  }

  // The fee schedule (spec/07-management-fees.md), run by the engine's dated schedule.
  const fees: { start: string; end: string; gross: string; offset: string; net: string; recognized: Record<string, string>; unapplied: string; byPartner: Record<string, string> }[] = []
  const feesByPartner: Record<string, string> = {}
  const fee = terms.managementFee
  if (fee) {
    if (!(fee.frequency in { quarterly: 1, semiannual: 1, annual: 1 })) refuse('invalid-terms', `managementFee.frequency: ${fee.frequency}`)
    if (!fee.end) unsupported('a management fee with no end')
    const when = (from: string | { event: string }) =>
      typeof from === 'string' ? from
        : from.event === 'investment-period-end' ? terms.fund?.investmentPeriodEnd
        : flows.find(f => f.type === 'event' && f.name === from.event)?.date
    const stepsOf = (schedule: WFee['schedule'], where: string) => {
      const steps = (schedule ?? [])
        .map(s => ({ from: when(s.from), rate: num(s.rate, `${where} rate`), basis: s.basis }))
        .filter((s): s is { from: string; rate: number; basis: FeeScheduleBasis } => s.from !== undefined)
      if (steps.length === 0) refuse('invalid-terms', `${where} needs a step that applies`)
      return steps
    }
    const feeBearing = partners.filter(p => p.feeBearing ?? p.role === 'lp')
    // A class with rates of its own is a group of its own: its partners' own fee rates.
    const own = new Map(defined.filter(c => c.managementFee?.schedule).map(c => [c.id, c]))
    const groupOf = (p: WPartner) => (p.class !== undefined && own.has(p.class) ? p.class : '')
    const feeGroups = ['', ...own.keys()]
      .map(id => {
        const members = feeBearing.filter(p => groupOf(p) === id)
        return {
          members,
          commit: members.reduce((s, p) => s + (commitment.get(p.id) ?? 0), 0),
          steps: id === ''
            ? stepsOf(fee.schedule, 'managementFee.schedule')
            : stepsOf(own.get(id)!.managementFee!.schedule, `class ${id}: managementFee.schedule`),
        }
      })
      .filter(g => g.members.length > 0)
    const periods = feeSchedule({
      frequency: fee.frequency,
      start: fee.start,
      end: fee.end!,
      steps: feeGroups[0]?.steps ?? [],
      groups: feeGroups.map(g => ({ steps: g.steps, feeBearingCommitments: g.commit })),
      ...(fee.offsets ? { offsets: Object.fromEntries(Object.entries(fee.offsets).map(([k, v]) => [k, num(v, `offsets.${k}`)])) } : {}),
      ...(fee.organizationalExpenseCap !== undefined ? { organizationalExpenseCap: num(fee.organizationalExpenseCap, 'organizationalExpenseCap') } : {}),
    }, {
      feeBearingCommitments: feeBearing.reduce((s, p) => s + (commitment.get(p.id) ?? 0), 0),
      allCommitments: [...commitment.values()].reduce((s, c) => s + c, 0),
      investments: flows.filter(f => f.type === 'investment').map(f => ({ date: f.date, deal: f.deal, amount: Number(f.amount) })),
      exits: flows.filter(f => (f.type === 'write-off' || f.type === 'distributable') && f.deal)
        .map(f => ({ date: f.date, deal: f.deal, ...(f.costExited !== undefined ? { cost: Number(f.costExited) } : {}) })),
      navs: ordered.filter(f => f.type === 'nav').map(f => ({ date: f.date, amount: Number(f.amount) })),
      portfolioFees: flows.filter(f => f.type === 'portfolio-fee').map(f => ({ date: f.date, kind: f.kind, amount: Number(f.amount) })),
      organizationalExpenses: flows.filter(f => f.type === 'organizational-expense').map(f => ({ date: f.date, amount: Number(f.amount) })),
    })
    // Each partner pays its group's net by commitment: each period rounded on its own, and the
    // whole schedule rounded once.
    const owed = new Map<string, number>()
    for (const p of periods) {
      const parts = new Map<string, number>()
      feeGroups.forEach((g, k) => {
        for (const q of g.members) {
          const part = g.commit > 0 ? ((p.groupNet?.[k] ?? 0) * (commitment.get(q.id) ?? 0)) / g.commit : 0
          parts.set(q.id, part)
          owed.set(q.id, (owed.get(q.id) ?? 0) + part)
        }
      })
      const byPartner: Record<string, string> = {}
      for (const [id, a] of allocateAmount(p.net, feeBearing.map(q => ({ lpEntityId: q.id, commitment: parts.get(q.id) ?? 0 })))) {
        if (a !== 0) byPartner[id] = money(a)
      }
      fees.push({
        start: p.start, end: p.end, gross: money(p.gross), offset: money(p.offset), net: money(p.net),
        recognized: Object.fromEntries(Object.entries(p.recognized).map(([k, v]) => [k, money(v)])),
        unapplied: money(p.unapplied),
        byPartner,
      })
    }
    const net = periods.reduce((s, p) => s + p.net, 0)
    const shares = allocateAmount(net, feeBearing.map(p => ({ lpEntityId: p.id, commitment: owed.get(p.id) ?? 0 })))
    for (const [id, a] of shares) feesByPartner[id] = money(a)
  }

  const totals: Record<string, { contributed: string; distributed: string; net: string }> = {}
  for (const p of partners) {
    const c = contributedTo('9999-12-31', p.id)
    const d = received.get(p.id) ?? 0
    totals[p.id] = { contributed: money(c), distributed: money(d), net: money(d - c) }
  }
  return {
    walter: terms.walter === '0.3' || terms.walter === '0.2' ? terms.walter : '0.1',
    allocations,
    recontributions,
    recycled: recycledOut,
    ...(clawback ? { clawback } : {}),
    accruedCarry,
    carry: carryLines,
    escrow: escrowOut,
    fees,
    feesByPartner,
    totals,
    warnings: [...new Set(warnings)],
  }
}

/** `total` across signed `values` to the cent, so the parts add up to it: largest remainder, ties to the earlier. */
function signedShares(total: number, values: number[]): number[] {
  if (values.length === 0) return []
  const sum = values.reduce((s, v) => s + v, 0)
  const exact = sum === 0 ? values.map(() => total / values.length) : values.map(v => (total * v) / sum)
  const floors = exact.map(v => Math.floor(v * 100 + 1e-7))
  let short = Math.round(total * 100) - floors.reduce((s, x) => s + x, 0)
  const order = exact.map((v, i) => ({ i, rem: v * 100 - floors[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i)
  const out = floors.slice()
  for (let j = 0; short > 0 && order.length > 0; j = (j + 1) % order.length, short--) out[order[j].i] += 1
  for (let j = order.length - 1; short < 0 && order.length > 0; j = (j - 1 + order.length) % order.length, short++) out[order[j].i] -= 1
  return out.map(c => c / 100)
}
