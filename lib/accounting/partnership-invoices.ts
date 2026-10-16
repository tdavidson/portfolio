// Quarterly partnership-expense invoices: the management company (or whichever entity paid) bills
// a fund for the fund's expenses it paid during the quarter.
//
// THE FLOW, which is how the books are kept by hand.
//   1. When the management company pays a fund's expense it books it to the fund's receivable:
//        Dr Due from <fund> (1900-<fund>)   Cr Cash (or the card)
//      from the bank feed, a typed entry, or a draft made from the receipt (receipts.ts). The
//      receipt is attached to that entry. Nothing else marks it: the account IS the tag.
//   2. `previewPartnershipInvoice` lists every POSTED debit to that account in the quarter that no
//      live invoice has billed yet (receipts-core.ts, billablePostings). Drafts are listed
//      separately as a warning, never billed: a draft is not yet a cost.
//   3. `createPartnershipInvoice` freezes those postings and the total into a DRAFT invoice
//      (partnership_invoice_lines), so the same expense cannot land on two invoices.
//   4. `issuePartnershipInvoice` books the FUND's side only, as an intercompany expense
//      reimbursement whose receivable is already on the manco's books:
//        the fund   Dr Partnership expenses   Cr Due to <manco>
//      When the fund pays, the charge's settlement (the manco's Intercompany tab) posts the cash on
//      both sides and clears the receivable: manco Dr Cash / Cr Due from <fund>.
//   5. `voidPartnershipInvoice` releases the lines for the next invoice. An issued invoice's fund
//      entry has to be voided first (a void here never silently unposts the other side's books).
//
// The invoice row is the document; the ledger is the fact. The amount on the row never moves after
// creation, the same way a capital call notice keeps the number the partner was told.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { postIntercompanyCharge } from './intercompany'
import { vehicleNameById } from './vehicle-id'
import { ACTUAL_BOOK } from './books'
import { INTERCOMPANY_RECEIVABLE_CODE, intercompanyCode } from './chart'
import { billablePostings, invoiceNumber, quarterBounds, type Quarter } from './receipts-core'

export interface InvoiceLine {
  entryId: string
  postingId: string
  entryDate: string
  memo: string | null
  reference: string | null
  vendorName: string | null
  amount: number
  receiptCount: number
  status: string
}

/** A line of an existing invoice, with what its posting says NOW (null when the posting is gone). */
export interface InvoiceDetailLine extends InvoiceLine {
  currentAmount: number | null
}

export interface InvoicePreview {
  quarter: Quarter
  from: { vehicleId: string; name: string }
  to: { vehicleId: string; name: string }
  lines: InvoiceLine[]
  total: number
  /** Debits to the Due-from account still in draft: not billed until posted. */
  drafts: InvoiceLine[]
  /** False when the biller's chart has no "Due from <fund>" account yet, so nothing can be billed. */
  hasReceivableAccount: boolean
  /** An invoice already covering this quarter, if one exists. */
  existing: { id: string; invoiceNumber: string; status: string; amount: number } | null
}

async function vehiclePair(admin: SupabaseClient, fundId: string, fromId: string, toId: string) {
  const [fromName, toName] = await Promise.all([vehicleNameById(admin, fundId, fromId), vehicleNameById(admin, fundId, toId)])
  if (!fromName || !toName) return null
  return { from: { vehicleId: fromId, name: fromName }, to: { vehicleId: toId, name: toName } }
}

/** The biller's "Due from <fund>" account, if its chart has one. */
export async function receivableAccountId(admin: SupabaseClient, fundId: string, fromVehicleId: string, toVehicleId: string): Promise<string | null> {
  const { data } = await admin.from('chart_of_accounts' as any).select('id')
    .eq('fund_id', fundId).eq('vehicle_id', fromVehicleId)
    .eq('code', intercompanyCode(INTERCOMPANY_RECEIVABLE_CODE, toVehicleId)).maybeSingle()
  return (data as any)?.id ?? null
}

interface EntryRow {
  id: string; entry_date: string; memo: string | null; reference: string | null; status: string
  vendor_id: string | null; source_type: string | null
  journal_postings: { id: string; amount: number; account_id: string }[]
}

/** Entries on the biller's books with a posting to any of these accounts (only those postings). */
async function entriesTouching(
  admin: SupabaseClient, fundId: string, fromVehicleId: string, accountIds: string[],
  opts: { window?: { start: string; end: string } | null; statuses: string[] },
): Promise<EntryRow[]> {
  if (accountIds.length === 0) return []
  let q = admin.from('journal_entries' as any)
    .select('id, entry_date, memo, reference, status, vendor_id, source_type, journal_postings!inner(id, amount, account_id)')
    .eq('fund_id', fundId).eq('vehicle_id', fromVehicleId).eq('book', ACTUAL_BOOK)
    .in('status', opts.statuses)
    .in('journal_postings.account_id', accountIds)
  if (opts.window) q = q.gte('entry_date', opts.window.start).lte('entry_date', opts.window.end)
  const { data, error } = await q.order('entry_date', { ascending: true }).limit(5000)
  if (error) throw new Error(`The Due-from entries could not be read: ${error.message}`)
  return ((data as any[]) ?? []).map(e => ({ ...e, journal_postings: ((e.journal_postings as any[]) ?? []).map(p => ({ ...p, amount: Number(p.amount) })) }))
}

/** Of these postings, the ones a live invoice already bills. */
async function billedPostingIds(admin: SupabaseClient, fundId: string, postingIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < postingIds.length; i += 150) {
    const { data } = await admin.from('partnership_invoice_lines' as any).select('journal_posting_id')
      .eq('fund_id', fundId).eq('active', true).in('journal_posting_id', postingIds.slice(i, i + 150))
    for (const r of ((data as any[]) ?? [])) out.add(r.journal_posting_id as string)
  }
  return out
}

/** Vendor names and receipt counts for a set of entries: what a line shows beside its amount. */
async function lineDetails(admin: SupabaseClient, fundId: string, entries: EntryRow[]) {
  const ids = entries.map(e => e.id)
  const vendorIds = Array.from(new Set(entries.map(e => e.vendor_id).filter(Boolean))) as string[]
  const [{ data: vendors }, { data: receipts }] = await Promise.all([
    vendorIds.length ? admin.from('vendors' as any).select('id, name').eq('fund_id', fundId).in('id', vendorIds) : Promise.resolve({ data: [] }),
    ids.length ? admin.from('receipts' as any).select('journal_entry_id').eq('fund_id', fundId).neq('status', 'dismissed').in('journal_entry_id', ids) : Promise.resolve({ data: [] }),
  ])
  const vendorName = new Map(((vendors as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const receiptCount = new Map<string, number>()
  for (const r of ((receipts as any[]) ?? [])) receiptCount.set(r.journal_entry_id, (receiptCount.get(r.journal_entry_id) ?? 0) + 1)
  return (e: EntryRow, postingId: string, amount: number): InvoiceLine => ({
    entryId: e.id, postingId,
    entryDate: e.entry_date,
    memo: e.memo ?? null,
    reference: e.reference ?? null,
    vendorName: e.vendor_id ? vendorName.get(e.vendor_id) ?? null : null,
    amount,
    receiptCount: receiptCount.get(e.id) ?? 0,
    status: e.status,
  })
}

/** The unbilled Due-from debits in the window, posted and draft. */
async function openLines(
  admin: SupabaseClient, fundId: string, fromVehicleId: string, receivableId: string, window: { start: string; end: string } | null,
): Promise<InvoiceLine[]> {
  const entries = await entriesTouching(admin, fundId, fromVehicleId, [receivableId], { window, statuses: ['draft', 'posted'] })
  const billed = await billedPostingIds(admin, fundId, entries.flatMap(e => e.journal_postings.map(p => p.id)))
  const picked = billablePostings(
    entries.map(e => ({ id: e.id, sourceType: e.source_type, postings: e.journal_postings.map(p => ({ id: p.id, accountId: p.account_id, amount: p.amount })) })),
    receivableId, billed,
  )
  const byId = new Map(entries.map(e => [e.id, e]))
  const line = await lineDetails(admin, fundId, entries)
  return picked.map(p => line(byId.get(p.entryId)!, p.postingId, p.amount))
}

async function existingInvoice(admin: SupabaseClient, fundId: string, fromId: string, toId: string, q: Quarter) {
  const { data } = await admin.from('partnership_invoices' as any)
    .select('id, invoice_number, status, amount')
    .eq('fund_id', fundId).eq('from_vehicle_id', fromId).eq('to_vehicle_id', toId)
    .eq('period_start', q.start).eq('period_end', q.end).neq('status', 'void').maybeSingle()
  return data ? { id: (data as any).id, invoiceNumber: (data as any).invoice_number, status: (data as any).status, amount: Number((data as any).amount) } : null
}

/** What an invoice for this quarter would bill, without writing anything. */
export async function previewPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  args: { fromVehicleId: string; toVehicleId: string; year: number; quarter: number },
): Promise<InvoicePreview | { error: string }> {
  let q: Quarter
  try { q = quarterBounds(args.year, args.quarter) } catch (e) { return { error: (e as Error).message } }
  const pair = await vehiclePair(admin, fundId, args.fromVehicleId, args.toVehicleId)
  if (!pair) return { error: 'Both entities must be in this fund.' }
  if (args.fromVehicleId === args.toVehicleId) return { error: 'An entity cannot bill itself.' }
  const receivableId = await receivableAccountId(admin, fundId, args.fromVehicleId, args.toVehicleId)
  const all = receivableId ? await openLines(admin, fundId, args.fromVehicleId, receivableId, q) : []
  const lines = all.filter(l => l.status === 'posted')
  return {
    quarter: q, ...pair, lines, hasReceivableAccount: !!receivableId,
    total: roundCents(lines.reduce((s, l) => s + l.amount, 0)),
    drafts: all.filter(l => l.status === 'draft'),
    existing: await existingInvoice(admin, fundId, args.fromVehicleId, args.toVehicleId, q),
  }
}

/**
 * Every entity with posted, unbilled debits on its "Due from" account on `fromVehicleId`'s books,
 * across all dates (a quarter nobody invoiced still shows up here).
 */
export async function unbilledByCounterparty(
  admin: SupabaseClient, fundId: string, fromVehicleId: string,
): Promise<{ vehicleId: string; name: string; entries: number; amount: number }[]> {
  const [{ data: vehicles }, { data: accounts }] = await Promise.all([
    admin.from('fund_vehicles' as any).select('id, name').eq('fund_id', fundId),
    admin.from('chart_of_accounts' as any).select('id, code').eq('fund_id', fundId).eq('vehicle_id', fromVehicleId)
      .like('code', `${INTERCOMPANY_RECEIVABLE_CODE}-%`),
  ])
  const accountByCode = new Map(((accounts as any[]) ?? []).map(a => [a.code as string, a.id as string]))
  const pairs = ((vehicles as any[]) ?? [])
    .filter(v => v.id !== fromVehicleId)
    .map(v => ({ vehicleId: v.id as string, name: v.name as string, accountId: accountByCode.get(intercompanyCode(INTERCOMPANY_RECEIVABLE_CODE, v.id)) }))
    .filter((p): p is { vehicleId: string; name: string; accountId: string } => !!p.accountId)
  if (pairs.length === 0) return []

  const entries = await entriesTouching(admin, fundId, fromVehicleId, pairs.map(p => p.accountId), { statuses: ['posted'] })
  const billed = await billedPostingIds(admin, fundId, entries.flatMap(e => e.journal_postings.map(p => p.id)))
  const asReceivable = entries.map(e => ({ id: e.id, sourceType: e.source_type, postings: e.journal_postings.map(p => ({ id: p.id, accountId: p.account_id, amount: p.amount })) }))
  return pairs
    .map(p => {
      const lines = billablePostings(asReceivable, p.accountId, billed)
      return { vehicleId: p.vehicleId, name: p.name, entries: lines.length, amount: roundCents(lines.reduce((s, l) => s + l.amount, 0)) }
    })
    .filter(p => p.entries > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Freeze the quarter's lines into a DRAFT invoice. Refuses an empty quarter, and a quarter that
 * already has a live invoice (the unique index says the same; this says it in words).
 */
export async function createPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  args: { fromVehicleId: string; toVehicleId: string; year: number; quarter: number; invoiceDate?: string | null; memo?: string | null },
): Promise<{ id: string; invoiceNumber: string; amount: number; lines: number } | { error: string; status?: number }> {
  const preview = await previewPartnershipInvoice(admin, fundId, args)
  if ('error' in preview) return { error: preview.error, status: 400 }
  if (preview.existing) {
    return { error: `${preview.quarter.label} is already billed to ${preview.to.name} on invoice ${preview.existing.invoiceNumber} (${preview.existing.status}). Void it to bill the quarter again.`, status: 409 }
  }
  if (preview.lines.length === 0) {
    return { error: `Nothing to bill: no posted debits to Due from ${preview.to.name} in ${preview.quarter.label} that are not already on an invoice.`, status: 400 }
  }

  const { data: settings } = await admin.from('fund_settings' as any).select('currency').eq('fund_id', fundId).maybeSingle()
  const invoiceDate = args.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(args.invoiceDate) ? args.invoiceDate : new Date().toISOString().slice(0, 10)

  // A voided invoice for the same quarter keeps its number; the reissue gets the next suffix.
  let row: any = null
  let lastError = ''
  for (let attempt = 0; attempt < 10 && !row; attempt++) {
    const { data, error } = await admin.from('partnership_invoices' as any).insert({
      fund_id: fundId,
      from_vehicle_id: args.fromVehicleId,
      to_vehicle_id: args.toVehicleId,
      period_start: preview.quarter.start,
      period_end: preview.quarter.end,
      invoice_number: invoiceNumber(preview.quarter, args.toVehicleId, attempt),
      invoice_date: invoiceDate,
      amount: preview.total,
      currency: (settings as any)?.currency || 'USD',
      memo: args.memo?.trim() || null,
      status: 'draft',
      created_by: userId,
    }).select('id, invoice_number').single()
    if (data) { row = data; break }
    lastError = error?.message ?? 'unknown error'
    // 23505 on the number index: try the next suffix. On the period index: someone else just made it.
    if ((error as any)?.code !== '23505' || /period/.test(lastError)) break
  }
  if (!row) return { error: `The invoice could not be created: ${lastError}`, status: 409 }

  // Claim the lines. The partial unique index on journal_posting_id (where active) makes the claim
  // exclusive: a posting another invoice claimed a moment ago fails the whole insert.
  const { error: claimErr } = await admin.from('partnership_invoice_lines' as any).insert(preview.lines.map(l => ({
    fund_id: fundId, invoice_id: row.id, journal_entry_id: l.entryId, journal_posting_id: l.postingId, amount: l.amount,
  })))
  if (claimErr) {
    await admin.from('partnership_invoices' as any).delete().eq('id', row.id).eq('fund_id', fundId)
    return { error: (claimErr as any).code === '23505'
      ? 'Some of these expenses were billed on another invoice at the same moment. Refresh and try again.'
      : `The invoice lines could not be saved: ${claimErr.message}`, status: 409 }
  }
  return { id: row.id, invoiceNumber: row.invoice_number, amount: preview.total, lines: preview.lines.length }
}

export interface InvoiceDetail {
  id: string
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  label: string
  amount: number
  currency: string
  memo: string | null
  status: 'draft' | 'issued' | 'void'
  issuedAt: string | null
  intercompanyTransactionId: string | null
  from: { vehicleId: string; name: string }
  to: { vehicleId: string; name: string }
  lines: InvoiceDetailLine[]
}

/** An invoice's frozen lines, beside what the ledger says about each now. */
async function invoiceLines(admin: SupabaseClient, fundId: string, invoiceId: string): Promise<InvoiceDetailLine[]> {
  const { data } = await admin.from('partnership_invoice_lines' as any)
    .select('journal_entry_id, journal_posting_id, amount').eq('fund_id', fundId).eq('invoice_id', invoiceId)
  const rows = ((data as any[]) ?? [])
  if (rows.length === 0) return []
  const entryIds = Array.from(new Set(rows.map(r => r.journal_entry_id as string)))
  const [{ data: entries }, { data: postings }] = await Promise.all([
    admin.from('journal_entries' as any).select('id, entry_date, memo, reference, status, vendor_id, source_type')
      .eq('fund_id', fundId).eq('book', ACTUAL_BOOK).in('id', entryIds),
    admin.from('journal_postings' as any).select('id, amount')
      .eq('book', ACTUAL_BOOK).in('id', rows.map(r => r.journal_posting_id as string)),
  ])
  const entryById = new Map(((entries as any[]) ?? []).map(e => [e.id as string, { ...e, journal_postings: [] } as EntryRow]))
  const nowAmount = new Map(((postings as any[]) ?? []).map(p => [p.id as string, roundCents(Number(p.amount))]))
  const line = await lineDetails(admin, fundId, Array.from(entryById.values()))
  return rows
    .map(r => {
      const e = entryById.get(r.journal_entry_id) ?? { id: r.journal_entry_id, entry_date: '', memo: null, reference: null, status: 'deleted', vendor_id: null, source_type: null, journal_postings: [] }
      return { ...line(e, r.journal_posting_id, roundCents(Number(r.amount))), currentAmount: nowAmount.get(r.journal_posting_id) ?? null }
    })
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
}

export async function getPartnershipInvoice(admin: SupabaseClient, fundId: string, id: string): Promise<InvoiceDetail | null> {
  const { data } = await admin.from('partnership_invoices' as any).select('*').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!data) return null
  const inv = data as any
  const pair = await vehiclePair(admin, fundId, inv.from_vehicle_id, inv.to_vehicle_id)
  if (!pair) return null
  const lines = await invoiceLines(admin, fundId, inv.id)
  const [y, m] = String(inv.period_start).split('-').map(Number)
  return {
    id: inv.id, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date,
    periodStart: inv.period_start, periodEnd: inv.period_end,
    label: `Q${Math.floor((m - 1) / 3) + 1} ${y}`,
    amount: Number(inv.amount), currency: inv.currency, memo: inv.memo ?? null,
    status: inv.status, issuedAt: inv.issued_at ?? null,
    intercompanyTransactionId: inv.intercompany_transaction_id ?? null,
    ...pair, lines,
  }
}

/** Invoices one entity sent or received, newest period first. */
export async function listPartnershipInvoices(admin: SupabaseClient, fundId: string, vehicleId: string) {
  const { data } = await admin.from('partnership_invoices' as any)
    .select('id, invoice_number, invoice_date, period_start, period_end, amount, currency, status, from_vehicle_id, to_vehicle_id, issued_at')
    .eq('fund_id', fundId)
    .or(`from_vehicle_id.eq.${vehicleId},to_vehicle_id.eq.${vehicleId}`)
    .order('period_end', { ascending: false }).order('created_at', { ascending: false })
    .limit(200)
  return ((data as any[]) ?? [])
}

/**
 * Issue a draft invoice: book the fund's side, dated the invoice date, as an intercompany expense
 * reimbursement whose receivable is already on the biller's books. If the fund's books refuse (a
 * closed period, a chart with no partnership-expense account), nothing is booked and the invoice
 * stays a draft, with the reason.
 */
export async function issuePartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  id: string,
): Promise<{ ok: true; intercompanyTransactionId: string } | { error: string; status?: number }> {
  const inv = await getPartnershipInvoice(admin, fundId, id)
  if (!inv) return { error: 'Invoice not found', status: 404 }
  if (inv.status !== 'draft') return { error: `This invoice is already ${inv.status}.`, status: 409 }

  // The lines are re-read, not trusted from creation: an entry voided or changed since cannot be
  // billed as it was, and the fund must not be charged for what the books no longer say.
  const stale = inv.lines.filter(l => l.status !== 'posted' || l.currentAmount == null || Math.abs(l.currentAmount - l.amount) >= 0.005)
  if (stale.length > 0) {
    return { error: `${stale.length} of this invoice's expenses ${stale.length === 1 ? 'has' : 'have'} been voided or changed since it was created. Void the invoice and create it again.`, status: 409 }
  }

  const res = await postIntercompanyCharge(admin, {
    fundId, userId,
    kind: 'expense_reimbursement',
    chargeDate: inv.invoiceDate,
    amount: inv.amount,
    memo: `Partnership expenses ${inv.label}, invoice ${inv.invoiceNumber}`,
    payee: inv.from,
    payer: inv.to,
    payeeAlreadyBooked: true,
  })
  if ('error' in res) return { error: res.error, status: 400 }

  await admin.from('partnership_invoices' as any).update({
    status: 'issued', issued_at: new Date().toISOString(), intercompany_transaction_id: res.id, updated_at: new Date().toISOString(),
  }).eq('id', id).eq('fund_id', fundId)
  return { ok: true, intercompanyTransactionId: res.id }
}

/**
 * Void an invoice and release its lines for the next one. An ISSUED invoice is refused once the
 * fund has paid it, and while the fund's entry for it still stands: voiding the document would
 * leave the fund holding a payable for an invoice that no longer exists. Void that entry first.
 */
export async function voidPartnershipInvoice(
  admin: SupabaseClient,
  fundId: string,
  id: string,
): Promise<{ ok: true } | { error: string; status?: number }> {
  const { data } = await admin.from('partnership_invoices' as any).select('id, status, intercompany_transaction_id, to_vehicle_id').eq('fund_id', fundId).eq('id', id).maybeSingle()
  if (!data) return { error: 'Invoice not found', status: 404 }
  const inv = data as any
  if (inv.status === 'void') return { ok: true }
  if (inv.status === 'issued' && inv.intercompany_transaction_id) {
    const { data: charge } = await admin.from('intercompany_transactions' as any)
      .select('status, from_entry_id, to_entry_id').eq('id', inv.intercompany_transaction_id).maybeSingle()
    if ((charge as any)?.status === 'settled') {
      return { error: 'This invoice has been paid. Reverse the payment before voiding it.', status: 409 }
    }
    const entryIds = [(charge as any)?.from_entry_id, (charge as any)?.to_entry_id].filter(Boolean)
    if (entryIds.length > 0) {
      const { data: live } = await admin.from('journal_entries' as any).select('id').eq('book', ACTUAL_BOOK).in('id', entryIds).neq('status', 'void')
      if (((live as any[]) ?? []).length > 0) {
        const fundName = await vehicleNameById(admin, fundId, inv.to_vehicle_id)
        return { error: `This invoice is booked on ${fundName ?? 'the fund'}'s books. Void that entry first, then void the invoice.`, status: 409 }
      }
    }
    await admin.from('intercompany_transactions' as any).update({ status: 'void', updated_at: new Date().toISOString() })
      .eq('id', inv.intercompany_transaction_id).eq('fund_id', fundId)
  }
  await admin.from('partnership_invoice_lines' as any).update({ active: false }).eq('fund_id', fundId).eq('invoice_id', id)
  await admin.from('partnership_invoices' as any).update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', id).eq('fund_id', fundId)
  return { ok: true }
}
