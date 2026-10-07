import { describe, expect, it } from 'vitest'
import { buildRecentUpdatesBlock, getUpdates, window } from './analyst'
import { SearchParamsError } from './search'

const FUND = '00000000-0000-4000-8000-000000000001'
const COMPANY = '00000000-0000-4000-8000-000000000002'
const U1 = '00000000-0000-4000-8000-000000000011'
const U2 = '00000000-0000-4000-8000-000000000012'
const A1 = '00000000-0000-4000-8000-000000000021'

/** A fake admin: the search RPC answers from `hits`; tables answer from `updates`/`artifacts`. */
function fakeAdmin(options: { hits?: any[]; total?: number; updates?: Record<string, any>; artifacts?: Record<string, any>; onRpc?: (args: any) => void } = {}) {
  const tableQuery = (rows: any[]) => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, or: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: any, reject: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return q
  }
  return {
    rpc: async (_name: string, args: any) => {
      options.onRpc?.(args)
      return { data: { total: options.total ?? (options.hits ?? []).length, results: options.hits ?? [], next_cursor: null, match_mode: args.p_query ? 'lexical' : 'none', order: args.p_query ? 'relevance' : 'newest' }, error: null }
    },
    from: (table: string) => {
      if (table === 'company_updates') {
        return { select: () => ({ eq: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: options.updates?.[id] ?? null, error: null }) }) }) }) }
      }
      if (table === 'company_update_artifacts') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: options.artifacts?.[id] ?? null, error: null }) }),
              in: (_c: string, ids: string[]) => tableQuery(Object.values(options.artifacts ?? {}).filter((a: any) => ids.includes(a.update_id))),
            }),
          }),
        }
      }
      if (table === 'company_update_chunks') return { select: () => tableQuery([]) }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const hit = (id: string, over: Partial<any> = {}) => ({
  update_id: id, company_id: COMPANY, company_name: 'Acme', source_email_id: 'e1', received_at: '2026-08-04T09:12:00Z',
  subject: 'July update', sender_name: 'Ada', sender_email: 'ada@example.test', forwarded_sender_name: null, forwarded_sender_email: null,
  period_label: 'Jul 2026', period_source: 'configured_metric_extraction', extraction_status: 'complete', warnings: [], rank: 0.5,
  excerpts: [{ chunk_id: 'c', artifact_id: A1, filename: 'deck.pdf', chunk_kind: 'attachment', ordinal: 3, locator: { page: 4 }, text: 'Customer [[retention]] rose to 96 percent' }],
  artifacts: [{ id: A1, ordinal: 0, filename: 'deck.pdf', extraction_status: 'complete', ocr_status: 'not_needed' }],
  ...over,
})

describe('get_updates', () => {
  it('search mode returns exact totals, excerpts with locators, and source identifiers', async () => {
    let rpcArgs: any
    const admin = fakeAdmin({ hits: [hit(U1)], total: 7, onRpc: args => { rpcArgs = args } })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, resolveCompanyId: async () => COMPANY, visibleCompanyIds: null }, { company: 'Acme', query: 'retention', since: '2026-01-01' })
    expect(rpcArgs).toMatchObject({ p_fund_id: FUND, p_company_ids: [COMPANY], p_query: 'retention', p_since: '2026-01-01', p_latest_per_company: false })
    expect(result).toMatchObject({ mode: 'search', match_mode: 'lexical', exact_total: 7, returned: 1, has_more: false, budget_truncated: false })
    expect(result.results[0]).toMatchObject({ update_id: U1, source_email_id: 'e1', sender: 'Ada <ada@example.test>', period_label: 'Jul 2026' })
    expect(result.results[0].excerpts?.[0]).toMatchObject({ artifact_id: A1, filename: 'deck.pdf', locator: { page: 4 } })
    expect(result.notes.join(' ')).toMatch(/Excerpts are matched passages/)
  })

  it('latest_per_company sets the flag and says older matches are excluded', async () => {
    let rpcArgs: any
    const admin = fakeAdmin({ hits: [hit(U1), hit(U2, { company_id: 'other', company_name: 'Globex' })], onRpc: args => { rpcArgs = args } })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: null }, { mode: 'latest_per_company', query: 'runway' })
    expect(rpcArgs.p_latest_per_company).toBe(true)
    expect(rpcArgs.p_limit).toBe(50)
    expect(result.notes.join(' ')).toMatch(/only its most recent update/)
  })

  it('search mode without a query is an explicit error, not an empty success', async () => {
    await expect(getUpdates({ admin: fakeAdmin() as any, fundId: FUND, visibleCompanyIds: null }, { mode: 'search' })).rejects.toThrow(SearchParamsError)
  })

  it('surfaces partial extraction so absence of text is not read as absence of content', async () => {
    const admin = fakeAdmin({ hits: [hit(U1, { extraction_status: 'partial', warnings: ['deck.pdf: PDF pages requiring OCR: 2, 3.'] })] })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: null }, { query: 'churn' })
    expect(result.results[0].warnings[0]).toMatch(/requiring OCR/)
    expect(result.notes.join(' ')).toMatch(/could not be fully read/)
  })

  it('applies the character budget to excerpts and marks the truncation', async () => {
    const admin = fakeAdmin({ hits: [hit(U1, { excerpts: [{ chunk_id: 'c', artifact_id: null, filename: null, chunk_kind: 'body_current', ordinal: 0, locator: {}, text: 'x'.repeat(2_000) }] }), hit(U2)] })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: null }, { query: 'x', max_chars: 600 })
    expect(result.budget_truncated).toBe(true)
    expect(result.results[0].excerpts?.[0].text.length).toBeLessThanOrEqual(600)
    expect(result.results[1].excerpts).toEqual([])
    expect(result.notes.join(' ')).toMatch(/shortened to fit 600/)
  })

  it('fetches full bodies and artifact text by id under the budget, marking what was cut', async () => {
    const admin = fakeAdmin({
      updates: {
        [U1]: { id: U1, company_id: COMPANY, source_email_id: 'e1', received_at: '2026-08-04T09:12:00Z', subject: 'July', body_current: 'Body text here.', body_original: 'Body text here.', body_cleaning_status: 'complete', body_status: 'complete', extraction_status: 'complete', warnings: [], updated_at: 'x', companies: { name: 'Acme' } },
      },
      artifacts: {
        [A1]: { id: A1, update_id: U1, ordinal: 0, filename: 'deck.pdf', extraction_status: 'complete', warnings: [], metadata: {}, ocr_status: 'not_needed', storage_path: 'e1/0_deck.pdf', extracted_text: 'Page one. '.repeat(400) },
      },
    })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: null }, { ids: [U1], max_chars: 1_000 })
    expect(result.mode).toBe('by_id')
    expect(result.results[0].body).toMatchObject({ text: 'Body text here.', complete: true, omitted_chars: 0 })
    const art = result.results[0].artifact_text![0]
    expect(art.artifact_id).toBe(A1)
    expect(art.window.complete).toBe(false)
    expect(art.window.omitted_chars).toBeGreaterThan(0)
    expect(art.window.next_offset).toBeGreaterThan(0)
    expect(result.budget_truncated).toBe(true)
    expect(result.notes.join(' ')).toMatch(/artifact: \{ id, offset \}/)
  })

  it('reports an id that is not in the fund instead of silently dropping it', async () => {
    const result = await getUpdates({ admin: fakeAdmin() as any, fundId: FUND, visibleCompanyIds: null }, { ids: [U2] })
    expect(result.returned).toBe(0)
    expect(result.notes[0]).toMatch(/not found in this fund/)
  })

  it('pages through one artifact with offset windows', async () => {
    const admin = fakeAdmin({ artifacts: { [A1]: { id: A1, update_id: U1, ordinal: 0, filename: 'deck.pdf', extraction_status: 'partial', warnings: ['PDF pages requiring OCR: 2.'], metadata: {}, ocr_status: 'pending', storage_path: null, extracted_text: 'abcdefghij'.repeat(100) } } })
    const first = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: null }, { artifact: { id: A1 }, max_chars: 500 })
    expect(first.artifact?.window).toMatchObject({ complete: false, total_chars: 1_000 })
    expect(first.has_more).toBe(true)
    const second = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: null }, { artifact: { id: A1, offset: first.artifact!.window.next_offset }, max_chars: 500 })
    expect(second.artifact!.window.text.length + first.artifact!.window.text.length).toBe(1_000)
    expect(second.has_more).toBe(false)
    expect(first.notes.join(' ')).toMatch(/could not be fully read/)
  })
})

describe('get_updates — only the caller\'s companies', () => {
  const OTHER = '00000000-0000-4000-8000-000000000003'
  const update = { id: U1, fund_id: FUND, company_id: COMPANY, company_name: 'Acme', source_email_id: 'e1', received_at: '2026-08-04', subject: 's', body_original: 'Secret body.', body_current: null, extraction_status: 'complete', warnings: [], artifacts: [] }
  const artifact = { id: A1, update_id: U1, ordinal: 0, filename: 'deck.pdf', extraction_status: 'complete', warnings: [], metadata: {}, ocr_status: 'not_needed', storage_path: null, extracted_text: 'Secret deck.' }

  it('browsing and searching without a company cover only their companies', async () => {
    let rpcArgs: any
    const admin = fakeAdmin({ hits: [], onRpc: args => { rpcArgs = args } })
    await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: [OTHER] }, { mode: 'latest_per_company' })
    expect(rpcArgs.p_company_ids).toEqual([OTHER])
  })
  it('a caller who sees no company gets nothing, without a search', async () => {
    let called = false
    const admin = fakeAdmin({ hits: [hit(U1)], onRpc: () => { called = true } })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: [] }, { query: 'retention' })
    expect(result.returned).toBe(0)
    expect(called).toBe(false)
  })
  it('an update by id on a company they cannot see is not found', async () => {
    const admin = fakeAdmin({ updates: { [U1]: update } })
    const result = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: [OTHER] }, { ids: [U1] })
    expect(result.returned).toBe(0)
    expect(JSON.stringify(result)).not.toContain('Secret')
  })
  it('an attachment of an update on a company they cannot see is not found', async () => {
    const admin = fakeAdmin({ updates: { [U1]: update }, artifacts: { [A1]: artifact } })
    await expect(getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: [OTHER] }, { artifact: { id: A1 } })).rejects.toThrow(/not found/)
    const mine = await getUpdates({ admin: admin as any, fundId: FUND, visibleCompanyIds: [COMPANY] }, { artifact: { id: A1 } })
    expect(mine.artifact?.window.text).toBe('Secret deck.')
  })
})

describe('window', () => {
  it('prefers a line or sentence boundary near the cut', () => {
    const text = 'First sentence. Second sentence. Third sentence that is longer.'
    const w = window(text, 0, 40)
    expect(w.text).toBe('First sentence. Second sentence. ')
    expect(w.next_offset).toBe(w.text.length)
    expect(w.omitted_chars).toBe(text.length - w.text.length)
  })
})

describe('buildRecentUpdatesBlock', () => {
  it('returns nothing when the company has no captured updates (legacy fallback stays possible)', async () => {
    expect(await buildRecentUpdatesBlock(fakeAdmin() as any, { fundId: FUND, companyId: COMPANY })).toBe('')
  })

  it('labels each update with its id, status and warnings and marks omitted material', async () => {
    const admin = fakeAdmin({
      hits: [hit(U1, { extraction_status: 'partial', warnings: ['deck.pdf: PDF pages requiring OCR: 2.'], excerpts: [] })],
      total: 9,
      updates: { [U1]: { id: U1, company_id: COMPANY, source_email_id: 'e1', received_at: '2026-08-04T09:12:00Z', subject: 'July update', body_current: 'Short body.', body_original: 'Short body.', body_cleaning_status: 'complete', body_status: 'complete', extraction_status: 'partial', warnings: ['deck.pdf: PDF pages requiring OCR: 2.'], updated_at: 'x', companies: { name: 'Acme' } } },
      artifacts: { [A1]: { id: A1, update_id: U1, ordinal: 0, filename: 'deck.pdf', extraction_status: 'partial', warnings: ['PDF pages requiring OCR: 2.'], metadata: {}, ocr_status: 'pending', storage_path: 'e1/0', extracted_text: 'Slide text. '.repeat(500) } },
    })
    const block = await buildRecentUpdatesBlock(admin as any, { fundId: FUND, companyId: COMPANY, maxChars: 2_000 })
    expect(block).toContain(`--- UPDATE ${U1} | 2026-08-04 | period Jul 2026 | "July update" | extraction partial ---`)
    expect(block).toContain('Warnings: deck.pdf: PDF pages requiring OCR: 2.')
    expect(block).toContain('Short body.')
    expect(block).toContain(`[Attachment 0: deck.pdf | partial | OCR pending | artifact_id ${A1}]`)
    expect(block).toMatch(/more characters omitted; fetch with get_updates artifact/)
    expect(block).toContain('Most recent 1 of 9 captured update(s)')
  })
})
