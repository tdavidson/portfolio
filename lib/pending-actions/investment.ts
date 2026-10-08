import type { ActionDeps, PreviewResult } from './types'
import { resolveCompany, executeRecordInvestment, type RecordInvestmentInput } from '@/lib/agent/portfolio-tools'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { groupWriteDenial } from '@/lib/access/scope'
import { validateConversionLink } from '@/lib/accounting/conversion-link'

export { executeRecordInvestment }
export type { RecordInvestmentInput }

/**
 * What approving this does to the ledger, in words. Every derived entry posts
 * (lib/accounting/from-portfolio.ts); a round or a split books nothing.
 */
export function ledgerEffectText(input: RecordInvestmentInput): string {
  const t = input.transaction_type
  if (t === 'round_info' || t === 'split') return 'Books nothing — it moves neither value nor cash.'
  return `Posts a journal entry to ${input.vehicle ?? 'the vehicle'}'s ledger.`
}

/**
 * Read-only preview of a `record_investment`: resolve the company and describe the transaction and
 * its ledger effect WITHOUT writing anything (no insert, no `draftEntryForTransaction`). The real
 * write happens only when a human approves, via `executeRecordInvestment`.
 */
export async function previewRecordInvestment(deps: ActionDeps, input: RecordInvestmentInput): Promise<PreviewResult> {
  const c = await resolveCompany(deps.admin, deps.fundId, input.company, deps.access)
  // The same entity rule the write applies — refused when staged, not only when approved.
  const writeNames = (await entityScopeFor(deps.admin, deps.access)).vehicleNames
  const denied = groupWriteDenial(writeNames, input?.vehicle ?? null)
  if (denied) throw new Error(denied)
  if (input.converts_from_txn_id) {
    const linkError = await validateConversionLink(deps.admin, c.id, input.converts_from_txn_id, input.transaction_type, writeNames)
    if (linkError) throw new Error(linkError)
  }
  const amount =
    input.investment_cost ?? input.proceeds_received ?? input.unrealized_value_change ?? null
  const convertsFrom = input.converts_from_txn_id ?? null

  return {
    summary:
      `Record ${input.transaction_type} for ${c.name}` +
      (amount != null ? ` (${amount})` : '') +
      (convertsFrom ? ' — conversion' : ''),
    details: {
      company: c.name,
      transaction_type: input.transaction_type,
      amount,
      vehicle: input.vehicle ?? null,
      ...(convertsFrom ? { convertsFrom } : {}),
      ledgerEffect: ledgerEffectText(input),
    },
  }
}
