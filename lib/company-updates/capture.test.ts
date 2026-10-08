import { describe, expect, it } from 'vitest'
import { captureCompanyUpdate, loadStoredInboundEmail, updateCompanyUpdatePeriod } from './capture'
import { BODY_CLEANER_VERSION, CAPTURE_VERSION } from './extraction'
import type { PostmarkPayload } from '@/lib/pipeline/processEmail'

describe('Company Update dual-write capture', () => {
  it('uses canonical email metadata and stable attachment identities for duplicate filenames', async () => {
    const emailId = '11111111-1111-4111-8111-111111111111'
    const first = Buffer.from('first attachment evidence')
    const second = Buffer.from('second attachment evidence')
    const canonicalPayload: PostmarkPayload = {
      From: 'canonical@acme.test',
      FromFull: { Email: 'canonical@acme.test', Name: 'Canonical Sender' },
      To: 'updates@fund.test',
      Subject: 'Canonical payload subject',
      TextBody: 'Canonical stored body',
      Attachments: [
        { Name: 'update.txt', ContentType: 'text/plain', ContentLength: first.length, StoragePath: `${emailId}/0_update.txt` },
        { Name: 'update.txt', ContentType: 'text/plain', ContentLength: second.length, StoragePath: `${emailId}/1_update.txt` },
      ],
    }
    const db = fakeDatabase({
      id: emailId,
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'canonical@acme.test',
      subject: 'Canonical database subject',
      received_at: '2026-09-02T14:00:00.000Z',
      routed_to: 'reporting',
      raw_payload: canonicalPayload,
    })
    const runtimePayload: PostmarkPayload = {
      ...canonicalPayload,
      From: 'untrusted-runtime@wrong.test',
      Subject: 'Untrusted runtime subject',
      TextBody: 'Untrusted runtime body',
      Attachments: [
        { Name: 'update.txt', ContentType: 'text/plain', ContentLength: first.length, Content: first.toString('base64') },
        { Name: 'update.txt', ContentType: 'text/plain', ContentLength: second.length, Content: second.toString('base64') },
      ],
    }

    const result = await captureCompanyUpdate(db.client, {
      emailId,
      fundId: 'fund-1',
      companyId: 'company-1',
      payload: runtimePayload,
    })

    expect(result?.updateId).toBe('update-1')
    expect(db.replaceCalls).toHaveLength(1)
    const call = db.replaceCalls[0]
    // Every write goes through ONE atomic RPC, scoped by the fund the caller resolved.
    expect(call.p_fund_id).toBe('fund-1')
    expect(call.p_update).toMatchObject({
      company_id: 'company-1',
      source_email_id: emailId,
      subject: 'Canonical database subject',
      received_at: '2026-09-02T14:00:00.000Z',
      sender_email: 'canonical@acme.test',
      sender_name: 'Canonical Sender',
      body_original: 'Canonical stored body',
      extraction_status: 'complete',
      parser_version: CAPTURE_VERSION,
    })
    expect(call.p_artifacts.map((artifact: any) => ({
      key: artifact.attachment_key,
      ordinal: artifact.ordinal,
      text: artifact.extracted_text,
      ocr: artifact.ocr_status,
    }))).toEqual([
      { key: `storage:${emailId}/0_update.txt`, ordinal: 0, text: 'first attachment evidence', ocr: 'not_needed' },
      { key: `storage:${emailId}/1_update.txt`, ordinal: 1, text: 'second attachment evidence', ocr: 'not_needed' },
    ])
    // Each artifact carries a title chunk (weight A) ahead of its content chunks.
    expect(call.p_artifacts[0].chunks.map((chunk: any) => chunk.chunk_kind)).toEqual(['artifact_title', 'attachment'])
    expect(call.p_artifacts[0].chunks[0].content).toBe('update.txt')
    // The subject is its own searchable chunk, then the current message. The original adds nothing
    // here (no quoted history beyond the current message), so it is not indexed a second time.
    expect(call.p_body_chunks.map((chunk: any) => chunk.chunk_kind)).toEqual(['subject', 'body_current'])
    expect(call.p_body_chunks[0].content).toBe('Canonical database subject')
    expect(call.p_body_chunks.every((chunk: any) => chunk.parser_version === BODY_CLEANER_VERSION)).toBe(true)
    expect(result?.artifacts.map(a => a.id)).toEqual(['artifact-0', 'artifact-1'])
  })

  it('removes an existing projection instead of capturing a non-reporting route', async () => {
    const db = fakeDatabase({
      id: 'email-2',
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'sender@acme.test',
      subject: null,
      received_at: '2026-09-02T14:00:00.000Z',
      routed_to: 'interactions',
      raw_payload: null,
    })

    const result = await captureCompanyUpdate(db.client, {
      emailId: 'email-2',
      fundId: 'fund-1',
      companyId: 'company-1',
      payload: { From: 'sender@acme.test', To: 'fund@test' },
    })

    expect(result).toBeNull()
    expect(db.replaceCalls).toHaveLength(0)
    expect(db.deletes).toContainEqual(expect.objectContaining({
      table: 'company_updates',
      filters: [['source_email_id', 'email-2'], ['fund_id', 'fund-1']],
    }))
  })

  it('treats a legacy email with no route as portfolio reporting', async () => {
    const db = fakeDatabase({
      id: 'email-legacy',
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'sender@acme.test',
      subject: 'Legacy',
      received_at: '2025-01-02T14:00:00.000Z',
      routed_to: null,
      raw_payload: { From: 'sender@acme.test', To: 'fund@test', TextBody: 'Old update' },
    })

    const result = await captureCompanyUpdate(db.client, {
      emailId: 'email-legacy',
      fundId: 'fund-1',
      companyId: 'company-1',
      payload: { From: 'sender@acme.test', To: 'fund@test', TextBody: 'Old update' },
    })

    expect(result?.updateId).toBe('update-1')
    expect(db.deletes).toHaveLength(0)
  })

  it('refuses to capture under a company the source email is not assigned to', async () => {
    const db = fakeDatabase({
      id: 'email-3',
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'sender@acme.test',
      subject: 'Update',
      received_at: '2026-09-02T14:00:00.000Z',
      routed_to: 'reporting',
      raw_payload: null,
    })

    await expect(captureCompanyUpdate(db.client, {
      emailId: 'email-3',
      fundId: 'fund-1',
      companyId: 'company-other',
      payload: { From: 'sender@acme.test', To: 'fund@test' },
    })).rejects.toThrow(/not assigned to company company-other/)
    expect(db.replaceCalls).toHaveLength(0)
  })

  it('persists the source error for an attachment whose unsafe bytes were refused storage', async () => {
    const attachment = {
      Name: 'unsafe.pdf',
      ContentType: 'application/pdf',
      ContentLength: 123,
      ContentError: 'Safety scan failed: executable content detected',
    }
    const db = fakeDatabase({
      id: 'email-unsafe',
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'sender@acme.test',
      subject: 'Update',
      received_at: '2026-09-02T14:00:00.000Z',
      routed_to: 'reporting',
      raw_payload: { From: 'sender@acme.test', To: 'fund@test', Attachments: [attachment] },
    })

    const result = await captureCompanyUpdate(db.client, {
      emailId: 'email-unsafe',
      fundId: 'fund-1',
      companyId: 'company-1',
      payload: { From: 'sender@acme.test', To: 'fund@test', Attachments: [attachment] },
    })

    expect(db.replaceCalls[0].p_artifacts[0]).toMatchObject({
      ordinal: 0,
      filename: 'unsafe.pdf',
      extraction_status: 'failed',
      extraction_error: attachment.ContentError,
      warnings: [attachment.ContentError],
    })
    // The body was fine, so the update is partial (some usable content), never silently complete.
    expect(db.replaceCalls[0].p_update.extraction_status).toBe('partial')
    expect(db.replaceCalls[0].p_update.warnings).toEqual([`unsafe.pdf: ${attachment.ContentError}`])
    expect(result?.extractionStatus).toBe('partial')
  })

  it('queues OCR for an image attachment rather than treating it as empty', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const attachment = { Name: 'chart.png', ContentType: 'image/png', ContentLength: png.length, Content: png.toString('base64') }
    const db = fakeDatabase({
      id: 'email-img',
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'sender@acme.test',
      subject: 'Update',
      received_at: '2026-09-02T14:00:00.000Z',
      routed_to: 'reporting',
      raw_payload: { From: 'sender@acme.test', To: 'fund@test', TextBody: 'See chart', Attachments: [attachment] },
    })

    await captureCompanyUpdate(db.client, {
      emailId: 'email-img',
      fundId: 'fund-1',
      companyId: 'company-1',
      payload: { From: 'sender@acme.test', To: 'fund@test', TextBody: 'See chart', Attachments: [attachment] },
    })

    expect(db.replaceCalls[0].p_artifacts[0]).toMatchObject({
      filename: 'chart.png',
      extraction_status: 'not_applicable',
      ocr_status: 'pending',
    })
  })

  it('surfaces an RPC failure instead of returning a phantom update id', async () => {
    const db = fakeDatabase({
      id: 'email-4',
      fund_id: 'fund-1',
      company_id: 'company-1',
      from_address: 'sender@acme.test',
      subject: 'Update',
      received_at: '2026-09-02T14:00:00.000Z',
      routed_to: 'reporting',
      raw_payload: null,
    }, { rpcError: 'Source email email-4 is routed to deals, not portfolio reporting' })

    await expect(captureCompanyUpdate(db.client, {
      emailId: 'email-4',
      fundId: 'fund-1',
      companyId: 'company-1',
      payload: { From: 'sender@acme.test', To: 'fund@test' },
    })).rejects.toThrow(/routed to deals/)
  })

  it('copies only sufficiently reliable periods from the existing metric result', async () => {
    const db = fakeDatabase(null)
    await updateCompanyUpdatePeriod(db.client, {
      emailId: 'email-3',
      fundId: 'fund-1',
      period: { label: 'Q2 2026', year: 2026, quarter: 2, month: null, confidence: 'medium' },
    })
    await updateCompanyUpdatePeriod(db.client, {
      emailId: 'email-3',
      fundId: 'fund-1',
      period: { label: 'Unknown', year: 2026, quarter: null, month: null, confidence: 'low' },
    })

    expect(db.periodUpdates).toHaveLength(1)
    expect(db.periodUpdates[0].row).toMatchObject({
      period_label: 'Q2 2026',
      period_year: 2026,
      period_quarter: 2,
      period_source: 'configured_metric_extraction',
    })
    expect(db.periodUpdates[0].filters).toEqual([
      ['source_email_id', 'email-3'],
      ['fund_id', 'fund-1'],
    ])
  })
})

export function fakeDatabase(
  inboundEmail: Record<string, unknown> | null,
  options: { rpcError?: string } = {},
) {
  const replaceCalls: any[] = []
  const deletes: Array<{ table: string; filters: Array<[string, unknown]> }> = []
  const periodUpdates: Array<{ row: any; filters: Array<[string, unknown]> }> = []

  const client = {
    async rpc(name: string, args: any) {
      if (name !== 'company_update_replace') throw new Error(`Unexpected rpc ${name}`)
      if (options.rpcError) return { data: null, error: { message: options.rpcError } }
      replaceCalls.push(args)
      const artifacts = Object.fromEntries(
        (args.p_artifacts as any[]).map((artifact, index) => [artifact.attachment_key, `artifact-${index}`]),
      )
      return { data: { update_id: 'update-1', artifacts }, error: null }
    },
    from(table: string) {
      if (table === 'inbound_emails') {
        return {
          select() {
            return chain({ data: inboundEmail, error: null })
          },
        }
      }
      if (table === 'company_updates') {
        return {
          delete() {
            const entry = { table, filters: [] as Array<[string, unknown]> }
            deletes.push(entry)
            return chain({ data: null, error: null }, entry.filters)
          },
          update(row: any) {
            const entry = { row, filters: [] as Array<[string, unknown]> }
            periodUpdates.push(entry)
            return chain({ data: null, error: null }, entry.filters)
          },
        }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }

  return { client, replaceCalls, deletes, periodUpdates }
}

function chain(result: any, filters: Array<[string, unknown]> = []) {
  const query: any = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return query
    },
    is: (column: string, value: unknown) => {
      filters.push([column, value])
      return query
    },
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: (value: any) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return query
}

describe('loadStoredInboundEmail fallback', () => {
  it('rebuilds the payload without attachment bytes when the full row cannot be served', async () => {
    const selects: string[] = []
    const client = {
      rpc: async () => ({ data: null, error: null }),
      from(table: string) {
        if (table !== 'inbound_emails') throw new Error(`unexpected table ${table}`)
        return {
          select(cols: string) {
            selects.push(cols)
            const q: any = { eq: () => q }
            q.maybeSingle = async () => {
              if (cols.includes('raw_payload') && !cols.includes('->')) {
                return { data: null, error: { message: 'canceling statement due to statement timeout' } }
              }
              if (cols.startsWith('Name:')) {
                return { data: { Name: 'huge.pdf', ContentType: 'application/pdf', ContentLength: 38_101_605, StoragePath: null, ContentError: null }, error: null }
              }
              return {
                data: {
                  id: 'e1', fund_id: 'fund-1', company_id: 'company-1', from_address: 'a@b.test', subject: 'Big one',
                  received_at: '2026-02-28T12:50:09Z', routed_to: 'reporting', attachments_count: 1,
                  p_From: 'Ada <a@b.test>', p_To: 'f@fund.test', p_TextBody: 'Body survives', p_FromFull: { Email: 'a@b.test', Name: 'Ada' },
                },
                error: null,
              }
            }
            return q
          },
        }
      },
    }
    const email = await loadStoredInboundEmail(client as any, { emailId: 'e1', fundId: 'fund-1' })
    expect(email.raw_payload?.TextBody).toBe('Body survives')
    expect(email.raw_payload?.FromFull).toEqual({ Email: 'a@b.test', Name: 'Ada' })
    expect(email.raw_payload?.Attachments).toEqual([
      expect.objectContaining({ Name: 'huge.pdf', ContentLength: 38_101_605, ContentError: expect.stringMatching(/too large to load/) }),
    ])
    expect(selects.some(s => s.includes('raw_payload->Attachments->0->Name'))).toBe(true)
  })

  it('does not fall back on errors other than a timeout', async () => {
    const client = {
      rpc: async () => ({ data: null, error: null }),
      from: () => ({ select: () => { const q: any = { eq: () => q, maybeSingle: async () => ({ data: null, error: { message: 'permission denied' } }) }; return q } }),
    }
    await expect(loadStoredInboundEmail(client as any, { emailId: 'e1', fundId: 'fund-1' })).rejects.toThrow(/permission denied/)
  })
})
