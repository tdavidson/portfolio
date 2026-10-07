import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { buildSoiPositions, type SoiCompany } from '@/lib/accounting/soi'
import {
  walletVariances, type Wallet, type WalletBalance,
} from '@/lib/portfolio/wallets'
import { HAS_CHAIN_PROVIDER } from '@/lib/portfolio/balance-providers'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { groupWriteDenial } from '@/lib/access/scope'

/**
 * Watched wallets — the public addresses a digital-asset holding is held in — and the balances
 * read from them.
 *
 * A balance read here NEVER becomes the position's carrying quantity. The books' quantity comes
 * from recorded transactions; this is the chain's independent answer, and the value of having
 * two answers is entirely in being able to compare them. Overwriting one with the other would
 * collapse them into a single source and throw the check away.
 */

const METHODS = ['signed_message', 'test_transaction', 'custodian_statement']

// GET — every wallet, its latest reading, and how that compares with the books.
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

  const [{ data: walletRows, error }, { data: balRows }, { data: txnRows }, { data: companyRows }] =
    await Promise.all([
      (admin as any).from('crypto_wallets').select('*').eq('fund_id', gate.fundId).order('chain'),
      (admin as any).from('crypto_wallet_balances').select('*').eq('fund_id', gate.fundId)
        .lte('as_of_date', asOf).order('as_of_date', { ascending: false }),
      (admin as any).from('investment_transactions').select('*').eq('fund_id', gate.fundId),
      (admin as any).from('companies').select('*').eq('fund_id', gate.fundId),
    ])
  if (error) return dbError(error, 'crypto-wallets-get')

  const wallets: Wallet[] = ((walletRows as any[]) ?? []).map(w => ({
    id: w.id, companyId: w.company_id, chain: w.chain, address: w.address, label: w.label,
    active: w.active !== false, verifiedAt: w.verified_at, verificationMethod: w.verification_method,
  }))
  const balances: WalletBalance[] = ((balRows as any[]) ?? []).map(b => ({
    walletId: b.wallet_id, asOfDate: b.as_of_date, units: Number(b.units), blockHeight: b.block_height,
  }))

  const latest = new Map<string, WalletBalance>()
  for (const b of balances) if (!latest.has(b.walletId)) latest.set(b.walletId, b)

  // Split-adjusted units through the same roll-up the schedule of investments reads, so the
  // number shown against the chain is the number the statements report.
  const upTo = ((txnRows as any[]) ?? []).filter(t => !t.transaction_date || t.transaction_date <= asOf)
  const soi = buildSoiPositions(upTo, ((companyRows as any[]) ?? []) as SoiCompany[], group, new Date(asOf))
  const positions = soi.map(p => ({ companyId: p.companyId, name: p.name, units: p.shares ?? 0 }))

  return NextResponse.json({
    asOf,
    wallets: ((walletRows as any[]) ?? []).map(w => ({
      ...w,
      latestBalance: latest.get(w.id) ?? null,
      holdingName: positions.find(p => p.companyId === w.company_id)?.name ?? null,
    })),
    variances: walletVariances(positions, wallets, balances, asOf),
    // False until a chain adapter is registered — balances are read by hand today.
    canFetch: HAS_CHAIN_PROVIDER,
  })
}

// POST
//   { action: 'add', companyId, chain, address, label?, portfolioGroup? }
//   { action: 'record-balance', walletId, asOfDate, units, blockHeight? }
//   { action: 'verify', walletId, method, note? }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  // A wallet sits in one entity; a member touches only wallets in theirs.
  const scope = await loadEntityScope(admin, gate)

  /** The wallet must belong to the CALLER'S fund — fund_id comes from the membership lookup and
   *  never from the body, so a foreign id has to be rejected rather than silently scoped away. */
  const ownWallet = async (id: string) => {
    const { data } = await (admin as any)
      .from('crypto_wallets').select('id, fund_id, chain, address, portfolio_group').eq('id', id).maybeSingle()
    return data && data.fund_id === gate.fundId && !groupWriteDenial(scope.vehicleNames, data.portfolio_group) ? data : null
  }

  if (body?.action === 'record-balance') {
    const wallet = await ownWallet(body.walletId)
    if (!wallet) return NextResponse.json({ error: 'Wallet not found.' }, { status: 404 })

    const units = Number(body.units)
    if (!Number.isFinite(units) || units < 0) {
      return NextResponse.json({ error: 'units must be a non-negative number.' }, { status: 400 })
    }
    if (!body.asOfDate) {
      return NextResponse.json({ error: 'asOfDate is required — the date this balance describes.' }, { status: 400 })
    }
    // A reading dated ahead of today cannot describe a block that exists.
    if (body.asOfDate > new Date().toISOString().slice(0, 10)) {
      return NextResponse.json({ error: 'That date is in the future — a balance cannot describe a block that has not been produced.' }, { status: 400 })
    }

    const { data, error } = await (admin as any)
      .from('crypto_wallet_balances')
      .upsert({
        fund_id: gate.fundId,
        wallet_id: body.walletId,
        as_of_date: body.asOfDate,
        units,
        block_height: body.blockHeight ?? null,
        source: 'manual',
        created_by: user.id,
      }, { onConflict: 'wallet_id,as_of_date' })
      .select('*').single()
    if (error) return dbError(error, 'crypto-wallets-record-balance')

    logActivity(admin, gate.fundId, user.id, 'crypto_wallet.record_balance', {
      walletId: body.walletId, asOfDate: body.asOfDate, units,
    })
    return NextResponse.json({ balance: data })
  }

  if (body?.action === 'verify') {
    const wallet = await ownWallet(body.walletId)
    if (!wallet) return NextResponse.json({ error: 'Wallet not found.' }, { status: 404 })
    if (!METHODS.includes(body.method)) {
      return NextResponse.json({ error: `method must be one of: ${METHODS.join(', ')}` }, { status: 400 })
    }

    const { error } = await (admin as any)
      .from('crypto_wallets')
      .update({
        verified_at: new Date().toISOString(),
        verification_method: body.method,
        verification_note: body.note ?? null,
      })
      .eq('id', body.walletId).eq('fund_id', gate.fundId)
    if (error) return dbError(error, 'crypto-wallets-verify')

    logActivity(admin, gate.fundId, user.id, 'crypto_wallet.verify', {
      walletId: body.walletId, method: body.method,
    })
    return NextResponse.json({ ok: true })
  }

  // --- add (the default action) ---
  const { companyId, chain, address } = body
  if (!companyId) return NextResponse.json({ error: 'companyId is required.' }, { status: 400 })
  if (!chain) return NextResponse.json({ error: 'chain is required.' }, { status: 400 })
  if (!address || typeof address !== 'string' || !address.trim()) {
    return NextResponse.json({ error: 'address is required.' }, { status: 400 })
  }

  const { data: company } = await admin
    .from('companies').select('id, fund_id, holding_type').eq('id', companyId).maybeSingle()
  if (!company || (company as any).fund_id !== gate.fundId
    || (scope.companyIds !== null && !scope.companyIds.includes(companyId))) {
    return NextResponse.json({ error: 'Holding not found.' }, { status: 404 })
  }
  const groupDenied = groupWriteDenial(scope.vehicleNames, body.portfolioGroup)
  if (groupDenied) return NextResponse.json({ error: groupDenied }, { status: 403 })

  const { data: wallet, error } = await (admin as any)
    .from('crypto_wallets')
    .insert({
      fund_id: gate.fundId,
      company_id: companyId,
      chain: String(chain).trim().toLowerCase(),
      address: address.trim(),
      label: body.label ?? null,
      portfolio_group: body.portfolioGroup ?? null,
      created_by: user.id,
    })
    .select('*').single()
  if (error) {
    // The unique index is the guard against watching one address twice, which would double the
    // balance into the position. Say that, rather than surfacing a constraint name.
    if ((error as any).code === '23505') {
      return NextResponse.json(
        { error: 'That address is already watched on this chain — watching it twice would double-count its balance.' },
        { status: 400 },
      )
    }
    return dbError(error, 'crypto-wallets-add')
  }

  logActivity(admin, gate.fundId, user.id, 'crypto_wallet.add', { companyId, chain, address })

  // Attaching a wallet to a holding that is not marked as a digital asset is ALLOWED but worth
  // saying: the schedule of investments sections by holding_type, so a token left as a company
  // is reported under "Direct investments" with its industry, stage and country blank. Returned
  // as a warning rather than an error because the holding may predate the discriminator, and
  // refusing the wallet would not fix the classification either way.
  const warning = (company as any).holding_type !== 'crypto'
    ? 'This holding is not marked as a digital asset, so the schedule of investments will report it '
      + 'as a company — with its industry, stage and country blank. Set its holding type to crypto.'
    : null

  return NextResponse.json({ wallet, warning })
}

// DELETE — stop watching an address (?id=). Its readings cascade.
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required.' }, { status: 400 })

  // Only a wallet in one of the caller's entities.
  const deleteScope = await loadEntityScope(admin, gate)
  const { data: target } = await (admin as any).from('crypto_wallets').select('portfolio_group').eq('id', id).eq('fund_id', gate.fundId).maybeSingle()
  if (!target || groupWriteDenial(deleteScope.vehicleNames, (target as any).portfolio_group)) {
    return NextResponse.json({ error: 'Wallet not found.' }, { status: 404 })
  }
  const { error } = await (admin as any)
    .from('crypto_wallets').delete().eq('id', id).eq('fund_id', gate.fundId)
  if (error) return dbError(error, 'crypto-wallets-delete')

  logActivity(admin, gate.fundId, user.id, 'crypto_wallet.delete', { walletId: id })
  return NextResponse.json({ ok: true })
}
