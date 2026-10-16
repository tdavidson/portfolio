import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS, getTool } from '@/lib/accounting/agent-tools'
import { isDraftOnlyCall, shouldStage } from '@/lib/agent/dispatch'
import { previewToolCall, stageToolCall } from '@/lib/agent/tool-call-action'
import { DEALS_HANDLERS } from '@/lib/agent/deals-tools'
import { DILIGENCE_HANDLERS } from '@/lib/agent/diligence-tools'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Deals and diligence from chat and the API: every write is a tool, staged from a connected chat,
 * limited to deals the caller can see, and doing what the web route does (the shared services).
 */

const oauth = { keyId: 'oauth:abc' }
const key = { keyId: 'key-1' }
const member = { fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: false, ids: ['v1'] } } as any
const everyone = { fundId: 'f1', userId: 'u1', role: 'admin', vehicles: { all: true, ids: [] } } as any

const WRITES = AGENT_TOOLS.filter(t => ['deals', 'diligence'].includes(t.domain ?? '') && t.scope === 'write').map(t => t.name)

function seed() {
  return memoryAdmin({
    inbound_deals: [
      { id: 'in-1', fund_id: 'f1', company_name: 'Acme', vehicle_id: 'v1', status: 'new', created_at: '2026-01-01', promoted_diligence_id: null },
      { id: 'in-2', fund_id: 'f1', company_name: 'Beta', vehicle_id: 'v2', status: 'new', created_at: '2026-01-02', promoted_diligence_id: null },
    ],
    diligence_deals: [
      { id: 'dd-1', fund_id: 'f1', name: 'Acme', vehicle_id: 'v1', aliases: [] },
      { id: 'dd-2', fund_id: 'f1', name: 'Beta', vehicle_id: 'v2', aliases: [] },
    ],
    fund_vehicles: [{ id: 'v1', fund_id: 'f1' }, { id: 'v2', fund_id: 'f1' }],
    diligence_checklist_items: [
      { id: 'ci-1', fund_id: 'f1', deal_id: 'dd-1', kind: 'item', label: 'Cap table', status: 'unknown', partner_facts: [{ id: 'fact_a', text: 'Clean' }], order_index: 1 },
    ],
    diligence_attention_items: [{ id: 'at-1', fund_id: 'f1', deal_id: 'dd-1', kind: 'question', urgency: 'high', body: 'Churn?', status: 'open' }],
    diligence_memo_drafts: [{
      id: 'md-1', fund_id: 'f1', deal_id: 'dd-1', is_draft: true, created_at: '2026-02-01',
      memo_draft_output: { paragraphs: [
        { id: 'p1', section_id: 'thesis', order: 1, prose: 'Strong team.', origin: 'agent' },
        { id: 'p2', section_id: 'recommendation', order: 1, prose: '[Partner to complete]', origin: 'partner_only_placeholder' },
      ] },
    }],
  }).admin
}

const ctx = (admin: any, access = everyone) => ({ admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access })

describe('deal and diligence tools', () => {
  it('covers the deal and deal-room actions', () => {
    for (const name of [
      'deals_create_inbound', 'deals_update_inbound', 'deals_research_inbound', 'deals_promote_to_diligence',
      'diligence_create_deal', 'diligence_update_deal', 'diligence_add_checklist_item', 'diligence_update_checklist_item',
      'diligence_add_note', 'diligence_add_documents', 'diligence_resolve_attention', 'diligence_run_agent',
      'diligence_write_memo', 'diligence_finalize_memo',
    ]) expect(WRITES, name).toContain(name)
  })

  // Running a memo-agent stage on the assistant's own model writes only into the open draft, and
  // starting the stage (diligence_run_agent) was already approved, so those calls are not staged again.
  const RUN_ON_ASSISTANT = ['diligence_stage_next', 'diligence_stage_submit']
  it('runs a stage on the assistant without asking twice', () => {
    for (const name of RUN_ON_ASSISTANT) expect(isDraftOnlyCall({ name }, {}), name).toBe(true)
  })

  // Minting an upload URL changes no record; the register call (diligence_add_documents,
  // deals_create_inbound) is the one that stages.
  const UPLOAD_URLS = ['diligence_document_upload_url', 'deals_deck_upload_url']
  it('mints an upload URL directly, from a chat or a key', () => {
    for (const name of UPLOAD_URLS) {
      expect(shouldStage(getTool(name)!, {}, oauth), name).toBe(false)
      expect(shouldStage(getTool(name)!, {}, key), name).toBe(false)
    }
  })

  // A destructive one (deleting a deal room) is staged from a key too: lib/agent/destructive.ts.
  const DESTRUCTIVE = WRITES.filter(n => getTool(n)!.destructive)
  it.each(WRITES.filter(n => !RUN_ON_ASSISTANT.includes(n) && !UPLOAD_URLS.includes(n) && !DESTRUCTIVE.includes(n)))('%s is staged from a chat and runs directly from a key', name => {
    const tool = getTool(name)!
    expect(shouldStage(tool, {}, oauth)).toBe(true)
    expect(shouldStage(tool, {}, key)).toBe(false)
  })

  it('stages deleting a deal room from a chat and from a key alike, for an admin', () => {
    expect(DESTRUCTIVE).toEqual(['diligence_delete_deal'])
    const tool = getTool('diligence_delete_deal')!
    expect(shouldStage(tool, {}, oauth)).toBe(true)
    expect(shouldStage(tool, {}, key)).toBe(true)
    expect(adminOnlyToolLabel('diligence_delete_deal', {})).toBe('delete a diligence deal')
  })

  it('only an admin can approve finalizing a memo', () => {
    expect(adminOnlyToolLabel('diligence_finalize_memo', {})).toBe('finalize a memo')
    expect(adminOnlyToolLabel('diligence_write_memo', {})).toBeUndefined()
  })

  it("refuses to stage a change to a deal on someone else's entity", async () => {
    const admin = seed()
    const deps = { admin, fundId: 'f1', userId: 'u1', access: member }
    await expect(stageToolCall(deps, 'deals_update_inbound', { deal: 'in-2', status: 'passed' })).rejects.toThrow()
    await expect(stageToolCall(deps, 'diligence_add_note', { deal: 'dd-2', body: 'x' })).rejects.toThrow()
    const ok = await stageToolCall(deps, 'diligence_add_note', { deal: 'dd-1', body: 'Call went well' })
    expect(ok.args.input).toEqual({ deal: 'dd-1', body: 'Call went well' })
  })

  it("shows the approver a data room upload's files by name and size, never the bytes", async () => {
    const content = Buffer.alloc(4096, 1).toString('base64')
    const preview = await previewToolCall(
      { admin: seed(), fundId: 'f1', userId: 'u1', access: everyone },
      { tool: 'diligence_add_documents', input: { deal: 'dd-1', files: [{ filename: 'model.xlsx', content_base64: content }] } },
    )
    expect(JSON.stringify(preview)).not.toContain(content)
    expect(preview.summary).toContain('model.xlsx (4 KB)')
  })

  it('moves an inbound deal, and refuses a status the Deals page would', async () => {
    const admin = seed()
    const out = await DEALS_HANDLERS.deals_update_inbound(ctx(admin), { deal: 'in-1', status: 'reviewing' }) as any
    expect(out.updated).toEqual(['status'])
    await expect(DEALS_HANDLERS.deals_update_inbound(ctx(admin), { deal: 'in-1', status: 'maybe' })).rejects.toThrow('Invalid status')
  })

  it('promotes once, carrying the entity, and refuses a second time', async () => {
    const admin = seed()
    const out = await DEALS_HANDLERS.deals_promote_to_diligence(ctx(admin, member), { deal: 'in-1' }) as any
    const { data: room } = await (admin as any).from('diligence_deals').select('*').eq('id', out.diligenceDealId).maybeSingle()
    expect(room.vehicle_id).toBe('v1')
    const { data: deal } = await (admin as any).from('inbound_deals').select('*').eq('id', 'in-1').maybeSingle()
    expect(deal.status).toBe('diligence')
    await expect(DEALS_HANDLERS.deals_promote_to_diligence(ctx(admin, member), { deal: 'in-1' })).rejects.toThrow('already has a Diligence record')
  })

  it('marks a checklist item and appends a fact to the ones already there', async () => {
    const admin = seed()
    await DILIGENCE_HANDLERS.diligence_update_checklist_item(ctx(admin), { deal: 'Acme', item: 'cap table', status: 'found', add_fact: 'Two SAFEs outstanding' })
    const { data: item } = await (admin as any).from('diligence_checklist_items').select('*').eq('id', 'ci-1').maybeSingle()
    expect(item.status).toBe('found')
    expect(item.partner_facts.map((f: any) => f.text)).toEqual(['Clean', 'Two SAFEs outstanding'])
    expect(item.partner_facts[0].id).toBe('fact_a')
    await expect(DILIGENCE_HANDLERS.diligence_update_checklist_item(ctx(admin), { deal: 'Acme', item: 'ci-1', status: 'great' })).rejects.toThrow('Invalid status')
  })

  it('resolves an attention item in the user\'s name', async () => {
    const admin = seed()
    await DILIGENCE_HANDLERS.diligence_resolve_attention(ctx(admin), { deal: 'dd-1', item: 'at-1', status: 'done', note: 'Asked on the call' })
    const { data: item } = await (admin as any).from('diligence_attention_items').select('*').eq('id', 'at-1').maybeSingle()
    expect(item).toMatchObject({ status: 'done', resolved_by: 'u1', resolution_note: 'Asked on the call' })
  })

  it('will not finalize until the partner writes the recommendation, then locks the memo', async () => {
    const admin = seed()
    await expect(DILIGENCE_HANDLERS.diligence_finalize_memo(ctx(admin), { deal: 'dd-1' })).rejects.toThrow('Recommendation section is empty')
    const wrote = await DILIGENCE_HANDLERS.diligence_write_memo(ctx(admin), { deal: 'dd-1', section: 'recommendation', prose: 'Invest $500k.' }) as any
    expect(wrote).toMatchObject({ paragraphId: 'p2', action: 'edited' })
    await DILIGENCE_HANDLERS.diligence_finalize_memo(ctx(admin), { deal: 'dd-1' })
    const { data: draft } = await (admin as any).from('diligence_memo_drafts').select('*').eq('id', 'md-1').maybeSingle()
    expect(draft.is_draft).toBe(false)
    await expect(DILIGENCE_HANDLERS.diligence_write_memo(ctx(admin), { deal: 'dd-1', paragraph_id: 'p1', prose: 'x' })).rejects.toThrow('finalized')
  })

  it('adds a paragraph to a section with no placeholder', async () => {
    const admin = seed()
    const out = await DILIGENCE_HANDLERS.diligence_write_memo(ctx(admin), { deal: 'dd-1', section: 'risks', prose: 'Key-person risk.' }) as any
    expect(out.action).toBe('added')
    const { data: draft } = await (admin as any).from('diligence_memo_drafts').select('*').eq('id', 'md-1').maybeSingle()
    expect(draft.memo_draft_output.paragraphs.find((p: any) => p.id === out.paragraphId)).toMatchObject({ section_id: 'risks', origin: 'partner_drafted' })
  })

  it("reports the memo agent's latest job, so a chat can follow what it started", async () => {
    const admin = seed()
    const before = await DILIGENCE_HANDLERS.diligence_deal_detail(ctx(admin), { deal: 'dd-1' }) as any
    expect(before.agent_job).toBeNull()
    await (admin as any).from('memo_agent_jobs').insert({ id: 'job-1', fund_id: 'f1', deal_id: 'dd-1', kind: 'draft', status: 'failed', error: 'Over the cap', enqueued_at: '2026-03-01T00:00:00Z' })
    const after = await DILIGENCE_HANDLERS.diligence_deal_detail(ctx(admin), { deal: 'dd-1' }) as any
    expect(after.agent_job).toMatchObject({ id: 'job-1', kind: 'draft', status: 'failed', error: 'Over the cap' })
    expect(after.progress.some((p: any) => p.state === 'failed')).toBe(true)
  })

  describe('following long-running work', () => {
    const withJobs = () => {
      const { admin } = memoryAdmin({
        inbound_deals: [
          { id: 'in-1', fund_id: 'f1', company_name: 'Acme', vehicle_id: 'v1', research_status: 'complete', research_output: { summary: 'Solid' } },
          { id: 'in-2', fund_id: 'f1', company_name: 'Beta', vehicle_id: 'v2', research_status: 'pending' },
          { id: 'in-3', fund_id: 'f1', company_name: 'Gamma', vehicle_id: 'v1', research_status: null },
        ],
        diligence_deals: [
          { id: 'dd-1', fund_id: 'f1', name: 'Acme', vehicle_id: 'v1', aliases: [] },
          { id: 'dd-2', fund_id: 'f1', name: 'Beta', vehicle_id: 'v2', aliases: [] },
        ],
        memo_agent_jobs: [
          { id: 'job-1', fund_id: 'f1', deal_id: 'dd-1', kind: 'analyze', status: 'running', enqueued_at: '2026-03-01' },
          { id: 'job-2', fund_id: 'f1', deal_id: 'dd-2', kind: 'draft', status: 'succeeded', enqueued_at: '2026-03-02' },
        ],
      })
      return admin
    }

    it('reads a diligence job back by its handle, within the deal\'s scope', async () => {
      const admin = withJobs()
      const out = await DILIGENCE_HANDLERS.diligence_job_status(ctx(admin, member), { job_id: 'diligence:job-1' }) as any
      expect(out.job).toMatchObject({ id: 'diligence:job-1', status: 'running', stage: 'analyze' })
      await expect(DILIGENCE_HANDLERS.diligence_job_status(ctx(admin, member), { job_id: 'diligence:job-2' })).rejects.toThrow(/No diligence job/)
      await expect(DILIGENCE_HANDLERS.diligence_job_status(ctx(admin, member), { job_id: 'deal_research:in-1' })).rejects.toThrow(/deals_research_status/)
      const byDeal = await DILIGENCE_HANDLERS.diligence_job_status(ctx(admin, everyone), { deal: 'dd-2' }) as any
      expect(byDeal.jobs.map((j: any) => j.status)).toEqual(['done'])
    })

    it('reads deal research back, with the result once it is done', async () => {
      const admin = withJobs()
      const done = await DEALS_HANDLERS.deals_research_status(ctx(admin, member), { job_id: 'deal_research:in-1' }) as any
      expect(done.job.status).toBe('done')
      expect(done.research).toEqual({ summary: 'Solid' })
      await expect(DEALS_HANDLERS.deals_research_status(ctx(admin, member), { job_id: 'deal_research:in-2' })).rejects.toThrow()
      const queued = await DEALS_HANDLERS.deals_research_status(ctx(admin, everyone), { deal: 'in-2' }) as any
      expect(queued).toMatchObject({ job: { status: 'queued' }, research: null })
      const none = await DEALS_HANDLERS.deals_research_status(ctx(admin, everyone), { deal: 'in-3' }) as any
      expect(none.job).toBeNull()
    })
  })
})
