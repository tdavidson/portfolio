import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain, investments feature (lib/access/route-domains.ts). The holding is scoped by
// holdingForRequest; each wallet belongs to one entity and is shown only to that entity's members.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { buildSoiPositions } from '@/lib/accounting/soi'
import { holdingForRequest, isRealDate, type HoldingContext } from '@/lib/portfolio/holding-route'
import { holdingEntities, holdersFromTransactions, walletEntity, walletsForEntity } from '@/lib/portfolio/holding-entities'
import { walletVariances, walletFromRow, balanceFromRow } from '@/lib/portfolio/wallets'
import { HAS_CHAIN_PROVIDER } from '@/lib/portfolio/balance-providers'

/**
 * The public addresses a digital asset is held in, on the holding's own page
 * (plans/spec-ledger-one-writer.md §6). A reading here NEVER becomes the carrying quantity — the
 * books' quantity comes from recorded transactions, and the point of a second answer is the
 * comparison (lib/portfolio/wallets.ts).
 */

const METHODS = ['signed_message', 'test_transaction', 'custodian_statement']
const today = () => new Date().toISOString().slice(0, 10)
const bad = (error: string) => NextResponse.json({ error }, { status: 400 })
const notFound = () => NextResponse.json({ error: 'Wallet not found.' }, { status: 404 })
const unread = (what: string) => NextResponse.json({ error: `Could not read ${what}.` }, { status: 500 })

/** Every investment transaction of the holding in the FULL fund — never filtered to the caller. */
async function holdingTxns(admin: any, fundId: string, companyId: string): Promise<any[] | null> {
  const { data, error } = await admin.from('investment_transactions').select('*').eq('fund_id', fundId).eq('company_id', companyId)
  return error ? null : ((data as any[]) ?? [])
}

/**
 * Whether the caller may act on a wallet. A tagged (or single-holder) wallet belongs to one entity:
 * the caller needs to see it. An untagged wallet on a holding two or more entities hold belongs to
 * none of them, so only a caller who sees every entity of the holding may act on it.
 * `null` = the comparison could not be read.
 */
async function walletVisibility(
  admin: any, fundId: string, companyId: string, ctx: HoldingContext, holders: Map<string, string[]>,
): Promise<((w: any) => boolean) | null> {
  const names = ctx.scope.vehicleNames
  let seesEvery = names === null || ctx.scope.access.vehicles.all
  if (!seesEvery) {
    try {
      const all = await holdingEntities(admin, fundId, companyId, { vehicles: { all: true, ids: [] } })
      seesEvery = all.every(e => ctx.entities.some(c => c.id === e.id))
        // Linked entities and holders can differ (aliases, group strings that resolve to no entity).
        && (holders.get(companyId) ?? []).every(h => (names ?? []).includes(h))
    } catch {
      return null
    }
  }
  return w => {
    if (names === null) return true
    const e = walletEntity(w, holders)
    return e === null ? seesEvery : names.includes(e)
  }
}

/** A wallet on this holding the caller may act on: `{ wallet }`, `{ wallet: null }`, or a 500. */
async function visibleWallet(
  admin: any, gate: { fundId: string }, companyId: string, ctx: HoldingContext, walletId: unknown,
): Promise<{ wallet: any } | NextResponse> {
  if (typeof walletId !== 'string' || !walletId) return { wallet: null }
  const { data, error } = await admin.from('crypto_wallets').select('*')
    .eq('id', walletId).eq('fund_id', gate.fundId).eq('company_id', companyId).maybeSingle()
  if (error) return unread('the wallet')
  if (!data) return { wallet: null }
  const txns = await holdingTxns(admin, gate.fundId, companyId)
  if (!txns) return unread("the holding's transactions")
  const visible = await walletVisibility(admin, gate.fundId, companyId, ctx, holdersFromTransactions(txns))
  if (!visible) return unread("the holding's entities")
  return { wallet: visible(data) ? data : null }
}

// GET — the caller's entities' wallets, each with its latest reading, and the chain against the
// books per entity.
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
  const [wallets, txns] = await Promise.all([
    (admin as any).from('crypto_wallets').select('*').eq('fund_id', gate.fundId).eq('company_id', id).order('chain'),
    holdingTxns(admin, gate.fundId, id),
  ])
  if (wallets.error) return unread('the wallets')
  if (!txns) return unread("the holding's transactions")

  const holders = holdersFromTransactions(txns)
  const visible = await walletVisibility(admin, gate.fundId, id, ctx, holders)
  if (!visible) return unread("the holding's entities")
  const rows = ((wallets.data as any[]) ?? []).filter(visible)
  // Only the visible wallets' readings: a fund-wide read would hit the API row cap and silently
  // drop a holding's latest reading.
  let mineBalances: any[] = []
  if (rows.length > 0) {
    const balances = await (admin as any).from('crypto_wallet_balances').select('*').eq('fund_id', gate.fundId)
      .in('wallet_id', rows.map(w => w.id as string)).lte('as_of_date', asOf).order('as_of_date', { ascending: false })
    if (balances.error) return unread('the wallet balances')
    mineBalances = (balances.data as any[]) ?? []
  }
  const latest = new Map<string, any>()
  for (const b of mineBalances) if (!latest.has(b.wallet_id)) latest.set(b.wallet_id, b)
  const balanceModels = mineBalances.map(balanceFromRow)

  // Per entity: its units (split-adjusted, through the schedule's own roll-up) against the
  // wallets that speak for it.
  const upTo = txns.filter(t => !t.transaction_date || t.transaction_date <= asOf)
  const variances = ctx.entities.flatMap(e => {
    const units = buildSoiPositions(upTo, [ctx.holding], e.name, new Date(asOf))[0]?.shares ?? 0
    const forEntity = walletsForEntity(rows, e.name, holders).map(walletFromRow)
    return walletVariances([{ companyId: id, name: ctx.holding.name, units }], forEntity, balanceModels, asOf)
      .map(v => ({ ...v, vehicleId: e.id, entity: e.name }))
  })

  return NextResponse.json({
    asOf,
    wallets: rows.map(w => ({ ...w, entity: walletEntity(w, holders), latestBalance: latest.get(w.id) ?? null })),
    variances,
    entities: ctx.entities,
    // False until a chain adapter is registered — balances are read by hand today.
    canFetch: HAS_CHAIN_PROVIDER,
  })
}

// POST — { action: 'add' | 'record-balance' | 'verify', … }
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

  if (body?.action === 'record-balance') {
    const found = await visibleWallet(admin, gate, id, ctx, body.walletId)
    if (found instanceof NextResponse) return found
    const wallet = found.wallet
    if (!wallet) return notFound()
    const units = body.units == null || body.units === '' ? NaN : Number(body.units)
    if (!Number.isFinite(units) || units < 0) return bad('units must be a non-negative number.')
    if (!body.asOfDate) return bad('asOfDate is required — the date this balance describes.')
    if (!isRealDate(body.asOfDate)) return bad('asOfDate must be a real date written YYYY-MM-DD.')
    if (body.asOfDate > today()) return bad('That date is in the future — a balance cannot describe a block that has not been produced.')
    const height = body.blockHeight == null || body.blockHeight === '' ? null : Number(body.blockHeight)
    if (height !== null && (!Number.isInteger(height) || height < 0)) return bad('blockHeight must be a whole, non-negative number.')
    const { data: balance, error } = await (admin as any)
      .from('crypto_wallet_balances')
      .upsert({
        fund_id: gate.fundId, wallet_id: wallet.id, as_of_date: body.asOfDate, units,
        block_height: height, source: 'manual', created_by: user.id,
      }, { onConflict: 'wallet_id,as_of_date' })
      .select('*').single()
    if (error) return dbError(error, 'holding-wallets-record-balance')
    logActivity(admin, gate.fundId, user.id, 'crypto_wallet.record_balance', { walletId: wallet.id, asOfDate: body.asOfDate, units })
    return NextResponse.json({ balance })
  }

  if (body?.action === 'verify') {
    const found = await visibleWallet(admin, gate, id, ctx, body.walletId)
    if (found instanceof NextResponse) return found
    const wallet = found.wallet
    if (!wallet) return notFound()
    if (!METHODS.includes(body.method)) return bad(`method must be one of: ${METHODS.join(', ')}`)
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 1000)) return bad('note must be text of at most 1000 characters.')
    const { error } = await (admin as any).from('crypto_wallets')
      .update({ verified_at: new Date().toISOString(), verification_method: body.method, verification_note: body.note ?? null })
      .eq('id', wallet.id).eq('fund_id', gate.fundId)
    if (error) return dbError(error, 'holding-wallets-verify')
    logActivity(admin, gate.fundId, user.id, 'crypto_wallet.verify', { walletId: wallet.id, method: body.method })
    return NextResponse.json({ ok: true })
  }

  if (body?.action !== 'add') return bad("action must be 'add', 'record-balance' or 'verify'.")
  // A wallet belongs to one entity: the one whose position it holds, and one the caller sees
  // (ctx.entities is already narrowed to the caller's entities).
  const entity = ctx.entities.find(e => e.id === body.vehicleId)
  if (!entity) return bad('Pick one of your entities that holds this asset.')
  const chain = typeof body.chain === 'string' ? body.chain.trim().toLowerCase() : ''
  const address = typeof body.address === 'string' ? body.address.trim() : ''
  if (!chain) return bad('chain is required.')
  if (chain.length > 40) return bad('chain must be at most 40 characters.')
  if (!address) return bad('address is required.')
  if (address.length > 200) return bad('address must be at most 200 characters.')
  if (body.label != null && typeof body.label !== 'string') return bad('label must be text.')
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (label.length > 200) return bad('label must be at most 200 characters.')

  const { data: wallet, error } = await (admin as any)
    .from('crypto_wallets')
    .insert({
      fund_id: gate.fundId,
      company_id: id,
      chain,
      address,
      label: label || null,
      portfolio_group: entity.name,
      created_by: user.id,
    })
    .select('*').single()
  if (error) {
    // The unique index guards against watching one address twice, which would double its balance.
    if ((error as any).code === '23505') {
      return bad('That address is already watched on this chain — watching it twice would double-count its balance.')
    }
    return dbError(error, 'holding-wallets-add')
  }
  logActivity(admin, gate.fundId, user.id, 'crypto_wallet.add', { companyId: id, chain: wallet.chain, address: wallet.address })
  return NextResponse.json({ wallet })
}

// DELETE ?walletId= — stop watching an address. Its readings cascade.
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const ctx = await holdingForRequest(admin, gate, id)
  if (ctx instanceof NextResponse) return ctx

  const walletId = req.nextUrl.searchParams.get('walletId')
  if (!walletId) return bad('walletId is required.')
  const found = await visibleWallet(admin, gate, id, ctx, walletId)
  if (found instanceof NextResponse) return found
  if (!found.wallet) return notFound()
  const { error } = await (admin as any).from('crypto_wallets').delete().eq('id', walletId).eq('fund_id', gate.fundId)
  if (error) return dbError(error, 'holding-wallets-delete')
  logActivity(admin, gate.fundId, user.id, 'crypto_wallet.delete', { walletId })
  return NextResponse.json({ ok: true })
}
