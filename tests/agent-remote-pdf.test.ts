import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * A statement or letter attached to an LP email from chat (lp_send_item). The agent's function ships
 * no Chromium, so the renderer signs a report link for the acting admin and downloads the PDF from
 * app/api/agent/reports/[token], which renders it with the same function and arguments the send
 * route uses in-process — after re-checking the admin's access. A failure never sends the email
 * without its attachment.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'

const FUND = 'fund-1'
let access: AccessContext
const store = memoryAdmin()
const seed = () => {
  for (const k of Object.keys(store.tables)) delete store.tables[k]
  Object.assign(store.tables, {
    fund_members: [{ fund_id: FUND, user_id: 'u1', role: 'admin' }],
    funds: [{ id: FUND, name: 'Hemrock Fund I' }],
    fund_settings: [{ fund_id: FUND, lp_portal_enabled: true }],
    lp_investors: [
      { id: 'iA', fund_id: FUND, name: 'Alpha Family' },
      { id: 'iB', fund_id: FUND, name: 'Beta LLC' },
      { id: 'iC', fund_id: FUND, name: 'Gamma Trust' },
      { id: 'iX', fund_id: 'fund-2', name: 'Elsewhere' },
    ],
    lp_snapshots: [{ id: 'snap-1', fund_id: FUND, name: 'Q3 2026 Report' }],
    lp_snapshot_shares: [
      { snapshot_id: 'snap-1', fund_id: FUND, lp_investor_id: 'iA' },
      { snapshot_id: 'snap-1', fund_id: FUND, lp_investor_id: 'iB' },
      { snapshot_id: 'snap-1', fund_id: FUND, lp_investor_id: 'iC' },
    ],
    lp_letters: [{ id: 'let-1', fund_id: FUND, period_label: 'Q3 2026', status: 'final', portfolio_group: 'Fund I' }],
    lp_letter_shares: [{ letter_id: 'let-1', fund_id: FUND, lp_investor_id: 'iA' }],
  })
}

const m = vi.hoisted(() => ({
  snapshotPdf: vi.fn(),
  letterPdf: vi.fn(),
  rateLimit: vi.fn(),
  sendOutboundEmail: vi.fn(),
  getOutboundConfig: vi.fn(),
  resolveLpRecipients: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (...a: unknown[]) => m.rateLimit(...a) }))
vi.mock('@/lib/access/effective', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => access,
}))
vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) => ({ access: a, vehicleNames: a.vehicles.all ? null : ['Fund I'], companyIds: null }),
}))
vi.mock('@/lib/lp-report-pdf', () => ({
  generateInvestorReportPdf: (...a: unknown[]) => m.snapshotPdf(...a),
  generateLetterPdf: (...a: unknown[]) => m.letterPdf(...a),
  generateLiveInvestorReportPdf: async () => null,
}))
vi.mock('@/lib/email', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  getOutboundConfig: m.getOutboundConfig,
  sendOutboundEmail: m.sendOutboundEmail,
}))
vi.mock('@/lib/lp-recipients', () => ({ resolveLpRecipients: m.resolveLpRecipients }))

import { GET } from '@/app/api/agent/reports/[token]/route'
import { verifyReportLink } from '@/lib/agent/report-links'
import { dispositionFileName, remotePdfRenderers, SEND_ATTACHMENT_PURPOSE } from '@/lib/agent/remote-pdf'
import { getTool } from '@/lib/accounting/agent-tools'

const admin = (grants: Partial<Record<Domain, AccessLevel>> = { lp_capital: 'write', lp_relations: 'write' }): AccessContext => ({
  fundId: FUND, userId: 'u1', vehicles: { all: true, ids: [] }, role: 'admin',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

/** fetch, answered by the reports route itself: the renderer's request end to end. */
const viaRoute = vi.fn(async (url: string) => {
  const token = url.split('/').pop()!
  return GET(new NextRequest(url), { params: Promise.resolve({ token }) })
})

const tokenOf = (url: string) => verifyReportLink(url.split('/').pop()!)

beforeEach(() => {
  seed()
  access = admin()
  vi.clearAllMocks()
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  m.rateLimit.mockResolvedValue(null)
  m.snapshotPdf.mockImplementation(async (_a: unknown, o: { investorIds: string[] }) =>
    ({ pdf: Buffer.from(`%PDF-${o.investorIds.join('+')}`), fileName: 'Alpha Family - Q3 2026 Report.pdf' }))
  m.letterPdf.mockResolvedValue({ pdf: Buffer.from('%PDF-letter'), fileName: 'Hemrock Fund I - Q3 2026.pdf' })
  m.getOutboundConfig.mockResolvedValue({ provider: 'resend' })
  m.sendOutboundEmail.mockResolvedValue({ id: 'msg-1' })
})

describe('the remote renderer', () => {
  it("signs a snapshot link for the acting member with one recipient's investors, and returns what the route renders", async () => {
    const r = remotePdfRenderers({ userId: 'u1', origin: 'https://fund.test/', fetch: viaRoute as any })
    const out = await r.snapshotPdf(store.admin, { fundId: FUND, snapshotId: 'snap-1', investorIds: ['iA', 'iB'] })
    expect(out).toEqual({ pdf: Buffer.from('%PDF-iA+iB'), fileName: 'Alpha Family - Q3 2026 Report.pdf' })
    const url = viaRoute.mock.calls[0][0]
    expect(url.startsWith('https://fund.test/api/agent/reports/')).toBe(true)
    expect(tokenOf(url)).toMatchObject({
      fundId: FUND, userId: 'u1', kind: 'lp_snapshot', args: { snapshot: 'snap-1', investors: ['iA', 'iB'], for: SEND_ATTACHMENT_PURPOSE },
    })
    // The same render, with the same arguments, as the send route's in-process renderer.
    expect(m.snapshotPdf).toHaveBeenCalledWith(store.admin, { fundId: FUND, snapshotId: 'snap-1', investorIds: ['iA', 'iB'] })
  })

  it('signs a letter link, and returns the letter as the send route would attach it', async () => {
    const r = remotePdfRenderers({ userId: 'u1', origin: 'https://fund.test', fetch: viaRoute as any })
    const out = await r.letterPdf(store.admin, { fundId: FUND, letterId: 'let-1' })
    expect(out).toEqual({ pdf: Buffer.from('%PDF-letter'), fileName: 'Hemrock Fund I - Q3 2026.pdf' })
    expect(tokenOf(viaRoute.mock.calls[0][0])).toMatchObject({ kind: 'lp_letter', args: { letter: 'let-1', for: SEND_ATTACHMENT_PURPOSE } })
    expect(m.letterPdf).toHaveBeenCalledWith(store.admin, { fundId: FUND, letterId: 'let-1' })
  })

  it('renders nothing for no investors, as the in-process renderer does', async () => {
    const r = remotePdfRenderers({ userId: 'u1', fetch: viaRoute as any })
    expect(await r.snapshotPdf(store.admin, { fundId: FUND, snapshotId: 'snap-1', investorIds: [] })).toBeNull()
    expect(viaRoute).not.toHaveBeenCalled()
  })

  it('carries the deployment-protection bypass when the platform provides one', async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bypass-1'
    const f = vi.fn(async () => new Response(Buffer.from('%PDF'), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="a.pdf"' } }))
    await remotePdfRenderers({ userId: 'u1', origin: 'https://fund.test', fetch: f as any }).letterPdf(store.admin, { fundId: FUND, letterId: 'let-1' })
    expect((f.mock.calls[0] as any)[1].headers).toMatchObject({ 'x-vercel-protection-bypass': 'bypass-1' })
  })

  it('throws, with the route\'s words, when the member has left the fund, the render fails, or the route is unreachable', async () => {
    store.tables.fund_members = []
    const r = remotePdfRenderers({ userId: 'u1', fetch: viaRoute as any })
    await expect(r.snapshotPdf(store.admin, { fundId: FUND, snapshotId: 'snap-1', investorIds: ['iA'] }))
      .rejects.toThrow('Could not render the statement attachment (HTTP 404: This link is not available to you.)')
    expect(m.snapshotPdf).not.toHaveBeenCalled()

    seed()
    m.letterPdf.mockRejectedValue(new Error('Chromium missing'))
    await expect(r.letterPdf(store.admin, { fundId: FUND, letterId: 'let-1' })).rejects.toThrow(/HTTP 500: This document could not be generated/)

    const down = remotePdfRenderers({ userId: 'u1', fetch: (async () => { throw new Error('ECONNREFUSED') }) as any })
    await expect(down.letterPdf(store.admin, { fundId: FUND, letterId: 'let-1' })).rejects.toThrow('Could not reach the PDF renderer for the letter attachment: ECONNREFUSED.')

    const html = remotePdfRenderers({ userId: 'u1', fetch: (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as any })
    await expect(html.letterPdf(store.admin, { fundId: FUND, letterId: 'let-1' })).rejects.toThrow(/not a PDF/)
    expect(r.errors).toHaveLength(2)
  })

  it("refuses an investor of another fund, even inside a genuine link's list", async () => {
    const r = remotePdfRenderers({ userId: 'u1', fetch: viaRoute as any })
    await expect(r.snapshotPdf(store.admin, { fundId: FUND, snapshotId: 'snap-1', investorIds: ['iA', 'iX'] })).rejects.toThrow(/HTTP 404/)
    expect(m.snapshotPdf).not.toHaveBeenCalled()
  })

  it('rate-limits attachment renders in their own bucket, apart from links a person clicks', async () => {
    const r = remotePdfRenderers({ userId: 'u1', fetch: viaRoute as any })
    await r.letterPdf(store.admin, { fundId: FUND, letterId: 'let-1' })
    expect(m.rateLimit).toHaveBeenLastCalledWith({ key: 'agent-report-send:u1', limit: 300, windowSeconds: 60 })
  })

  it('reads the file name from Content-Disposition', () => {
    expect(dispositionFileName('inline; filename="Alpha - Q3.pdf"')).toBe('Alpha - Q3.pdf')
    expect(dispositionFileName("attachment; filename*=UTF-8''Fund%20I.pdf")).toBe('Fund I.pdf')
    expect(dispositionFileName(null)).toBeNull()
  })
})

describe('lp_send_item with a rendered attachment', () => {
  const groupA = { primaryAccountId: 'acA', primaryEmail: 'a@alpha.example', primaryName: 'Ann', investorIds: ['iA', 'iB'], ccEmails: [] }
  const groupC = { primaryAccountId: 'acC', primaryEmail: 'c@gamma.example', primaryName: 'Cy', investorIds: ['iC'], ccEmails: ['cpa@gamma.example'] }
  const ctx = () => ({ admin: store.admin, fundId: FUND, portfolioGroup: '', userId: 'u1', access, origin: 'https://fund.test' }) as any

  beforeEach(() => {
    m.resolveLpRecipients.mockResolvedValue([groupA, groupC])
    vi.stubGlobal('fetch', viaRoute)
  })

  it('previews the recipients and the attachment name, and renders and sends nothing', async () => {
    const out = await getTool('lp_send_item')!.handler(ctx(), { kind: 'letter', id: 'let-1', delivery: 'attachment', preview: true })
    expect(out).toMatchObject({ preview: true, attachment: true, attachment_name: 'Hemrock Fund I - Q3 2026.pdf' })
    const snap = await getTool('lp_send_item')!.handler(ctx(), { kind: 'snapshot', id: 'snap-1', delivery: 'both', preview: true })
    expect(snap.attachment_name).toBe('<investor name> - Q3 2026 Report.pdf')
    expect(viaRoute).not.toHaveBeenCalled()
    expect(m.sendOutboundEmail).not.toHaveBeenCalled()
  })

  it("attaches each recipient's own statement, rendered for exactly their investors", async () => {
    const out = await getTool('lp_send_item')!.handler(ctx(), { kind: 'snapshot', id: 'snap-1', delivery: 'attachment' })
    expect(out).toMatchObject({ ok: true, sent: 2, failures: [] })
    expect(out.attachment_errors).toBeUndefined()
    const sent = m.sendOutboundEmail.mock.calls.map(c => c[1])
    expect(sent.map(s => [s.to, s.attachments[0].content.toString()])).toEqual(expect.arrayContaining([
      ['a@alpha.example', '%PDF-iA+iB'], ['c@gamma.example', '%PDF-iC'],
    ]))
    expect(sent[0].attachments[0]).toMatchObject({ filename: 'Alpha Family - Q3 2026 Report.pdf', contentType: 'application/pdf' })
  })

  it('does not email a recipient whose statement could not be rendered, and says why', async () => {
    m.snapshotPdf.mockImplementation(async (_a: unknown, o: { investorIds: string[] }) => {
      if (o.investorIds.includes('iC')) throw new Error('render failed')
      return { pdf: Buffer.from('%PDF'), fileName: 'Alpha Family - Q3 2026 Report.pdf' }
    })
    const out = await getTool('lp_send_item')!.handler(ctx(), { kind: 'snapshot', id: 'snap-1', delivery: 'both' })
    expect(out).toMatchObject({ sent: 1, failures: ['c@gamma.example'] })
    expect(out.attachment_errors[0]).toMatch(/Could not render the statement attachment \(HTTP 500/)
    expect(m.sendOutboundEmail.mock.calls.map(c => c[1].to)).toEqual(['a@alpha.example'])
  })

  it('refuses a letter send whose PDF could not be rendered, with the reason', async () => {
    m.letterPdf.mockResolvedValue(null)
    await expect(getTool('lp_send_item')!.handler(ctx(), { kind: 'letter', id: 'let-1', delivery: 'attachment' }))
      .rejects.toThrow(/Could not prepare the attachment.*Could not render the letter attachment \(HTTP 404/)
    expect(m.sendOutboundEmail).not.toHaveBeenCalled()
  })
})
