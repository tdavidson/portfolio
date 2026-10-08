import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain, investments feature (lib/access/route-domains.ts). The holding is scoped by
// holdingForRequest; marks are per (holding, entity) and only for the caller's entities.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { holdingForRequest, isRealDate, type HoldingContext } from '@/lib/portfolio/holding-route'
import { holdingEntities } from '@/lib/portfolio/holding-entities'
import { quoteMarkForHolding, bookQuoteMark } from '@/lib/portfolio/quote-marks'
import { PROVIDER_NAMES } from '@/lib/portfolio/quote-providers'

/**
 * The price feed one holding marks from, the quotes stored against it, and the quoted mark each of
 * the caller's entities still owes — configured where the holding lives
 * (plans/spec-ledger-one-writer.md §6). A feed is a VALUATION decision: it is what makes a position
 * Level 1 or 2, and it is the only thing the close's quoted check reads.
 */

const KINDS = ['listed_equity', 'digital_asset']
const BASES = ['close', 'intraday', 'indicative']
const today = () => new Date().toISOString().slice(0, 10)
const bad = (error: string) => NextResponse.json({ error }, { status: 400 })
const unread = (what: string) => NextResponse.json({ error: `Could not read ${what}.` }, { status: 500 })

const SHARED_FEED = "This price feed also prices another entity's position."

/**
 * One feed prices the holding for EVERY entity, so editing it is only for a caller who sees every
 * entity linked to the holding. True/false, or a 500 when the comparison cannot be read.
 */
async function canEditFeed(admin: any, fundId: string, id: string, ctx: HoldingContext): Promise<boolean | NextResponse> {
  if (ctx.scope.access.vehicles.all) return true
  try {
    const all = await holdingEntities(admin, fundId, id, { vehicles: { all: true, ids: [] } })
    return all.every(e => ctx.entities.some(c => c.id === e.id))
  } catch {
    return unread("the holding's entities")
  }
}

/** The holding's feed. One per holding; the newest wins if older data holds several. */
async function currentFeed(admin: any, fundId: string, companyId: string): Promise<{ feed: any } | { failed: true }> {
  const { data, error } = await admin.from('price_feeds').select('*').eq('fund_id', fundId).eq('company_id', companyId)
    .order('created_at', { ascending: false }).limit(1)
  if (error) return { failed: true }
  return { feed: ((data as any[]) ?? [])[0] ?? null }
}

/** A stored feed row in the body's own field names, so omitted fields keep their stored values. */
function storedAsBody(f: any) {
  return {
    kind: f.kind, symbol: f.symbol, exchange: f.exchange, chain: f.chain, contractAddress: f.contract_address,
    quoteCurrency: f.quote_currency, quoteScale: f.quote_scale, provider: f.provider, activeFrom: f.active_from,
    activeUntil: f.active_until, restrictionUntil: f.restriction_until, restrictionDiscount: f.restriction_discount,
    notes: f.notes,
  }
}

/** The columns a `set` writes, or why the body cannot be a feed. */
function feedFields(body: any, holdingType: string): { row: Record<string, unknown> } | { error: string } {
  const kind = KINDS.includes(body?.kind) ? body.kind : holdingType === 'crypto' ? 'digital_asset' : 'listed_equity'
  const symbol = typeof body?.symbol === 'string' ? body.symbol.trim() : ''
  if (!symbol) return { error: 'symbol is required.' }
  if (!body?.activeFrom) {
    return { error: "activeFrom is required — the date the feed starts pricing this holding (a listing date, or the purchase date). Periods before it mark from the holding's rounds." }
  }
  for (const f of ['activeFrom', 'activeUntil', 'restrictionUntil'] as const) {
    if (body[f] && !isRealDate(body[f])) return { error: `${f} must be a real date written YYYY-MM-DD.` }
  }
  if (body.activeUntil && body.activeUntil < body.activeFrom) return { error: 'activeUntil cannot be before activeFrom.' }
  if (body.restrictionUntil && body.restrictionUntil < body.activeFrom) return { error: 'restrictionUntil cannot be before activeFrom.' }
  for (const f of ['exchange', 'chain', 'contractAddress', 'notes', 'provider'] as const) {
    if (body[f] != null && typeof body[f] !== 'string') return { error: `${f} must be text.` }
  }
  const discount = body.restrictionDiscount == null || body.restrictionDiscount === '' ? null : Number(body.restrictionDiscount)
  if (discount != null && (!Number.isFinite(discount) || discount < 0 || discount >= 1)) {
    return { error: 'restrictionDiscount is a fraction between 0 and 1 (0.2 = a 20% discount for lack of marketability).' }
  }
  // A discount with no end date would apply forever, holding the position at Level 2 long after
  // the lock-up expired.
  if (discount != null && discount > 0 && !body.restrictionUntil) {
    return { error: 'A restrictionDiscount needs a restrictionUntil date — otherwise the discount never lapses.' }
  }
  const scale = body.quoteScale == null || body.quoteScale === '' ? 1 : Number(body.quoteScale)
  if (!Number.isFinite(scale) || scale <= 0) return { error: 'quoteScale must be positive — 100 for a GBp (pence) listing, 1 otherwise.' }
  // An invalid stored currency makes formatSharePrice throw and crash the holding page.
  const rawCurrency = typeof body.quoteCurrency === 'string' ? body.quoteCurrency.trim() : ''
  const currency = rawCurrency ? rawCurrency.toUpperCase() : 'USD'
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'quoteCurrency must be a 3-letter currency code, such as USD.' }
  return {
    row: {
      kind,
      symbol,
      exchange: body.exchange || null,
      chain: body.chain || null,
      contract_address: body.contractAddress || null,
      quote_currency: currency,
      quote_scale: scale,
      provider: PROVIDER_NAMES.includes(body.provider) ? body.provider : 'manual',
      active_from: body.activeFrom,
      active_until: body.activeUntil || null,
      restriction_until: body.restrictionUntil || null,
      restriction_discount: discount,
      notes: body.notes ?? null,
    },
  }
}

// GET — the feed, its recent quotes, and the mark each of the caller's entities owes at ?asOf=.
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const ctx = await holdingForRequest(admin, gate, id)
  if (ctx instanceof NextResponse) return ctx

  const asOf = req.nextUrl.searchParams.get('asOf') || today()
  if (!isRealDate(asOf)) return bad('asOf must be a real date written YYYY-MM-DD.')
  const found = await currentFeed(admin, gate.fundId, id)
  if ('failed' in found) return unread('the price feed')
  const feed = found.feed
  let quotes: any[] = []
  if (feed) {
    const { data, error } = await (admin as any).from('price_observations').select('*').eq('fund_id', gate.fundId).eq('feed_id', feed.id)
      .order('as_of_date', { ascending: false }).limit(10)
    if (error) return unread('the recorded quotes')
    quotes = data ?? []
  }
  // One feed prices the holding for every entity; the mark is per entity, because each entity's
  // ledger carries its own units at its own value.
  const marks = feed
    ? await Promise.all(ctx.entities.map(async e => ({
        vehicleId: e.id, entity: e.name, ...(await quoteMarkForHolding(admin, gate.fundId, id, e.name, asOf)),
      })))
    : []
  const canEdit = await canEditFeed(admin, gate.fundId, id, ctx)
  if (canEdit instanceof NextResponse) return canEdit
  return NextResponse.json({ asOf, feed, quotes, marks, entities: ctx.entities, providers: PROVIDER_NAMES, canEditFeed: canEdit })
}

// POST — { action: 'set' | 'record-quote' | 'book', … }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const ctx = await holdingForRequest(admin, gate, id)
  if (ctx instanceof NextResponse) return ctx

  const body = await req.json().catch(() => ({}))

  // Book needs no feed row here; bookQuoteMark reads it and explains its absence.
  if (body?.action === 'book') {
    const group = await resolveGroupOr400(admin, gate, body.group ?? null)
    if (group instanceof NextResponse) return group
    if (!ctx.entities.some(e => e.name === group)) {
      return NextResponse.json({ error: 'That entity does not hold this asset.' }, { status: 404 })
    }
    const asOf = body.asOf == null || body.asOf === '' ? today() : body.asOf
    if (!isRealDate(asOf)) return bad('asOf must be a real date written YYYY-MM-DD.')
    if (asOf > today()) return bad('A mark cannot be booked for a date in the future.')
    const result = await bookQuoteMark(admin, gate.fundId, user.id, id, group, asOf)
    if (!result.booked) return bad(result.reason)
    logActivity(admin, gate.fundId, user.id, 'price_quote.book_mark', { companyId: id, group, asOf, transactionId: result.transactionId })
    return NextResponse.json(result)
  }

  const found = await currentFeed(admin, gate.fundId, id)
  if ('failed' in found) return unread('the price feed')
  const feed = found.feed

  if (body?.action === 'record-quote' || body?.action === 'set') {
    const ok = await canEditFeed(admin, gate.fundId, id, ctx)
    if (ok instanceof NextResponse) return ok
    if (!ok) return NextResponse.json({ error: SHARED_FEED }, { status: 403 })
  }

  if (body?.action === 'record-quote') {
    if (!feed) return bad('Set a price feed for this holding first.')
    const price = Number(body.price)
    const basis = body.basis ?? 'close'
    if (!body.asOfDate) return bad('asOfDate is required.')
    if (!isRealDate(body.asOfDate)) return bad('asOfDate must be a real date written YYYY-MM-DD.')
    if (body.asOfDate > today()) return bad('A quote cannot be recorded for a date in the future.')
    if (!Number.isFinite(price) || price < 0) return bad('price must be a non-negative number.')
    if (!BASES.includes(basis)) return bad(`basis must be one of: ${BASES.join(', ')}`)
    // Upsert on (feed_id, as_of_date): a corrected price replaces the one it corrects.
    const { data: observation, error } = await (admin as any)
      .from('price_observations')
      .upsert({
        fund_id: gate.fundId, feed_id: feed.id, as_of_date: body.asOfDate, price, basis,
        source: 'manual', created_by: user.id,
      }, { onConflict: 'feed_id,as_of_date' })
      .select('*').single()
    if (error) return dbError(error, 'holding-price-feed-record-quote')
    logActivity(admin, gate.fundId, user.id, 'price_quote.record', { feedId: feed.id, symbol: feed.symbol, asOfDate: body.asOfDate, price })
    return NextResponse.json({ observation })
  }

  if (body?.action !== 'set') return bad("action must be 'set', 'record-quote' or 'book'.")
  const merged = feed ? { ...storedAsBody(feed), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } : body
  const fields = feedFields(merged, ctx.holding.holding_type)
  if ('error' in fields) return bad(fields.error)
  const write = feed
    ? (admin as any).from('price_feeds').update(fields.row).eq('id', feed.id).eq('fund_id', gate.fundId)
    : (admin as any).from('price_feeds').insert({ ...fields.row, fund_id: gate.fundId, company_id: id, created_by: user.id })
  const { data: saved, error } = await write.select('*').single()
  if (error) return dbError(error, 'holding-price-feed-set')
  logActivity(admin, gate.fundId, user.id, 'price_feed.set', { companyId: id, symbol: fields.row.symbol })
  return NextResponse.json({ feed: saved })
}

// DELETE — stop pricing this holding from a feed. Its quotes cascade; it marks from its rounds again.
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const ctx = await holdingForRequest(admin, gate, id)
  if (ctx instanceof NextResponse) return ctx

  const ok = await canEditFeed(admin, gate.fundId, id, ctx)
  if (ok instanceof NextResponse) return ok
  if (!ok) return NextResponse.json({ error: SHARED_FEED }, { status: 403 })
  const { error } = await (admin as any).from('price_feeds').delete().eq('fund_id', gate.fundId).eq('company_id', id)
  if (error) return dbError(error, 'holding-price-feed-delete')
  logActivity(admin, gate.fundId, user.id, 'price_feed.delete', { companyId: id })
  return NextResponse.json({ ok: true })
}
