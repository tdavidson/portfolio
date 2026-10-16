// Handlers for receipt-tools-manifest.ts. Every tool works on the entity the dispatcher resolved;
// a receipt is in reach when it is filed under that entity, or unfiled and the caller sees every
// entity (the same rule as lib/accounting/receipt-access.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { accountIdByCode } from '@/lib/accounting/persist'
import { resolveVehicleWithAccess } from '@/lib/accounting/http-vehicle'
import {
  listReceipts, getReceipt, receiptsForEntry, matchCandidates, receiptFileUrl, receiptFileBytes, storeReceipt,
  extractReceipt, updateReceiptFields, attachReceipt, detachReceipt, setReceiptDismissed, draftEntryFromReceipt,
  type ReceiptRow,
} from '@/lib/accounting/receipts'
import {
  previewPartnershipInvoice, createPartnershipInvoice, issuePartnershipInvoice, voidPartnershipInvoice,
  listPartnershipInvoices, unbilledByCounterparty, getPartnershipInvoice,
} from '@/lib/accounting/partnership-invoices'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

const INLINE_MAX = 3 * 1024 * 1024

async function here(ctx: AgentToolContext): Promise<string> {
  const id = await vehicleIdByName(ctx.admin, ctx.fundId, ctx.portfolioGroup)
  if (!id) throw new Error(`Unknown vehicle "${ctx.portfolioGroup}"`)
  return id
}

/** The receipt, if it is this entity's or (for a caller who sees every entity) nobody's yet. */
async function reachable(ctx: AgentToolContext, receiptId: unknown): Promise<{ r: ReceiptRow; vehicleId: string }> {
  const vehicleId = await here(ctx)
  const r = await getReceipt(ctx.admin, ctx.fundId, String(receiptId ?? ''))
  if (!r || (r.vehicle_id !== vehicleId && !(r.vehicle_id === null && ctx.access.vehicles.all))) {
    throw new Error(`No receipt ${String(receiptId ?? '')} on ${ctx.portfolioGroup}. Pass vehicle to work on another entity's receipts.`)
  }
  return { r, vehicleId }
}

/** An entity named in an argument, among the caller's own, with the grant a manco needs. */
async function otherEntity(ctx: AgentToolContext, name: unknown, need: 'read' | 'write'): Promise<{ vehicleId: string; name: string }> {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Name the entity to bill (billTo)')
  const v = await resolveVehicleWithAccess(ctx.admin, ctx.access, name, need)
  const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, v.name)
  if (!vehicleId) throw new Error(`Unknown vehicle "${v.name}"`)
  return { vehicleId, name: v.name }
}

async function accountByCode(admin: SupabaseClient, fundId: string, group: string, code: unknown): Promise<string> {
  const id = (await accountIdByCode(admin, fundId, group)).get(String(code ?? '').trim())
  if (!id) throw new Error(`No account ${String(code ?? '')} on ${group}'s chart`)
  return id
}

function fail(res: { error: string }): never { throw new Error(res.error) }

export const RECEIPT_HANDLERS: Record<string, AgentToolHandler> = {
  list_receipts: async (ctx, input) => {
    const vehicleId = await here(ctx)
    if (input?.entryId) {
      const { data: e } = await ctx.admin.from('journal_entries' as any).select('id').eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK).eq('id', String(input.entryId)).maybeSingle()
      if (!e) throw new Error(`No entry ${input.entryId} on ${ctx.portfolioGroup}`)
      return { receipts: await receiptsForEntry(ctx.admin, ctx.fundId, String(input.entryId)) }
    }
    const status = ['unmatched', 'matched', 'dismissed', 'all'].includes(input?.status) ? input.status : undefined
    const receipts = await listReceipts(ctx.admin, ctx.fundId, { vehicleId, includeUnassigned: ctx.access.vehicles.all, status })
    const out = []
    for (const r of receipts) {
      out.push({
        ...r,
        suggestions: r.status === 'unmatched' && r.vehicle_id === vehicleId ? await matchCandidates(ctx.admin, ctx.fundId, r) : undefined,
      })
    }
    return { receipts: out }
  },

  get_receipt: async (ctx, input) => {
    const { r } = await reachable(ctx, input?.receiptId)
    const url = await receiptFileUrl(ctx.admin, r)
    let contentBase64: string | undefined
    if (input?.includeContent && (r.size_bytes ?? 0) <= INLINE_MAX) {
      contentBase64 = (await receiptFileBytes(ctx.admin, r))?.toString('base64')
    }
    return {
      receipt: r, url,
      suggestions: r.status === 'unmatched' ? await matchCandidates(ctx.admin, ctx.fundId, r) : [],
      ...(contentBase64 ? { contentBase64, contentType: r.content_type } : {}),
    }
  },

  add_receipt: async (ctx, input) => {
    const vehicleId = await here(ctx)
    const content = Buffer.from(String(input?.contentBase64 ?? ''), 'base64')
    if (content.length === 0) throw new Error('contentBase64 is empty')
    if (content.length > INLINE_MAX) throw new Error('Over MCP a receipt must be under 3 MB; upload larger files on the Receipts page.')
    const contentType = String(input?.contentType || (String(input?.fileName).toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'))
    if (!/^(application\/pdf|image\/)/.test(contentType)) throw new Error('A receipt must be a PDF or an image')
    const row = await storeReceipt(ctx.admin, {
      fundId: ctx.fundId, vehicleId, source: 'agent', fileName: String(input?.fileName ?? 'receipt'),
      contentType, content, uploadedBy: ctx.userId,
      fields: { vendorName: input?.vendorName ?? null, receiptDate: input?.receiptDate ?? null, amount: input?.amount ?? null, description: input?.description ?? null },
    })
    if ('error' in row) fail(row)
    if (row.extraction_status === 'pending') await extractReceipt(ctx.admin, ctx.fundId, row.id, { content, contentType })
    if (input?.journalEntryId) {
      const res = await attachReceipt(ctx.admin, ctx.fundId, row.id, { journalEntryId: String(input.journalEntryId) }, ctx.userId)
      if ('error' in res) fail(res)
      return { receipt: res }
    }
    const fresh = await getReceipt(ctx.admin, ctx.fundId, row.id)
    return { receipt: fresh, suggestions: fresh ? await matchCandidates(ctx.admin, ctx.fundId, fresh) : [] }
  },

  update_receipt: async (ctx, input) => {
    const { r, vehicleId } = await reachable(ctx, input?.receiptId)
    if (typeof input?.dismissed === 'boolean') {
      const res = await setReceiptDismissed(ctx.admin, ctx.fundId, r.id, input.dismissed)
      if ('error' in res) fail(res)
    }
    const patch: Record<string, unknown> = {}
    for (const k of ['vendorName', 'receiptDate', 'amount', 'currency', 'description']) if (input && k in input) patch[k] = input[k]
    if (input?.assignToThisEntity && !r.vehicle_id) patch.vehicleId = vehicleId
    if (Object.keys(patch).length === 0) return { receipt: await getReceipt(ctx.admin, ctx.fundId, r.id) }
    const res = await updateReceiptFields(ctx.admin, ctx.fundId, r.id, patch as any)
    if ('error' in res) fail(res)
    return { receipt: res, suggestions: res.status === 'unmatched' ? await matchCandidates(ctx.admin, ctx.fundId, res) : [] }
  },

  attach_receipt: async (ctx, input) => {
    const { r, vehicleId } = await reachable(ctx, input?.receiptId)
    if (input?.detach) {
      const res = await detachReceipt(ctx.admin, ctx.fundId, r.id)
      if ('error' in res) fail(res)
      return { receipt: res }
    }
    // The target must be on THIS entity's books: an unfiled receipt is filed under it by attaching.
    const journalEntryId = input?.journalEntryId ? String(input.journalEntryId) : null
    const bankTransactionId = input?.bankTransactionId ? String(input.bankTransactionId) : null
    const table = journalEntryId ? 'journal_entries' : 'bank_transactions'
    const { data: target } = await ctx.admin.from(table as any).select('id').eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).eq('id', journalEntryId ?? bankTransactionId ?? '').maybeSingle()
    if (!target) throw new Error(`No ${journalEntryId ? 'entry' : 'bank transaction'} ${journalEntryId ?? bankTransactionId ?? ''} on ${ctx.portfolioGroup}`)
    const res = await attachReceipt(ctx.admin, ctx.fundId, r.id, { journalEntryId, bankTransactionId }, ctx.userId)
    if ('error' in res) fail(res)
    return { receipt: res }
  },

  draft_entry_from_receipt: async (ctx, input) => {
    const { r, vehicleId } = await reachable(ctx, input?.receiptId)
    if (!r.vehicle_id) {
      const res = await updateReceiptFields(ctx.admin, ctx.fundId, r.id, { vehicleId })
      if ('error' in res) fail(res)
    }
    const billTo = input?.billTo ? await otherEntity(ctx, input.billTo, 'read') : null
    const [debitAccountId, creditAccountId] = await Promise.all([
      billTo ? Promise.resolve(null) : accountByCode(ctx.admin, ctx.fundId, ctx.portfolioGroup, input?.debitAccountCode),
      accountByCode(ctx.admin, ctx.fundId, ctx.portfolioGroup, input?.creditAccountCode),
    ])
    const res = await draftEntryFromReceipt(ctx.admin, ctx.fundId, ctx.portfolioGroup, vehicleId, ctx.userId, r.id, {
      debitAccountId, creditAccountId, billTo, memo: input?.memo ?? null,
    })
    if ('error' in res) fail(res)
    return { draftEntryId: res.entryId, receipt: res.receipt, note: 'Draft only. Post it with post_drafts (ids: [draftEntryId]) once it looks right.' }
  },

  partnership_invoices: async (ctx, input) => {
    const vehicleId = await here(ctx)
    if (input?.invoiceId) {
      const inv = await getPartnershipInvoice(ctx.admin, ctx.fundId, String(input.invoiceId))
      if (!inv || (inv.from.vehicleId !== vehicleId && inv.to.vehicleId !== vehicleId)) throw new Error(`No invoice ${input.invoiceId} on ${ctx.portfolioGroup}`)
      await otherEntity(ctx, inv.from.vehicleId === vehicleId ? inv.to.name : inv.from.name, 'read')
      return { invoice: inv, pdf: `/api/accounting/partnership-invoices/${inv.id}/pdf` }
    }
    if (input?.billTo) {
      const to = await otherEntity(ctx, input.billTo, 'read')
      const preview = await previewPartnershipInvoice(ctx.admin, ctx.fundId, { fromVehicleId: vehicleId, toVehicleId: to.vehicleId, year: Number(input.year), quarter: Number(input.quarter) })
      if ('error' in preview) fail(preview)
      return { preview }
    }
    const [invoices, unbilled] = await Promise.all([
      listPartnershipInvoices(ctx.admin, ctx.fundId, vehicleId),
      unbilledByCounterparty(ctx.admin, ctx.fundId, vehicleId),
    ])
    return { invoices, unbilled }
  },

  create_partnership_invoice: async (ctx, input) => {
    const vehicleId = await here(ctx)
    const to = await otherEntity(ctx, input?.billTo, 'write')
    const res = await createPartnershipInvoice(ctx.admin, ctx.fundId, ctx.userId, {
      fromVehicleId: vehicleId, toVehicleId: to.vehicleId, year: Number(input?.year), quarter: Number(input?.quarter),
      invoiceDate: input?.invoiceDate ?? null, memo: input?.memo ?? null,
    })
    if ('error' in res) fail(res)
    if (!input?.issue) return { ...res, status: 'draft', pdf: `/api/accounting/partnership-invoices/${res.id}/pdf` }
    const issued = await issuePartnershipInvoice(ctx.admin, ctx.fundId, ctx.userId, res.id)
    if ('error' in issued) return { ...res, status: 'draft', issueError: issued.error }
    return { ...res, status: 'issued', intercompanyTransactionId: issued.intercompanyTransactionId, pdf: `/api/accounting/partnership-invoices/${res.id}/pdf` }
  },

  issue_partnership_invoice: async (ctx, input) => {
    const vehicleId = await here(ctx)
    const id = String(input?.invoiceId ?? '')
    const inv = await getPartnershipInvoice(ctx.admin, ctx.fundId, id)
    if (!inv || inv.from.vehicleId !== vehicleId) throw new Error(`No invoice ${id} billed by ${ctx.portfolioGroup}`)
    await otherEntity(ctx, inv.to.name, 'write')
    const res = input?.void
      ? await voidPartnershipInvoice(ctx.admin, ctx.fundId, id)
      : await issuePartnershipInvoice(ctx.admin, ctx.fundId, ctx.userId, id)
    if ('error' in res) fail(res)
    return res
  },
}
