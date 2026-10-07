import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { syncFundQuotes } from '@/lib/portfolio/quote-sync'
import { PROVIDER_NAMES, HAS_FETCHING_PROVIDER } from '@/lib/portfolio/quote-providers'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeCompanyRows } from '@/lib/access/scope'

/**
 * Price feeds — the link between a holding and an observable price — and the quotes stored
 * against them.
 *
 * A feed is what makes a position Level 1 or 2 instead of Level 3, so creating one is a
 * VALUATION decision rather than a piece of reference data. Everything unusual about this
 * route follows from that.
 */

const KINDS = ['listed_equity', 'digital_asset']
const BASES = ['close', 'intraday', 'indicative']

// GET — every feed for the fund, each with its most recent stored quote.
export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const [{ data: feeds, error }, { data: observations }] = await Promise.all([
    (admin as any).from('price_feeds').select('*').eq('fund_id', gate.fundId).order('symbol'),
    (admin as any).from('price_observations').select('*').eq('fund_id', gate.fundId)
      .order('as_of_date', { ascending: false }),
  ])
  if (error) return dbError(error, 'price-feeds-get')

  const latest = new Map<string, any>()
  for (const o of ((observations as any[]) ?? [])) {
    if (!latest.has(o.feed_id)) latest.set(o.feed_id, o)
  }

  // Only feeds on companies the caller can see.
  const scope = await loadEntityScope(admin, gate)
  return NextResponse.json({
    feeds: scopeCompanyRows((feeds as any[]) ?? [], scope.companyIds, 'company_id').map(f => ({ ...f, latestQuote: latest.get(f.id) ?? null })),
    providers: PROVIDER_NAMES,
    // False until a vendor adapter is registered. The UI uses it to hide a sync control that
    // could only ever report "nothing to fetch" — prices are entered by hand today.
    canFetch: HAS_FETCHING_PROVIDER,
  })
}

// POST — create a feed, or record a quote against one.
//   { action: 'create-feed', companyId, kind, symbol, ... }
//   { action: 'record-quote', feedId, asOfDate, price, basis? }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))

  if (body?.action === 'record-quote') {
    const feedId = body.feedId
    const asOfDate = body.asOfDate
    const price = Number(body.price)
    const basis = body.basis ?? 'close'

    if (!feedId || !asOfDate) {
      return NextResponse.json({ error: 'feedId and asOfDate are required.' }, { status: 400 })
    }
    if (!Number.isFinite(price) || price < 0) {
      return NextResponse.json({ error: 'price must be a non-negative number.' }, { status: 400 })
    }
    if (!BASES.includes(basis)) {
      return NextResponse.json({ error: `basis must be one of: ${BASES.join(', ')}` }, { status: 400 })
    }

    // The feed must belong to the CALLER'S fund. fund_id comes from the membership lookup and
    // never from the body — the cross-tenant rule this repo enforces everywhere — so a feedId
    // from another fund has to be rejected here rather than silently scoped away.
    const { data: feed } = await (admin as any)
      .from('price_feeds').select('id, fund_id, symbol, company_id').eq('id', feedId).maybeSingle()
    const feedScope = await loadEntityScope(admin, gate)
    if (!feed || feed.fund_id !== gate.fundId
      || (feedScope.companyIds !== null && !feedScope.companyIds.includes(feed.company_id))) {
      return NextResponse.json({ error: 'Feed not found.' }, { status: 404 })
    }

    // Upsert on (feed_id, as_of_date): a corrected price REPLACES the one it corrects rather
    // than joining it, so nothing can win by insertion order later.
    const { data: obs, error } = await (admin as any)
      .from('price_observations')
      .upsert({
        fund_id: gate.fundId,
        feed_id: feedId,
        as_of_date: asOfDate,
        price,
        basis,
        source: 'manual',
        created_by: user.id,
      }, { onConflict: 'feed_id,as_of_date' })
      .select('*')
      .single()
    if (error) return dbError(error, 'price-feeds-record-quote')

    logActivity(admin, gate.fundId, user.id, 'price_quote.record', {
      feedId, symbol: feed.symbol, asOfDate, price,
    })
    return NextResponse.json({ observation: obs })
  }

  if (body?.action === 'sync-now') {
    // Asks whatever provider is registered for fresh quotes. With only hand entry registered it
    // returns zeros rather than failing — there is no one to ask, which is not an error.
    const today = new Date().toISOString().slice(0, 10)
    const result = await syncFundQuotes(admin, gate.fundId, today)
    return NextResponse.json(result)
  }

  // --- create-feed (the default action) ---
  const { companyId, kind, symbol } = body
  if (!companyId) return NextResponse.json({ error: 'companyId is required.' }, { status: 400 })
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of: ${KINDS.join(', ')}` }, { status: 400 })
  }
  if (!symbol) return NextResponse.json({ error: 'symbol is required.' }, { status: 400 })
  if (!body.activeFrom) {
    return NextResponse.json(
      { error: 'activeFrom is required — the date the feed starts pricing this holding (a listing date, or the purchase date). Periods before it mark from the holding\'s rounds.' },
      { status: 400 },
    )
  }

  const { data: company } = await admin
    .from('companies').select('id, fund_id, name').eq('id', companyId).maybeSingle()
  const companyScope = await loadEntityScope(admin, gate)
  if (!company || (company as any).fund_id !== gate.fundId
    || (companyScope.companyIds !== null && !companyScope.companyIds.includes(companyId))) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 })
  }

  const discount = body.restrictionDiscount == null ? null : Number(body.restrictionDiscount)
  if (discount != null && (!Number.isFinite(discount) || discount < 0 || discount >= 1)) {
    return NextResponse.json(
      { error: 'restrictionDiscount is a fraction between 0 and 1 (0.2 = a 20% discount for lack of marketability).' },
      { status: 400 },
    )
  }
  // A discount with no end date would apply forever, quietly holding the position at Level 2
  // and below its quoted price long after the lock-up expired.
  if (discount != null && discount > 0 && !body.restrictionUntil) {
    return NextResponse.json(
      { error: 'A restrictionDiscount needs a restrictionUntil date — otherwise the discount never lapses.' },
      { status: 400 },
    )
  }

  const scale = body.quoteScale == null ? 1 : Number(body.quoteScale)
  if (!Number.isFinite(scale) || scale <= 0) {
    return NextResponse.json(
      { error: 'quoteScale must be positive — 100 for a GBp (pence) listing, 1 otherwise.' },
      { status: 400 },
    )
  }

  const { data: feed, error } = await (admin as any)
    .from('price_feeds')
    .insert({
      fund_id: gate.fundId,
      company_id: companyId,
      kind,
      symbol,
      exchange: body.exchange ?? null,
      chain: body.chain ?? null,
      contract_address: body.contractAddress ?? null,
      quote_currency: body.quoteCurrency ?? 'USD',
      quote_scale: scale,
      provider: PROVIDER_NAMES.includes(body.provider) ? body.provider : 'manual',
      provider_id: body.providerId ?? null,
      active_from: body.activeFrom,
      active_until: body.activeUntil ?? null,
      restriction_until: body.restrictionUntil ?? null,
      restriction_discount: discount,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select('*')
    .single()
  if (error) return dbError(error, 'price-feeds-create')

  logActivity(admin, gate.fundId, user.id, 'price_feed.create', {
    companyId, symbol, kind,
  })
  return NextResponse.json({ feed })
}

// DELETE — remove a feed (?id=). Its observations cascade.
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required.' }, { status: 400 })

  // Scoped to the caller's fund in the filter itself, so a foreign id deletes nothing — and to the
  // companies they can see.
  const deleteScope = await loadEntityScope(admin, gate)
  let del = (admin as any).from('price_feeds').delete().eq('id', id).eq('fund_id', gate.fundId)
  if (deleteScope.companyIds !== null) del = del.in('company_id', deleteScope.companyIds)
  const { error } = await del
  if (error) return dbError(error, 'price-feeds-delete')

  logActivity(admin, gate.fundId, user.id, 'price_feed.delete', { feedId: id })
  return NextResponse.json({ ok: true })
}
