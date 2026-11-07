import { describe, expect, it } from 'vitest'
import { closeRound, listRounds, loadRounds, roundDetail, startNextRound, updateRound } from '@/lib/diligence/rounds-service'
import { DILIGENCE_HANDLERS } from '@/lib/agent/diligence-tools'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Diligence rounds: starting the next round closes the current one with its request list and
 * carries its evidence, memo and scores forward, so each round keeps its own memo and scoring table.
 * (The database also freezes a closed round's drafts; that trigger is in the migration.)
 */

const everyone = { fundId: 'f1', userId: 'u1', role: 'admin', vehicles: { all: true, ids: [] } } as any
const ctx = { fundId: 'f1', userId: 'u1' }

function seed(extra: Record<string, any[]> = {}) {
  return memoryAdmin({
    diligence_deals: [{ id: 'dd-1', fund_id: 'f1', name: 'Acme', vehicle_id: null, aliases: [] }],
    diligence_rounds: [{ id: 'r1', fund_id: 'f1', deal_id: 'dd-1', round_number: 1, label: 'Initial data room', status: 'open', outcome: null, summary: null, request_list: [], opened_at: '2026-01-01', closed_at: null }],
    diligence_memo_drafts: [{
      id: 'md-1', fund_id: 'f1', deal_id: 'dd-1', round_id: 'r1', is_draft: true, created_at: '2026-01-05', draft_version: 'v0.1',
      ingestion_output: {
        documents: [{ document_id: 'doc-1', detected_type: 'pitch_deck', claims: [{ id: 'c1', field: 'ARR', value: '$1.0M' }] }],
        gap_analysis: { missing: [{ expected_type: 'cap_table', criticality: 'blocker', rationale: 'No cap table.' }], inadequate: [] },
        cross_doc_flags: [],
      },
      research_output: null,
      qa_answers: [],
      memo_draft_output: { paragraphs: [{ id: 'p1', section_id: 'thesis', prose: 'A good bet.', sources: [{ source_type: 'claim', source_id: 'c1' }] }], scores: [{ dimension_id: 'market', score: 3 }] },
    }],
    diligence_checklist_items: [
      { id: 'ci-1', fund_id: 'f1', deal_id: 'dd-1', parent_id: null, kind: 'item', label: 'Audited accounts', status: 'missing' },
      { id: 'ci-2', fund_id: 'f1', deal_id: 'dd-1', parent_id: null, kind: 'item', label: 'Pitch deck', status: 'found' },
    ],
    diligence_attention_items: [{ id: 'at-1', fund_id: 'f1', deal_id: 'dd-1', urgency: 'must_address', status: 'open', body: 'Confirm churn' }],
    diligence_documents: [{ id: 'doc-1', fund_id: 'f1', deal_id: 'dd-1', round_id: 'r1', file_name: 'deck.pdf', detected_type: 'pitch_deck', uploaded_at: '2026-01-02' }],
    diligence_notes: [],
    memo_agent_jobs: [],
    ...extra,
  }, { unique: [{ table: 'diligence_rounds', key: r => `${r.deal_id}:${r.round_number}` }] })
}

describe('diligence rounds', () => {
  it('starts the next round: closes the current one with its request list and carries the draft forward', async () => {
    const { admin, tables } = seed() as any
    const out = await startNextRound(admin, ctx, 'dd-1', { label: 'Follow-up request', summary: 'Strong first look.' })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(out.value.closed).toMatchObject({ round_number: 1, status: 'closed', outcome: 'advance', summary: 'Strong first look.' })
    expect(out.value.closed.request_list.map((r: any) => r.label)).toEqual(['Audited accounts', 'Confirm churn', 'Cap table'])
    expect(out.value.round).toMatchObject({ round_number: 2, label: 'Follow-up request', status: 'open' })

    const drafts = tables.diligence_memo_drafts.filter((d: any) => d.round_id === out.value.round.id)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ is_draft: true, draft_version: 'R2 v0.1' })
    expect(drafts[0].memo_draft_output.scores).toEqual([{ dimension_id: 'market', score: 3 }])
    expect(drafts[0].memo_draft_output.carried_from_round).toBe(1)
    // Round 1's draft is untouched.
    expect(tables.diligence_memo_drafts.find((d: any) => d.id === 'md-1').memo_draft_output.carried_from_round).toBeUndefined()
  })

  it('will not start a round while a memo agent stage is running', async () => {
    const { admin } = seed({ memo_agent_jobs: [{ id: 'j1', fund_id: 'f1', deal_id: 'dd-1', kind: 'draft', status: 'running' }] }) as any
    const out = await startNextRound(admin, ctx, 'dd-1', {})
    expect(out).toMatchObject({ ok: false, status: 409 })
  })

  it('refuses an unknown outcome', async () => {
    const { admin } = seed() as any
    expect(await closeRound(admin, ctx, 'dd-1', { outcome: 'maybe' })).toMatchObject({ ok: false, status: 400 })
  })

  it('closes the last round, and reopens it', async () => {
    const { admin } = seed() as any
    const closed = await closeRound(admin, ctx, 'dd-1', { outcome: 'invest' })
    expect(closed).toMatchObject({ ok: true, value: { status: 'closed', outcome: 'invest' } })
    expect(await closeRound(admin, ctx, 'dd-1', {})).toMatchObject({ ok: false, status: 409 })
    const reopened = await updateRound(admin, ctx, 'dd-1', 'current', { status: 'open' })
    expect(reopened).toMatchObject({ ok: true, value: { status: 'open', closed_at: null } })
  })

  it('keeps an earlier round closed once a later one exists', async () => {
    const { admin } = seed() as any
    await startNextRound(admin, ctx, 'dd-1', {})
    expect(await updateRound(admin, ctx, 'dd-1', '1', { status: 'open' })).toMatchObject({ ok: false, status: 409 })
    expect(await updateRound(admin, ctx, 'dd-1', '1', { label: 'First look' })).toMatchObject({ ok: true, value: { label: 'First look' } })
  })

  it('lists rounds with what arrived in each, and gives a deal without rounds its first', async () => {
    const { admin } = seed({ diligence_rounds: [] }) as any
    const rounds = await loadRounds(admin, 'f1', 'dd-1')
    expect(rounds.map(r => [r.round_number, r.label, r.status])).toEqual([[1, 'Initial data room', 'open']])

    const { admin: a2 } = seed() as any
    const list = await listRounds(a2, 'f1', 'dd-1')
    expect(list[0]).toMatchObject({ round_number: 1, documents: 1, draft: { id: 'md-1', has_memo: true, has_scores: true } })
  })

  it('reads a round in full: what changed since the previous one and what it was asked for', async () => {
    const { admin, tables } = seed() as any
    const started = await startNextRound(admin, ctx, 'dd-1', {})
    if (!started.ok) throw new Error(started.error)
    // Round 2's analysis revises ARR.
    const r2 = tables.diligence_memo_drafts.find((d: any) => d.round_id === started.value.round.id)
    r2.created_at = '2026-02-01'
    r2.ingestion_output = { ...r2.ingestion_output, documents: [{ document_id: 'doc-1', detected_type: 'pitch_deck', claims: [{ id: 'c9', field: 'ARR', value: '$1.4M' }] }] }

    const detail = await roundDetail(admin, 'f1', 'dd-1', '2')
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.value.previous?.round_number).toBe(1)
    expect(detail.value.changes.items.find(i => i.label === 'ARR')).toMatchObject({ status: 'changed', ref: 'claim:c9', prior_ref: 'claim:c1' })
    expect(detail.value.requested.map(r => r.label)).toContain('Audited accounts')
    expect(await roundDetail(admin, 'f1', 'dd-1', '7')).toMatchObject({ ok: false, status: 404 })
  })

  it('works the same from a chat', async () => {
    const { admin } = seed() as any
    const tctx = { admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access: everyone }
    const started: any = await DILIGENCE_HANDLERS.diligence_round_save(tctx, { deal: 'Acme', action: 'start_next', label: 'Follow-up request' })
    expect(started).toMatchObject({ deal: 'Acme', closed_round: 1, round: { number: 2, label: 'Follow-up request' } })

    const listed: any = await DILIGENCE_HANDLERS.diligence_rounds(tctx, { deal: 'Acme' })
    expect(listed.rounds.map((r: any) => [r.round, r.status])).toEqual([[1, 'closed'], [2, 'open']])

    const one: any = await DILIGENCE_HANDLERS.diligence_rounds(tctx, { deal: 'Acme', round: '1' })
    expect(one.request_list_text).toContain('- Audited accounts')

    const memo: any = await DILIGENCE_HANDLERS.diligence_memo(tctx, { deal: 'Acme', round: '1' })
    expect(memo).toMatchObject({ round: { number: 1, status: 'closed' }, scores: [{ dimension_id: 'market', score: 3 }] })

    await expect(DILIGENCE_HANDLERS.diligence_round_save(tctx, { deal: 'Acme', action: 'merge' })).rejects.toThrow('action must be')
  })
})
