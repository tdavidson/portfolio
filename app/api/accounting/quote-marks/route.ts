import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadPostedLedger } from '@/lib/accounting/load'
import { draftEntryForTransaction, tallyLedgerResults } from '@/lib/accounting/from-portfolio'
import { ledgerCarryingByHolding } from '@/lib/portfolio/fof-load'
import { buildSoiPositions, type SoiCompany } from '@/lib/accounting/soi'
import {
  periodEndQuoteMarks,
  type PriceFeed, type PriceObservation, type QuotedPosition,
} from '@/lib/portfolio/quotes'

/**
 * The period-end marks a quoted book still owes, and the action that books them.
 *
 * This is the quoted twin of a fund holding's NAV mark (lib/portfolio/fof-nav.ts): the close blocks
 * on an unbooked mark, and a blocker with no button is a dead end. Same derive-at-close reason
 * too — a quote entered on the 3rd for the 31st, a split announced afterwards, and a trade that
 * settles late all change what the position should carry, and recomputing the whole thing here
 * makes the order they arrived in irrelevant.
 *
 * It DRAFTS rather than posts, like every other portfolio-to-ledger path in this repo
 * (lib/accounting/from-portfolio.ts). A price arriving from a feed is not authority to write to
 * the books.
 */
async function marksFor(admin: any, fundId: string, group: string, asOf: string) {
  const { data: feedRows } = await admin.from('price_feeds').select('*').eq('fund_id', fundId)
  const feeds = ((feedRows as any[]) ?? []).map(f => ({
    id: f.id,
    companyId: f.company_id,
    kind: f.kind,
    symbol: f.symbol,
    exchange: f.exchange,
    quoteCurrency: f.quote_currency,
    quoteScale: Number(f.quote_scale ?? 1),
    activeFrom: f.active_from,
    activeUntil: f.active_until,
    restrictionUntil: f.restriction_until,
    restrictionDiscount: f.restriction_discount == null ? null : Number(f.restriction_discount),
  })) as PriceFeed[]
  if (feeds.length === 0) return { marks: [], feeds }

  const [{ data: obsRows }, { data: txnRows }, { data: companyRows }, ledger] = await Promise.all([
    admin.from('price_observations').select('*').eq('fund_id', fundId).lte('as_of_date', asOf),
    admin.from('investment_transactions').select('*').eq('fund_id', fundId),
    admin.from('companies').select('*').eq('fund_id', fundId),
    loadPostedLedger(admin, fundId, group, asOf),
  ])

  const observations = ((obsRows as any[]) ?? []).map(o => ({
    feedId: o.feed_id,
    asOfDate: o.as_of_date,
    price: Number(o.price),
    basis: o.basis,
  })) as PriceObservation[]

  // Cut the history at the period end before valuing it, so a re-close of an earlier period
  // reproduces rather than picking up everything that has happened since.
  const upTo = ((txnRows as any[]) ?? []).filter(t => !t.transaction_date || t.transaction_date <= asOf)
  const soi = buildSoiPositions(upTo, ((companyRows as any[]) ?? []) as SoiCompany[], group, new Date(asOf))
  const carrying = ledgerCarryingByHolding(ledger.accounts, ledger.postings)

  const positions: QuotedPosition[] = soi.map(p => ({
    companyId: p.companyId,
    name: p.name,
    // Split-adjusted, because it came through computeSummary. A raw share count here is the
    // halving bug: a post-split quote multiplied by a pre-split quantity.
    shares: p.shares ?? 0,
    ledgerCarrying: carrying.get(p.companyId) ?? 0,
  }))

  return { marks: periodEndQuoteMarks(positions, feeds, observations, asOf), feeds }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10)

  const { marks } = await marksFor(admin, gate.fundId, group, asOf)
  return NextResponse.json({ asOf, marks })
}

// POST — book every pending mark as an unrealized_gain_change, drafting its ledger entry.
// This is the action that clears the close blocker.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? null)
  if (group instanceof NextResponse) return group
  const asOf = typeof body?.asOf === 'string' ? body.asOf : new Date().toISOString().slice(0, 10)

  const { marks } = await marksFor(admin, gate.fundId, group, asOf)

  const errors: string[] = []
  const ledger: Parameters<typeof tallyLedgerResults>[0] = []
  for (const m of marks) {
    const { data: txn, error } = await (admin as any)
      .from('investment_transactions')
      .insert({
        fund_id: gate.fundId,
        company_id: m.companyId,
        transaction_type: 'unrealized_gain_change',
        transaction_date: asOf,
        unrealized_value_change: m.delta,
        // Both are set for the same reason the FX path sets both: computeSummary reads the share
        // price for priced-equity rounds and the value change for convertibles, so the mark has
        // to land either way without double-counting.
        current_share_price: m.price,
        // Distinguishes a quoted mark from a judgement mark ('mark') and a rate move ('fx') —
        // the income statement can then say how much of the change in unrealized appreciation
        // came from a market rather than from a revaluation.
        valuation_change_source: 'quote',
        portfolio_group: group,
        notes: `${m.symbol} at ${m.price} on ${m.quoteDate} (Level ${m.level})`,
      })
      .select('id, company_id, transaction_type, transaction_date, unrealized_value_change, current_share_price, portfolio_group')
      .single()
    if (error || !txn) { errors.push(`${m.name}: ${error?.message ?? 'insert failed'}`); continue }

    // A mark has no cash leg, so it posts on record — unless its period is closed, which is
    // refused and reported here (this used to read a `skipped` field that never existed, so
    // every refusal was swallowed and counted as booked).
    ledger.push({ name: m.name, result: await draftEntryForTransaction(admin, gate.fundId, user.id, txn, m.name) })
  }

  const { booked, posted, drafted, errors: ledgerErrors } = tallyLedgerResults(ledger)
  return NextResponse.json({ asOf, booked, posted, drafted, total: marks.length, errors: [...errors, ...ledgerErrors] })
}
