// The standard areas of a fund and how they relate (spec/fund-access/01-areas-and-levels.md).
// Pure data. An implementation may define more areas; vectors use only these.

export type Level = 'none' | 'read' | 'propose' | 'write'

export const LEVEL_RANK: Record<Level, number> = { none: 0, read: 1, propose: 2, write: 3 }

export const AREAS = [
  'portfolio', 'relationships', 'dealflow', 'diligence', 'accounting', 'management_company',
  'lp_capital', 'gp_economics', 'lp_relations', 'compliance', 'tax', 'admin',
] as const

export type Area = (typeof AREAS)[number]

export interface AreaDef {
  /** A member at `propose` puts changes forward for someone with write to accept. */
  proposable?: true
  /** Closed to anyone who cannot read this other area, whatever the area's own grant says. */
  requires?: Area
  /** Granted at least as far as this other area is (one hop; propose confers read). */
  impliedBy?: Area
  /** With no grant and no fund default of its own, falls back to this area's. */
  defaultFrom?: Area
  /** Admins only. No grant opens it to anyone else. */
  adminOnly?: true
}

export const STANDARD_AREAS: Record<Area, AreaDef> = {
  portfolio: {},
  relationships: {},
  dealflow: {},
  diligence: {},
  accounting: { proposable: true },
  management_company: {},
  lp_capital: { impliedBy: 'accounting' },
  gp_economics: {},
  lp_relations: {},
  compliance: {},
  tax: { requires: 'accounting', defaultFrom: 'accounting' },
  admin: { adminOnly: true },
}

/** Areas a record can be filed in: every standard area but admin. */
export const RECORD_AREAS = AREAS.filter(a => a !== 'admin')
