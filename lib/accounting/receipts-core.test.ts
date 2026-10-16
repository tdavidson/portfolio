import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  parseReceiptExtraction, looksLikeReceipt, isReceiptFile, scoreCandidate, rankCandidates,
  billablePostings, quarterBounds, quarterOf, previousQuarter, invoiceNumber, isoDateOrNull, amountOrNull,
} from './receipts-core'
import { buildPartnershipInvoiceHtml, appendBackup } from './partnership-invoice-pdf'

describe('parseReceiptExtraction', () => {
  it('reads the fields, tolerating a fenced block and a formatted total', () => {
    const r = parseReceiptExtraction('```json\n{"is_receipt":true,"vendor_name":" Delaware  Division of Corporations ","receipt_date":"2026-03-01","total":"$1,234.50","currency":"usd","description":"Franchise tax"}\n```')
    expect(r).toEqual({
      isReceipt: true, vendorName: 'Delaware Division of Corporations', receiptDate: '2026-03-01',
      amount: 1234.5, currency: 'USD', description: 'Franchise tax',
    })
  })
  it('blanks what it cannot trust instead of guessing', () => {
    const r = parseReceiptExtraction('{"vendor_name":null,"receipt_date":"March 1","total":"about forty","currency":"dollars"}')!
    expect(r.receiptDate).toBeNull()
    expect(r.amount).toBeNull()
    expect(r.currency).toBeNull()
  })
  it('refuses a non-JSON answer', () => {
    expect(parseReceiptExtraction('I could not read it')).toBeNull()
  })
  it('rejects impossible dates', () => {
    expect(isoDateOrNull('2026-02-30')).toBeNull()
    expect(isoDateOrNull('2026-02-28')).toBe('2026-02-28')
  })
  it('keeps the size of a refund, not its sign', () => {
    expect(amountOrNull(-42.129)).toBe(42.13)
    expect(amountOrNull(0)).toBeNull()
  })
})

describe('looksLikeReceipt', () => {
  const base = { subject: '', to: 'inbound@fund.example', attachmentNames: [] as string[], body: '', isFundMember: true }
  it('takes an explicit tag or the +receipts address on its own', () => {
    expect(looksLikeReceipt({ ...base, subject: 'Receipt: filing fee' })).toBe(true)
    expect(looksLikeReceipt({ ...base, subject: '[receipt] audit' })).toBe(true)
    expect(looksLikeReceipt({ ...base, to: 'inbound+receipts@fund.example', subject: 'anything' })).toBe(true)
  })
  it('needs a receipt-like attachment or a stated total when only the subject says so', () => {
    expect(looksLikeReceipt({ ...base, subject: 'Fwd: Your receipt from Stripe' })).toBe(false)
    expect(looksLikeReceipt({ ...base, subject: 'Fwd: Your receipt from Stripe', attachmentNames: ['Receipt-2291.pdf'] })).toBe(true)
    expect(looksLikeReceipt({ ...base, subject: 'Your order confirmation', body: 'Thanks!\nOrder total: $129.00' })).toBe(true)
  })
  it('never treats mail from outside the fund as a receipt', () => {
    expect(looksLikeReceipt({ ...base, isFundMember: false, subject: 'Receipt: invoice', attachmentNames: ['invoice.pdf'] })).toBe(false)
  })
  it('leaves a portfolio update alone', () => {
    expect(looksLikeReceipt({ ...base, subject: 'Q3 investor update', attachmentNames: ['Q3 update.pdf'] })).toBe(false)
  })
})

describe('isReceiptFile', () => {
  it('keeps PDFs and photographed receipts, not signature logos', () => {
    expect(isReceiptFile('application/pdf', 1000)).toBe(true)
    expect(isReceiptFile('image/jpeg', 400_000)).toBe(true)
    expect(isReceiptFile('image/png', 3_000)).toBe(false)
    expect(isReceiptFile('text/calendar', 3_000)).toBe(false)
  })
})

describe('matching', () => {
  const receipt = { amount: 250, receiptDate: '2026-05-10', vendorName: 'Cooley LLP' }
  it('requires the amount', () => {
    expect(scoreCandidate(receipt, { kind: 'entry', id: 'a', date: '2026-05-10', amount: 260, description: null, status: 'posted' })).toBeNull()
  })
  it('allows a 2% currency drift at a lower score', () => {
    const s = scoreCandidate(receipt, { kind: 'bank', id: 'b', date: '2026-05-10', amount: 254, description: null, status: 'x' })!
    expect(s.score).toBeLessThan(0.85)
  })
  it('drops a charge outside the window', () => {
    expect(scoreCandidate(receipt, { kind: 'entry', id: 'a', date: '2026-06-10', amount: 250, description: null, status: 'posted' })).toBeNull()
  })
  it('ranks same day and vendor named first', () => {
    const ranked = rankCandidates(receipt, [
      { kind: 'entry', id: 'later', date: '2026-05-16', amount: 250, description: 'legal', status: 'posted' },
      { kind: 'bank', id: 'best', date: '2026-05-10', amount: 250, description: 'COOLEY LLP WIRE', status: 'x' },
    ])
    expect(ranked.map(r => r.id)).toEqual(['best', 'later'])
    expect(ranked[0].score).toBe(1)
  })
})

describe('billablePostings', () => {
  const due = 'acct-due-from-fund3'
  it('bills each debit to the fund\'s Due-from account, and nothing else', () => {
    const lines = billablePostings([
      // Paid on the fund's behalf: Dr Due from Fund III, Cr cash.
      { id: 'e1', sourceType: 'bank', postings: [{ id: 'p1', accountId: due, amount: 250 }, { id: 'p2', accountId: 'cash', amount: -250 }] },
      // Split with another fund: only this fund's share.
      { id: 'e2', sourceType: 'manual', postings: [{ id: 'p3', accountId: due, amount: 60 }, { id: 'p4', accountId: 'due-other', amount: 40 }, { id: 'p5', accountId: 'cash', amount: -100 }] },
      // A refund back to the fund's account is not a cost.
      { id: 'e3', sourceType: 'manual', postings: [{ id: 'p6', accountId: 'cash', amount: 20 }, { id: 'p7', accountId: due, amount: -20 }] },
    ], due, new Set())
    expect(lines).toEqual([
      { entryId: 'e1', postingId: 'p1', amount: 250 },
      { entryId: 'e2', postingId: 'p3', amount: 60 },
    ])
  })
  it('leaves out intercompany charges and what an earlier invoice billed', () => {
    const lines = billablePostings([
      { id: 'fee', sourceType: 'intercompany', postings: [{ id: 'p1', accountId: due, amount: 5000 }] },
      { id: 'old', sourceType: 'bank', postings: [{ id: 'p2', accountId: due, amount: 75 }] },
    ], due, new Set(['p2']))
    expect(lines).toEqual([])
  })
})

describe('quarters', () => {
  it('bounds a quarter and finds the previous one', () => {
    expect(quarterBounds(2026, 1)).toMatchObject({ start: '2026-01-01', end: '2026-03-31', label: 'Q1 2026' })
    expect(quarterBounds(2024, 4).end).toBe('2024-12-31')
    expect(quarterOf('2026-08-15').quarter).toBe(3)
    expect(previousQuarter('2026-01-05')).toMatchObject({ year: 2025, quarter: 4 })
    expect(() => quarterBounds(2026, 5)).toThrow()
  })
  it('numbers invoices per quarter and payer, with a suffix on a reissue', () => {
    const q = quarterBounds(2026, 3)
    expect(invoiceNumber(q, 'abcdef12-0000')).toBe('PE-2026Q3-ABCDEF')
    expect(invoiceNumber(q, 'abcdef12-0000', 1)).toBe('PE-2026Q3-ABCDEF-2')
  })
})

describe('partnership invoice PDF', () => {
  const data = {
    fromName: 'Hemrock Management LLC', fromLogo: null, fromAddress: null, toName: 'Fund I, L.P.', toAddress: null,
    invoiceNumber: 'PE-2026Q3-ABCDEF', invoiceDate: '2026-10-01', periodLabel: 'Q3 2026', periodStart: '2026-07-01', periodEnd: '2026-09-30',
    currency: 'USD', amount: 1250, memo: null, draft: true,
    lines: [{ date: '2026-07-14', vendor: 'Cooley <LLP>', description: 'Closing legal', reference: 'INV-9', amount: 1250, receipts: 1 }],
  }
  it('escapes what it prints and marks a draft', () => {
    const html = buildPartnershipInvoiceHtml(data)
    expect(html).toContain('Cooley &lt;LLP&gt;')
    expect(html).toContain('Draft for review')
    expect(html).toContain('$1,250.00')
  })
  it('appends PDF and image receipts and names what it could not', async () => {
    const base = await PDFDocument.create(); base.addPage()
    const receipt = await PDFDocument.create(); receipt.addPage(); receipt.addPage()
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const { pdf, skipped } = await appendBackup(Buffer.from(await base.save()), [
      { fileName: 'a.pdf', contentType: 'application/pdf', content: Buffer.from(await receipt.save()) },
      { fileName: 'b.png', contentType: 'image/png', content: png },
      { fileName: 'c.heic', contentType: 'image/heic', content: Buffer.from('x') },
    ])
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(4)
    expect(skipped).toEqual(['c.heic'])
  })
})
