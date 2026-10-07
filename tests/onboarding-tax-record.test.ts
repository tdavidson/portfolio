import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A tax form is recorded where it is verified — but tax-form records belong to the
 * tax-reporting domain, and the verify route to LP relations. The handler gates the extra part:
 * with tax-reporting write the record is written, linked to the document; without it the
 * verification stands and the response says the facts were not recorded. And a full TIN is
 * refused outright rather than truncated.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const loadAccessContext = vi.hoisted(() => vi.fn())
const hasAccess = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext, hasAccess }))
const emailLpReview = vi.hoisted(() => vi.fn(async () => ({ sent: true })))
vi.mock('@/lib/lp-onboarding-notify', () => ({ emailLpReview }))

import { PATCH } from '@/app/api/lps/onboarding/route'
import { parseTaxFormInput } from '@/lib/lp-onboarding-tax'

// Entity scope: these tests exercise the route's own rules, as a caller who sees every entity.
// The entity rule itself is tested in lib/access/lp-scope.test.ts.
const lpScope = vi.hoisted(() => ({ entityIds: null as string[] | null, investorIds: null as string[] | null }))
vi.mock('@/lib/access/lp-scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/access/lp-scope')>()),
  loadLpScope: async () => ({ scope: { vehicleNames: null } as any, entityIds: lpScope.entityIds, investorIds: lpScope.investorIds }),
}))


let inserted: Record<string, Record<string, unknown>[]> = {}
let upserted: Record<string, unknown>[] = []

function stub() {
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters[c] = v; return chain },
      maybeSingle: async () => {
        if (table === 'fund_members') return { data: { fund_id: 'fund-1', role: 'admin' }, error: null }
        if (table === 'lp_entities') return { data: filters.id === 'ent-1' && filters.fund_id === 'fund-1' ? { id: 'ent-1', entity_name: 'Acme', investor_id: 'inv-1' } : null, error: null }
        return { data: null, error: null }
      },
      insert: (row: Record<string, unknown>) => {
        ;(inserted[table] ??= []).push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'tax-1' }, error: null }) }) }
      },
      upsert: (row: Record<string, unknown>) => {
        if (table === 'lp_onboarding_items') upserted.push(row)
        else (inserted[table] ??= []).push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'item-1', status: row.status, document_id: 'doc-7' }, error: null }) }) }
      },
    }
    return chain
  })
}

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as any
const tax = { formType: 'w8ben', legalName: 'Hans Muster', tinType: 'foreign', tinLast4: '4321', country: 'Switzerland', treatyClaimed: true, signedDate: '2026-03-15' }

beforeEach(() => {
  vi.clearAllMocks()
  inserted = {}; upserted = []
  getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } })
  loadAccessContext.mockResolvedValue({ fundId: 'fund-1' })
  stub()
})

describe('PATCH /api/lps/onboarding verifying a tax form', () => {
  it('records the tax form, linked to the document, when the caller holds tax-reporting write', async () => {
    hasAccess.mockReturnValue(true)
    const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'tax_form', status: 'verified', tax }))
    expect(res.status).toBe(200)
    expect(hasAccess).toHaveBeenCalledWith(expect.anything(), 'lp_capital', 'write', 'tax_reporting')
    expect(upserted).toEqual([expect.objectContaining({ kind: 'tax_form', status: 'verified', reviewed_by: 'admin-1' })])
    expect(inserted.lp_tax_forms).toEqual([expect.objectContaining({
      fund_id: 'fund-1', lp_entity_id: 'ent-1', form_type: 'w8ben', legal_name: 'Hans Muster', tin_type: 'foreign', tin_last4: '4321',
      country: 'Switzerland', treaty_claimed: true, signed_date: '2026-03-15', expires_on: '2029-12-31', document_id: 'doc-7', created_by: 'admin-1',
    })])
    expect(await res.json()).toMatchObject({ ok: true, taxFormId: 'tax-1', taxSkipped: false })
  })

  it('still verifies, but does not record, without tax-reporting write', async () => {
    hasAccess.mockReturnValue(false)
    const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'tax_form', status: 'verified', tax }))
    expect(res.status).toBe(200)
    expect(upserted).toHaveLength(1)
    expect(inserted.lp_tax_forms).toBeUndefined()
    expect(await res.json()).toMatchObject({ ok: true, taxFormId: null, taxSkipped: true })
  })

  it('refuses a full TIN before anything is written', async () => {
    hasAccess.mockReturnValue(true)
    const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'tax_form', status: 'verified', tax: { ...tax, tinLast4: '123-45-6789' } }))
    expect(res.status).toBe(400)
    expect(upserted).toHaveLength(0)
    expect(inserted.lp_tax_forms).toBeUndefined()
  })

  it('emails the LP when an item is sent back, and writes the audit trail', async () => {
    hasAccess.mockReturnValue(true)
    const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'lpa_signature', status: 'rejected', note: 'Second signatory missing' }))
    expect(res.status).toBe(200)
    expect(emailLpReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fundId: 'fund-1', lpInvestorId: 'inv-1', lpEntityId: 'ent-1', kind: 'lpa_signature', note: 'Second signatory missing', sentBy: 'admin-1' }))
    expect(inserted.lp_onboarding_events).toEqual([expect.objectContaining({ action: 'rejected', to_status: 'rejected', note: 'Second signatory missing', actor_user_id: 'admin-1' })])
    expect(await res.json()).toMatchObject({ ok: true, lpEmailed: true })
  })

  it('ignores tax facts on anything but a verified tax form', async () => {
    hasAccess.mockReturnValue(true)
    await PATCH(req({ lp_entity_id: 'ent-1', kind: 'subscription_agreement', status: 'verified', tax }))
    await PATCH(req({ lp_entity_id: 'ent-1', kind: 'tax_form', status: 'rejected', note: 'Unsigned', tax }))
    expect(upserted).toHaveLength(2)
    expect(inserted.lp_tax_forms).toBeUndefined()
  })
})

describe('parseTaxFormInput', () => {
  it('proposes the W-8 expiry and keeps a W-9 open-ended', () => {
    const w8 = parseTaxFormInput({ formType: 'w8bene', signedDate: '2026-03-15' })
    expect(w8 && 'input' in w8 && w8.input.expiresOn).toBe('2029-12-31')
    const w9 = parseTaxFormInput({ formType: 'w9', signedDate: '2026-03-15' })
    expect(w9 && 'input' in w9 && w9.input.expiresOn).toBeNull()
  })
  it('honours an explicit expiry, and an explicit null', () => {
    const a = parseTaxFormInput({ formType: 'w8ben', signedDate: '2026-03-15', expiresOn: '2027-06-30' })
    expect(a && 'input' in a && a.input.expiresOn).toBe('2027-06-30')
    const b = parseTaxFormInput({ formType: 'w8ben', signedDate: '2026-03-15', expiresOn: null })
    expect(b && 'input' in b && b.input.expiresOn).toBeNull()
  })
  it('is null when nothing was sent, and an error for an unknown form', () => {
    expect(parseTaxFormInput(undefined)).toBeNull()
    const bad = parseTaxFormInput({ formType: '1099' })
    expect(bad && 'error' in bad).toBe(true)
  })
})
