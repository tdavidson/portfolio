import { ACCOUNTING_SECTIONS, sectionsForKind, type AccountingSection } from './nav'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'

// The entity index's links, in a module of their own so the client list can import them without
// the loader's database code. See ./entity-index.ts.

export interface IndexEntity {
  /** The `fund_vehicles` id, or null for a legacy name-only vehicle (addressed by its name). */
  id: string | null
  name: string
  kind: string | null
  /** False only for a wound-down management company, which stays listed so its books stay reachable. */
  active: boolean
}

/** Where an entity's pages live: `/funds/<id>`, or `/funds/<name>` for a legacy vehicle. */
export function entityBase(e: { id: string | null; name: string }): string {
  return `/funds/${e.id ?? encodeURIComponent(e.name)}`
}

/**
 * The pages an entity of `kind` has that this caller may open, in nav order — the same list the
 * sidebar shows inside the entity. No pending counts are loaded for the index, so a page listed
 * only while work is waiting (Receipts outside a management company) is left out; the entity's
 * own subnav still offers it when there is.
 */
export function entityPagesFor(
  kind: string | null,
  canOpen: (domain: Domain, feature?: FeatureKey) => boolean,
): AccountingSection[] {
  return sectionsForKind(ACCOUNTING_SECTIONS, kind ?? 'fund')
    .filter(s => !s.requiresFof)
    .filter(s => canOpen(s.domain ?? 'accounting', s.feature))
}
