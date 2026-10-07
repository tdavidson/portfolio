import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Validate a conversion's `converts_from_txn_id` link. Returns an error message, or null if valid.
 *
 * Used by BOTH the create (POST) and edit (PATCH) routes so an edit can never set a link the create
 * would have rejected. A dangling, cross-company, self-referential, or non-investment link silently
 * breaks the basis carry in computeSummary (its loop just `continue`s) and resolves the wrong source
 * into the ledger draft — with no error surfaced. So it must be validated wherever it can be set.
 */
export async function validateConversionLink(
  admin: SupabaseClient,
  companyId: string,
  convertsFrom: string,
  transactionType: string,
  /** The caller's entity names (null = all). Required: the source must be one of their positions —
   *  a conversion moves its source, so linking another entity's SAFE would move that entity's. */
  visibleNames: string[] | null,
  selfId?: string,
): Promise<string | null> {
  if (transactionType !== 'investment') return 'Only an investment can be a conversion.'
  if (selfId && convertsFrom === selfId) return 'A conversion cannot convert from itself.'
  const { data: src } = await admin
    .from('investment_transactions' as any)
    .select('id, transaction_type, portfolio_group')
    .eq('id', convertsFrom)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { id: string; transaction_type: string; portfolio_group: string | null } | null }
  const theirs = !!src && (visibleNames === null || (!!src.portfolio_group && visibleNames.includes(src.portfolio_group)))
  if (!src || !theirs || src.transaction_type !== 'investment') {
    return 'The instrument being converted was not found on this company.'
  }
  return null
}
