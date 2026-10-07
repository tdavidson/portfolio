// LP onboarding: the documents an investor owes the fund before, and after, admission.
//
// Signing happens off platform. What the platform keeps is the record: which executed document
// arrived for which entity, who uploaded it, whether the fund has looked at it, and when it
// lapses. The checklist is the fund's requirement set (a list of kinds on fund_settings) laid
// over its entities; an lp_onboarding_items row exists only once something has happened to an
// item, so an entity with no rows is simply outstanding on every required kind.
//
// Nothing here stores the contents of a form. A W-9 or W-8 that arrives this way is a file in
// the documents bucket, and its facts (TIN type and last four, classification, expiry) are
// recorded separately on the Tax page, which is deliberately the only place they live — see
// 20260827000003_lp_tax_forms.sql for why the full number is never kept.

export const ONBOARDING_KINDS = [
  'subscription_agreement',
  'lpa_signature',
  'tax_form',
  'kyc_identity',
  'kyc_entity',
  'beneficial_ownership',
  'accreditation',
  'side_letter',
  'wire_instructions',
  'k1_econsent',
  'other',
] as const

export type OnboardingKind = (typeof ONBOARDING_KINDS)[number]

export const ONBOARDING_KIND_LABEL: Record<OnboardingKind, string> = {
  subscription_agreement: 'Subscription agreement',
  lpa_signature: 'LPA signature page',
  tax_form: 'Tax form (W-9 / W-8)',
  kyc_identity: 'Identity verification',
  kyc_entity: 'Entity formation documents',
  beneficial_ownership: 'Beneficial ownership',
  accreditation: 'Accreditation / qualified purchaser',
  side_letter: 'Side letter',
  wire_instructions: 'Wire instructions',
  k1_econsent: 'Electronic K-1 delivery consent',
  other: 'Other',
}

/** What the LP sees under each item in the portal, so they know what to send. */
export const ONBOARDING_KIND_HELP: Record<OnboardingKind, string> = {
  subscription_agreement: 'The countersigned subscription agreement for this entity.',
  lpa_signature: 'Your executed signature page to the limited partnership agreement.',
  tax_form: 'A signed IRS Form W-9 (US persons) or the applicable W-8 (everyone else).',
  kyc_identity: 'Government-issued identification for the individual, or for each authorized signatory of an entity.',
  kyc_entity: 'Formation documents: certificate of formation, operating or trust agreement, and evidence of authority to invest.',
  beneficial_ownership: 'A beneficial ownership certification for the entity.',
  accreditation: 'Your accredited investor or qualified purchaser questionnaire, or a third-party verification letter.',
  side_letter: 'The executed side letter, if one applies to this entity.',
  wire_instructions: 'Instructions for distributions, on letterhead or a bank-verified form.',
  k1_econsent: 'Your consent to receive Schedule K-1s and related tax documents through this portal instead of on paper. Nothing to upload — read the disclosure and consent.',
  other: 'Any other document your fund has asked for.',
}

/** Kinds that are a document. The rest are answered in the portal, not uploaded. */
export const DOCUMENT_KINDS: OnboardingKind[] = ONBOARDING_KINDS.filter(k => k !== 'k1_econsent')

/** The requirement set a fund starts with. Side letters and "other" are opt-in. */
export const DEFAULT_ONBOARDING_KINDS: OnboardingKind[] = [
  'subscription_agreement',
  'lpa_signature',
  'tax_form',
  'kyc_identity',
  'kyc_entity',
  'beneficial_ownership',
  'accreditation',
  'wire_instructions',
  'k1_econsent',
]

export function isOnboardingKind(v: unknown): v is OnboardingKind {
  return typeof v === 'string' && (ONBOARDING_KINDS as readonly string[]).includes(v)
}

/** Keep a stored requirement list in canonical order, without duplicates or unknown kinds. */
export function normalizeKinds(raw: unknown): OnboardingKind[] {
  if (!Array.isArray(raw)) return DEFAULT_ONBOARDING_KINDS
  const set = new Set(raw.filter(isOnboardingKind))
  return ONBOARDING_KINDS.filter(k => set.has(k))
}

export const ONBOARDING_STATUSES = ['outstanding', 'submitted', 'verified', 'rejected', 'waived'] as const
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]

export function isOnboardingStatus(v: unknown): v is OnboardingStatus {
  return typeof v === 'string' && (ONBOARDING_STATUSES as readonly string[]).includes(v)
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  outstanding: 'Outstanding',
  submitted: 'Awaiting review',
  verified: 'Verified',
  rejected: 'Needs attention',
  waived: 'Waived',
}

/** The statuses a fund admin may set by hand. `submitted` only ever comes from an upload. */
export const REVIEW_STATUSES: OnboardingStatus[] = ['verified', 'rejected', 'waived', 'outstanding']

export interface OnboardingItemRow {
  id: string
  lp_entity_id: string
  kind: string
  status: string
  document_id: string | null
  submitted_at: string | null
  reviewed_at: string | null
  expires_on: string | null
  note: string | null
}

/** The closing an entity was admitted at (its earliest, when it sits in several vehicles). */
export interface ClosingRef {
  id: string
  name: string
  closeDate: string
  vehicle: string
}

export interface OnboardingEntity {
  id: string
  name: string
  investorId: string
  investorName: string
  closing?: ClosingRef | null
  partnerClass?: string | null
}

export interface OnboardingCell {
  kind: OnboardingKind
  label: string
  status: OnboardingStatus
  /** Verified but past its expiry date — shown as such, counted as outstanding. */
  expired: boolean
  itemId: string | null
  documentId: string | null
  submittedAt: string | null
  reviewedAt: string | null
  expiresOn: string | null
  note: string | null
}

export interface OnboardingEntityRow extends OnboardingEntity {
  items: OnboardingCell[]
  /** Days until the entity's closing; negative once it has passed; null with no closing. */
  daysToClose: number | null
  /** Required kinds not yet verified or waived (an expired verification counts). */
  outstanding: number
  /** Uploads waiting for the fund to look at them. */
  awaitingReview: number
  complete: boolean
}

function cellStatus(item: OnboardingItemRow | undefined): OnboardingStatus {
  if (!item) return 'outstanding'
  return isOnboardingStatus(item.status) ? item.status : 'outstanding'
}

/**
 * Lay the fund's requirement set over its entities. Items not in the required set are still
 * shown when a row exists for them (a side letter uploaded before the fund turned the kind off
 * does not vanish), listed after the required ones.
 */
export function buildOnboardingMatrix(
  entities: OnboardingEntity[],
  requiredKinds: OnboardingKind[],
  items: OnboardingItemRow[],
  today: string = new Date().toISOString().slice(0, 10),
): OnboardingEntityRow[] {
  const byEntity = new Map<string, Map<string, OnboardingItemRow>>()
  for (const it of items) {
    if (!byEntity.has(it.lp_entity_id)) byEntity.set(it.lp_entity_id, new Map())
    byEntity.get(it.lp_entity_id)!.set(it.kind, it)
  }
  const required = new Set(requiredKinds)

  return entities.map(e => {
    const rows = byEntity.get(e.id) ?? new Map<string, OnboardingItemRow>()
    const extra = ONBOARDING_KINDS.filter(k => !required.has(k) && rows.has(k))
    const kinds = [...requiredKinds, ...extra]
    const cells: OnboardingCell[] = kinds.map(kind => {
      const item = rows.get(kind)
      const status = cellStatus(item)
      const expired = status === 'verified' && !!item?.expires_on && item.expires_on < today
      return {
        kind,
        label: ONBOARDING_KIND_LABEL[kind],
        status,
        expired,
        itemId: item?.id ?? null,
        documentId: item?.document_id ?? null,
        submittedAt: item?.submitted_at ?? null,
        reviewedAt: item?.reviewed_at ?? null,
        expiresOn: item?.expires_on ?? null,
        note: item?.note ?? null,
      }
    })
    const requiredCells = cells.filter(c => required.has(c.kind))
    const outstanding = requiredCells.filter(c => !(c.status === 'verified' && !c.expired) && c.status !== 'waived').length
    const awaitingReview = cells.filter(c => c.status === 'submitted').length
    const daysToClose = e.closing ? daysBetween(today, e.closing.closeDate) : null
    return { ...e, items: cells, outstanding, awaitingReview, complete: outstanding === 0, daysToClose }
  })
}

/** Whole days from one ISO date to another; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

/**
 * Order entities for the fund's review: nearest closing first, incomplete before complete within
 * a closing, entities with no closing last. What the fund needs to look at is what closes soonest.
 */
export function sortByClosing<T extends { daysToClose: number | null; complete: boolean; name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.daysToClose === null && b.daysToClose !== null) return 1
    if (b.daysToClose === null && a.daysToClose !== null) return -1
    if (a.daysToClose !== null && b.daysToClose !== null && a.daysToClose !== b.daysToClose) return a.daysToClose - b.daysToClose
    if (a.complete !== b.complete) return a.complete ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

/** "before Second Close on Jun 30" / "Second Close was Jun 30" — one phrase for emails and the portal. */
export function closingPhrase(c: ClosingRef, daysToClose: number | null): string {
  const d = new Date(`${c.closeDate}T00:00:00Z`)
  const date = isNaN(d.getTime()) ? c.closeDate : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  if (daysToClose !== null && daysToClose < 0) return `${c.name} was ${date}`
  return `before ${c.name} on ${date}`
}

/** Where an entity's onboarding uploads live in the lp-documents bucket. The server owns this. */
export function onboardingStoragePrefix(fundId: string, entityId: string): string {
  return `${fundId}/onboarding/${entityId}/`
}

export function safeFileName(raw: string): string {
  return raw.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 200)
}

export const ONBOARDING_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** What an LP may upload: the formats a signed document arrives in. */
export const ONBOARDING_ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

/**
 * Entity → the closing it was admitted at. An entity in several vehicles is admitted at a close of
 * each; the earliest is the one the checklist is due by. Reads through whatever client is given
 * (the routes pass the service-role client and scope by entity id).
 */
export async function loadClosingsByEntity(
  admin: any,
  entityIds: string[],
  /** The caller's entities' names, or null for all. An LP in two entities must not show a fund
   *  member the OTHER entity's closing. The LP portal (the LP's own view) passes null. */
  visibleNames: string[] | null = null,
): Promise<Map<string, ClosingRef>> {
  const out = new Map<string, ClosingRef>()
  if (entityIds.length === 0) return out
  const { data } = await admin
    .from('vehicle_closing_members')
    .select('lp_entity_id, vehicle_closings(id, name, close_date, fund_vehicles(name))')
    .in('lp_entity_id', entityIds)
  for (const m of (data ?? []) as any[]) {
    const c = Array.isArray(m.vehicle_closings) ? m.vehicle_closings[0] : m.vehicle_closings
    if (!c) continue
    const vehName = (Array.isArray(c.fund_vehicles) ? c.fund_vehicles[0] : c.fund_vehicles)?.name ?? ''
    if (visibleNames !== null && !visibleNames.includes(vehName)) continue
    const veh = Array.isArray(c.fund_vehicles) ? c.fund_vehicles[0] : c.fund_vehicles
    const ref: ClosingRef = { id: c.id, name: c.name, closeDate: c.close_date, vehicle: veh?.name ?? '' }
    const prev = out.get(m.lp_entity_id)
    if (!prev || ref.closeDate < prev.closeDate) out.set(m.lp_entity_id, ref)
  }
  return out
}
