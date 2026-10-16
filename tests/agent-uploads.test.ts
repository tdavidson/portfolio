import { describe, expect, it } from 'vitest'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'
import { stageToolCall } from '@/lib/agent/tool-call-action'
import { stageRun } from '@/lib/agent/run-action'
import { UPLOAD_HANDLERS } from '@/lib/agent/upload-tools'
import { DILIGENCE_HANDLERS } from '@/lib/agent/diligence-tools'
import { registerUploadedDiligenceDocument } from '@/lib/diligence/service'
import { memoryAdmin } from './helpers/memory-admin'
import { withMemoryStorage } from './helpers/memory-storage'

/**
 * Uploads from chat without the file passing through it: a signed URL at a path the server
 * chose, the assistant PUTs the bytes there, and a register tool takes the file in through the
 * same lib function the web route calls.
 */

const oauth = { keyId: 'oauth:abc' }
const key = { keyId: 'key-1' }
const admin_ = { fundId: 'f1', userId: 'u1', role: 'admin', vehicles: { all: true, ids: [] }, features: { deals: 'everyone' }, grants: {}, defaults: {} } as any
const member = { fundId: 'f1', userId: 'u2', role: 'member', vehicles: { all: false, ids: ['v1'] }, features: {}, grants: {}, defaults: {} } as any

function seed() {
  const m = memoryAdmin({
    diligence_deals: [
      { id: 'dd-1', fund_id: 'f1', name: 'Acme', vehicle_id: 'v1', aliases: [] },
      { id: 'dd-2', fund_id: 'f1', name: 'Beta', vehicle_id: 'v2', aliases: [] },
    ],
    companies: [{ id: 'c1', fund_id: 'f1', name: 'Acme', holding_type: 'company' }, { id: 'c2', fund_id: 'f1', name: 'Beta', holding_type: 'company' }],
    company_vehicles: [{ fund_id: 'f1', company_id: 'c1', vehicle_id: 'v1' }, { fund_id: 'f1', company_id: 'c2', vehicle_id: 'v2' }],
    inbound_emails: [
      { id: 'em-1', fund_id: 'f1', subject: 'Acme Q3', company_id: 'c1', raw_payload: { Subject: 'Acme Q3', Attachments: [{ Name: 'old.pdf' }] } },
      { id: 'em-9', fund_id: 'f2', subject: 'Other fund', raw_payload: {} },
    ],
    inbound_deals: [{ id: 'in-1', fund_id: 'f1', company_name: 'Zeta', vehicle_id: 'v1', email_id: 'em-1', status: 'new', created_at: '2026-01-01' }],
    lp_investors: [{ id: 'i1', fund_id: 'f1', name: 'Birch Family Office' }, { id: 'i2', fund_id: 'f1', name: 'Cedar LP' }],
  })
  const storage = withMemoryStorage(m.admin)
  return { ...m, storage }
}

const ctx = (admin: any, access = admin_) => ({ admin, fundId: 'f1', portfolioGroup: '', userId: access.userId, access })

describe('upload URL tools', () => {
  it('run directly from a chat (they change no record); the register tools stage', () => {
    for (const name of ['diligence_document_upload_url', 'company_document_upload_url', 'deals_deck_upload_url',
      'company_update_upload_url', 'email_attachment_upload_url', 'lp_document_upload_url', 'entity_document_upload_url']) {
      expect(getTool(name)!.scope, name).toBe('write')
      expect(shouldStage(getTool(name)!, {}, oauth), name).toBe(false)
    }
    for (const name of ['diligence_add_documents', 'add_company_document', 'deals_create_inbound', 'submit_company_update',
      'add_email_attachment', 'lp_add_document']) {
      expect(shouldStage(getTool(name)!, {}, oauth), name).toBe(true)
      expect(shouldStage(getTool(name)!, {}, key), name).toBe(false)
    }
  })

  it('tell the assistant never to take the file through chat, and how to PUT it', () => {
    for (const name of ['diligence_document_upload_url', 'company_document_upload_url', 'deals_deck_upload_url',
      'company_update_upload_url', 'email_attachment_upload_url', 'lp_document_upload_url']) {
      const d = getTool(name)!.description
      expect(d, name).toMatch(/NEVER ask the person to paste or attach the file in chat/)
      expect(d, name).toContain('curl -X PUT -H "Content-Type:')
      expect(d, name).toMatch(/expiry/)
    }
  })

  it('cannot be a step of a run', async () => {
    const { admin } = seed()
    await expect(stageRun({ admin, fundId: 'f1', userId: 'u1', access: admin_ } as any,
      { title: 't', rationale: 'r', steps: [{ tool: 'company_document_upload_url', input: { company: 'Acme', fileName: 'a.pdf' } }] },
      () => null)).rejects.toThrow(/changes nothing; call it directly/)
  })

  it('returns the URL, its expiry, the exact headers, the curl form and the limit', async () => {
    const { admin } = seed()
    const out = await UPLOAD_HANDLERS.diligence_document_upload_url(ctx(admin), { deal: 'Acme', fileName: 'Data room/Model v3.xlsx', sizeBytes: 5_000_000 }) as any
    expect(out.storagePath).toMatch(/^dd-1\/\d+_Model v3\.xlsx$/)
    expect(out.method).toBe('PUT')
    expect(out.headers).toEqual({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-upsert': 'false' })
    expect(out.curl).toContain(`-H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"`)
    expect(out.curl).toContain(out.uploadUrl)
    expect(out.maxBytes).toBe(100 * 1024 * 1024)
    expect(out.expiresInSeconds).toBe(7200)
    expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now())
    expect(out.next).toContain('diligence_add_documents')
    expect(out.howTo).toMatch(/Never ask the person to paste/)
  })

  it('refuses a file over the limit, and a deal or company the caller cannot see', async () => {
    const { admin } = seed()
    await expect(UPLOAD_HANDLERS.diligence_document_upload_url(ctx(admin), { deal: 'Acme', fileName: 'x.mp4', sizeBytes: 200 * 1024 * 1024 })).rejects.toThrow(/limit here is 100 MB/)
    await expect(UPLOAD_HANDLERS.diligence_document_upload_url(ctx(admin, member), { deal: 'Beta', fileName: 'x.pdf' })).rejects.toThrow()
    await expect(UPLOAD_HANDLERS.company_document_upload_url(ctx(admin, member), { company: 'Beta', fileName: 'x.pdf' })).rejects.toThrow(/No company named/)
    await expect(UPLOAD_HANDLERS.company_document_upload_url(ctx(admin), { company: 'Acme', fileName: 'x.pdf', sizeBytes: 21 * 1024 * 1024 })).rejects.toThrow(/20 MB/)
    await expect(UPLOAD_HANDLERS.deals_deck_upload_url(ctx(admin), { fileName: 'deck.pdf', sizeBytes: 11 * 1024 * 1024 })).rejects.toThrow(/10 MB/)
  })
})

describe('data room documents', () => {
  it('registers an uploaded file as the browser upload is: scanned, classified, recorded', async () => {
    const { admin, tables, storage } = seed()
    const url = await UPLOAD_HANDLERS.diligence_document_upload_url(ctx(admin), { deal: 'Acme', fileName: 'notes.txt' }) as any
    storage.put('diligence-documents', url.storagePath, 'Call notes: churn is 2% monthly.')
    const out = await DILIGENCE_HANDLERS.diligence_add_documents(ctx(admin), {
      deal: 'Acme', uploaded_files: [{ storage_path: url.storagePath, filename: 'notes.txt' }],
    }) as any
    expect(out.refused).toEqual([])
    expect(out.added).toHaveLength(1)
    expect(tables.diligence_documents[0]).toMatchObject({ deal_id: 'dd-1', fund_id: 'f1', storage_path: url.storagePath, file_name: 'notes.txt', parse_status: 'pending', uploaded_by: 'u1' })
    expect(tables.diligence_documents[0].file_size_bytes).toBeGreaterThan(0)
  })

  it('refuses a path outside the deal, and one never uploaded', async () => {
    const { admin, storage } = seed()
    storage.put('diligence-documents', 'dd-2/1_x.txt', 'x')
    const outside = await registerUploadedDiligenceDocument(admin, { fundId: 'f1', userId: 'u1' }, 'dd-1', { storagePath: 'dd-2/1_x.txt' })
    expect(outside).toMatchObject({ ok: false, error: 'storage_path outside deal folder' })
    const traversal = await registerUploadedDiligenceDocument(admin, { fundId: 'f1', userId: 'u1' }, 'dd-1', { storagePath: 'dd-1/../dd-2/1_x.txt' })
    expect(traversal.ok).toBe(false)
    const missing = await registerUploadedDiligenceDocument(admin, { fundId: 'f1', userId: 'u1' }, 'dd-1', { storagePath: 'dd-1/1_nothing.pdf' })
    expect(missing).toMatchObject({ ok: false, error: 'Uploaded file not found in storage' })
  })

  it('removes an unsafe file instead of recording it', async () => {
    const { admin, tables, storage } = seed()
    storage.put('diligence-documents', 'dd-1/1_tool.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))
    const out = await DILIGENCE_HANDLERS.diligence_add_documents(ctx(admin), { deal: 'Acme', uploaded_files: [{ storage_path: 'dd-1/1_tool.exe' }] }) as any
    expect(out.added).toEqual([])
    expect(out.refused[0]).toMatch(/could not be accepted/)
    expect(storage.has('diligence-documents', 'dd-1/1_tool.exe')).toBe(false)
    expect(tables.diligence_documents ?? []).toEqual([])
  })
})

describe('company documents', () => {
  it('mints the URL in the fund and company folder, and registers it with its text extracted', async () => {
    const { admin, tables, storage } = seed()
    const url = await UPLOAD_HANDLERS.company_document_upload_url(ctx(admin), { company: 'Acme', fileName: 'kpis.csv' }) as any
    expect(url.storagePath.startsWith('f1/c1/')).toBe(true)
    storage.put('company-documents', url.storagePath, 'month,mrr\n2026-09,120000\n')
    const out = await UPLOAD_HANDLERS.add_company_document(ctx(admin), { company: 'Acme', storage_path: url.storagePath, filename: 'kpis.csv' }) as any
    expect(out).toMatchObject({ company: 'Acme', added: true, keptAsTextOnly: false })
    expect(tables.company_documents[0]).toMatchObject({ company_id: 'c1', fund_id: 'f1', filename: 'kpis.csv', file_type: 'text/csv', uploaded_by: 'u1' })
    expect(tables.company_documents[0].extracted_text).toContain('120000')
  })

  it("refuses another company's or fund's path", async () => {
    const { admin, storage } = seed()
    storage.put('company-documents', 'f1/c2/x.csv', 'a')
    await expect(UPLOAD_HANDLERS.add_company_document(ctx(admin), { company: 'Acme', storage_path: 'f1/c2/x.csv', filename: 'x.csv' })).rejects.toThrow('Invalid storage path')
    await expect(UPLOAD_HANDLERS.add_company_document(ctx(admin), { company: 'Acme', storage_path: 'f2/c1/x.csv', filename: 'x.csv' })).rejects.toThrow('Invalid storage path')
  })
})

describe('email attachments', () => {
  it("attaches a file to an inbound deal's source email, sized from what was uploaded", async () => {
    const { admin, tables, storage } = seed()
    const url = await UPLOAD_HANDLERS.email_attachment_upload_url(ctx(admin), { deal: 'Zeta', fileName: 'deck.pdf' }) as any
    expect(url.email).toBe('em-1')
    expect(url.storagePath.startsWith('em-1/')).toBe(true)
    storage.put('email-attachments', url.storagePath, '%PDF-1.4 a deck')
    const out = await UPLOAD_HANDLERS.add_email_attachment(ctx(admin), { email: 'em-1', storage_path: url.storagePath, filename: 'deck.pdf' }) as any
    expect(out.attached).toBe('deck.pdf')
    const email = tables.inbound_emails.find(e => e.id === 'em-1')!
    expect(email.attachments_count).toBe(2)
    expect(email.raw_payload.Attachments[1]).toMatchObject({ Name: 'deck.pdf', ContentType: 'application/pdf', ContentLength: 15, StoragePath: url.storagePath })
  })

  it("refuses another fund's email and a path outside the email", async () => {
    const { admin, storage } = seed()
    await expect(UPLOAD_HANDLERS.email_attachment_upload_url(ctx(admin), { email: 'em-9', fileName: 'x.pdf' })).rejects.toThrow(/No email em-9/)
    storage.put('email-attachments', 'em-2/x.pdf', 'x')
    await expect(UPLOAD_HANDLERS.add_email_attachment(ctx(admin), { email: 'em-1', storage_path: 'em-2/x.pdf', filename: 'x.pdf', size_bytes: 1 })).rejects.toThrow('Invalid storage path')
  })

  it("stages a member's attachment only for an email about one of their companies", async () => {
    const { admin } = seed()
    const deps = { admin, fundId: 'f1', userId: 'u2', access: member }
    await expect(stageToolCall(deps, 'add_email_attachment', { email: 'em-1', storage_path: 'em-1/a.pdf', filename: 'a.pdf' })).resolves.toBeTruthy()
    await (admin as any).from('inbound_emails').update({ company_id: 'c2' }).eq('id', 'em-1')
    await expect(stageToolCall(deps, 'add_email_attachment', { email: 'em-1', storage_path: 'em-1/a.pdf', filename: 'a.pdf' })).rejects.toThrow()
  })
})

describe('LP portal documents', () => {
  it('are admin only, on every surface', async () => {
    expect(adminOnlyToolLabel('lp_document_upload_url', {})).toBe('upload an LP document')
    expect(adminOnlyToolLabel('lp_add_document', {})).toBe('publish an LP document')
    const { admin } = seed()
    // The URL tool runs directly from a chat, so its handler refuses a member itself.
    await expect(UPLOAD_HANDLERS.lp_document_upload_url(ctx(admin, member), { fileName: 'q3.pdf' })).rejects.toThrow(/Only an admin/)
    await expect(UPLOAD_HANDLERS.lp_add_document(ctx(admin, member), { storage_path: 'f1/1_q3.pdf', title: 'Q3', file_name: 'q3.pdf' })).rejects.toThrow(/Only an admin/)
  })

  it('records an uploaded document shared with the named investors', async () => {
    const { admin, tables, storage } = seed()
    const url = await UPLOAD_HANDLERS.lp_document_upload_url(ctx(admin), { fileName: 'Q3 report.pdf' }) as any
    expect(url.storagePath).toMatch(/^f1\/\d+_Q3 report\.pdf$/)
    storage.put('lp-documents', url.storagePath, '%PDF-1.4 report')
    const out = await UPLOAD_HANDLERS.lp_add_document(ctx(admin), {
      storage_path: url.storagePath, title: 'Q3 2026 report', file_name: 'Q3 report.pdf', scope: 'investor', investors: ['Birch Family Office', 'cedar lp'], index: false,
    }) as any
    expect(out.sharedWith).toEqual(['Birch Family Office', 'Cedar LP'])
    expect(tables.lp_documents[0]).toMatchObject({ fund_id: 'f1', title: 'Q3 2026 report', scope: 'investor', mime_type: 'application/pdf', uploaded_by: 'u1' })
    expect(tables.lp_document_shares.map(s => s.lp_investor_id).sort()).toEqual(['i1', 'i2'])
  })

  it("refuses a path outside the fund's folder", async () => {
    const { admin } = seed()
    await expect(UPLOAD_HANDLERS.lp_add_document(ctx(admin), { storage_path: 'f2/1_x.pdf', title: 'X', file_name: 'x.pdf' })).rejects.toThrow('Invalid storage path')
  })
})
