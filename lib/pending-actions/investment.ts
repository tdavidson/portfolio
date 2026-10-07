import type { ActionDeps, PreviewResult } from './types'
import { resolveCompany, executeRecordInvestment, type RecordInvestmentInput } from '@/lib/agent/portfolio-tools'

export { executeRecordInvestment }
export type { RecordInvestmentInput }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/**
 * What approving this does to the ledger, in words. Mirrors postsOnRecord in
 * lib/accounting/from-portfolio.ts from the inputs alone (the preview writes nothing, so it cannot
 * derive the postings): an entry with no cash leg posts, one that moves cash drafts and waits for
 * its bank match.
 */
export function ledgerEffectText(input: RecordInvestmentInput): string {
  const where = `${input.vehicle ?? 'the vehicle'}'s ledger`
  const t = input.transaction_type
  if (t === 'round_info' || t === 'split') return 'Books nothing — it moves neither value nor cash.'
  const movesCash =
    t === 'investment' ? num(input.investment_cost) !== 0 :
    t === 'proceeds' ? num(input.proceeds_received) !== 0 :
    t === 'unrealized_gain_change' ? false :
    true
  return movesCash
    ? `Drafts a journal entry in ${where}; it posts when matched to its bank transaction.`
    : `Posts a journal entry to ${where} — it moves no cash.`
}

/**
 * Read-only preview of a `record_investment`: resolve the company and describe the transaction and
 * its ledger effect WITHOUT writing anything (no insert, no `draftEntryForTransaction`). The real
 * write happens only when a human approves, via `executeRecordInvestment`.
 */
export async function previewRecordInvestment(deps: ActionDeps, input: RecordInvestmentInput): Promise<PreviewResult> {
  const c = await resolveCompany(deps.admin, deps.fundId, input.company, deps.access)
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
