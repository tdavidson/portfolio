// Who may file and read fund records (lib/records/index.ts), as pure rules with no server imports,
// so the tool registry, the web route and the service all ask the same question the same way.
//
// A record lives in one AREA, which is an access domain: accounting, tax, compliance and so on.
// Reading it needs read on that area. Filing one needs read too, not write: a record is the fund's
// note of what was concluded about things the person can already see, and it changes nothing
// else. An auditor with read on accounting files their session summary there. A credential still
// has to carry write to file, and the read-only demo files nothing.
//
// The entity is the other half (canSeeVehicle): a record on an entity outside the caller's scope
// is invisible to them, and a fund-wide record (no entity) is visible only to someone who sees
// every entity.

import { DOMAIN_META, type Domain } from '@/lib/access/domains'
import { hasAccess, type AccessContext } from '@/lib/access/effective'

/** Every area a record can be filed in: each access domain but admin. */
export const RECORD_AREAS = [
  'portfolio', 'relationships', 'dealflow', 'diligence', 'accounting', 'management_company',
  'lp_capital', 'gp_economics', 'lp_relations', 'compliance', 'tax',
] as const satisfies readonly Domain[]
export type RecordArea = (typeof RECORD_AREAS)[number]

export const RECORD_KINDS = ['summary', 'decision', 'memo', 'transcript', 'note'] as const
export type RecordKind = (typeof RECORD_KINDS)[number]

export const RECORD_SUBJECTS = ['company', 'lp_investor', 'journal_entry', 'deal'] as const
export type RecordSubject = (typeof RECORD_SUBJECTS)[number]

export function isRecordArea(v: unknown): v is RecordArea {
  return typeof v === 'string' && (RECORD_AREAS as readonly string[]).includes(v)
}

/** The areas this person may read, and so file in. */
export function readableAreas(access: AccessContext): RecordArea[] {
  return RECORD_AREAS.filter(a => hasAccess(access, a, 'read'))
}

export function areaLabel(area: RecordArea): string {
  return DOMAIN_META[area].label
}

/**
 * Null when this person may do this; otherwise the refusal. `area` absent means "across every
 * area I can read" (a list or a read by id, which the service then trims per record).
 */
export function recordAccessProblem(
  access: AccessContext,
  args: { area?: unknown; filing: boolean },
): string | null {
  if (args.filing && access.role === 'viewer') return 'The read-only demo cannot file records.'
  if (args.area === undefined || args.area === null || args.area === '') {
    if (args.filing) return `Name the area to file in: one of ${RECORD_AREAS.join(', ')}.`
    return readableAreas(access).length > 0 ? null : 'You have no area of the fund to keep records in.'
  }
  if (!isRecordArea(args.area)) return `Unknown area "${String(args.area)}". Use one of ${RECORD_AREAS.join(', ')}.`
  return hasAccess(access, args.area, 'read') ? null : `You do not have access to ${areaLabel(args.area)}.`
}
