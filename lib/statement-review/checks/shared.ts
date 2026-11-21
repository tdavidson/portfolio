// What every check takes and gives back. See ../run.ts for how they are run together.

import type { PullMatch } from '@/lib/admin-reporting/figures'
import type { CheckContext } from '../compare'
import type { CheckOutcome, Finding, PartnerStatement, StatementPackage } from '../types'

/** A partner the app knows in the vehicle on the period end. */
export interface KnownPartner { lpEntityId: string; name: string }

export interface CheckInput {
  /** The package, with each partner's lpEntityId filled in where it was matched. */
  pkg: StatementPackage
  /** The previous period's package for the vehicle, partners matched the same way. */
  prior?: { periodEnd: string; partners: PartnerStatement[] } | null
  /** Who the app knows in the vehicle on the period end. Null when it couldn't tell. */
  known?: KnownPartner[] | null
  /** How each package partner was matched, in the package's order. */
  matches?: PullMatch[]
}

export interface CheckResult {
  outcome: CheckOutcome
  findings: Finding[]
}

export type Check = (input: CheckInput, ctx: CheckContext) => CheckResult

export const partnerSubject = (p: PartnerStatement): Finding['subject'] =>
  ({ kind: 'partner', ...(p.lpEntityId ? { id: p.lpEntityId } : {}), label: p.name })

export const fundSubject = (label = 'Fund'): Finding['subject'] => ({ kind: 'fund', label })

export const push = (list: Finding[], f: Finding | null) => { if (f) list.push(f) }
