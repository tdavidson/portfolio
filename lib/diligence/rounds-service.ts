// Diligence rounds, the database part, shared by the Diligence page's routes and the MCP tools.
//
// A round owns the memo drafts written in it; the deal's working draft is its latest open draft,
// which is always in the current round. Starting the next round closes the current one (leaving
// its follow-up request list) and copies its latest draft forward as the new round's first draft,
// so the new round starts from everything known so far. The database freezes a closed round's
// drafts (supabase/migrations/20261107150000_diligence_rounds.sql), so each round's memo, findings
// and scoring table stay as they were when it closed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import {
  buildRequestList, defaultRoundLabel, diffRoundEvidence, ROUND_OUTCOMES,
  type RequestItem, type RoundChanges, type RoundOutcome,
} from './rounds'

export interface DiligenceRound {
  id: string
  deal_id: string
  round_number: number
  label: string
  status: 'open' | 'closed'
  outcome: RoundOutcome | null
  summary: string | null
  request_list: RequestItem[]
  opened_at: string
  closed_at: string | null
}

export interface RoundListEntry extends DiligenceRound {
  /** The round's latest memo draft, where its evidence, memo and scores live. */
  draft: { id: string; draft_version: string; is_draft: boolean; finalized_at: string | null; created_at: string; has_memo: boolean; has_scores: boolean } | null
  documents: number
  notes: number
}

const ROUND_COLS = 'id, deal_id, round_number, label, status, outcome, summary, request_list, opened_at, closed_at'
const DRAFT_COLS = 'id, round_id, draft_version, agent_version, is_draft, finalized_at, created_at, ingestion_output, research_output, qa_answers, memo_draft_output'

const text = (v: unknown, max = 4000): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

/**
 * The deal's rounds, oldest first. A deal from before rounds, or one whose first round is missing,
 * gets round 1 here (the migration and a trigger normally create it).
 */
export async function loadRounds(admin: SupabaseClient, fundId: string, dealId: string): Promise<DiligenceRound[]> {
  const read = async () => {
    const { data } = await (admin as any).from('diligence_rounds').select(ROUND_COLS)
      .eq('deal_id', dealId).eq('fund_id', fundId).order('round_number', { ascending: true })
    return ((data as any[]) ?? []) as DiligenceRound[]
  }
  let rounds = await read()
  if (rounds.length === 0) {
    const { error } = await (admin as any).from('diligence_rounds')
      .insert({ fund_id: fundId, deal_id: dealId, round_number: 1, label: defaultRoundLabel(1), status: 'open' })
    if (error && !/duplicate|unique/i.test(error.message ?? '')) {
      console.error('[diligence-rounds-seed]', error.message)
      return []
    }
    rounds = await read()
  }
  return rounds.map(r => ({ ...r, request_list: Array.isArray(r.request_list) ? r.request_list : [] }))
}

/** The deal's current round: the latest one, open or closed. */
export async function currentRound(admin: SupabaseClient, fundId: string, dealId: string): Promise<DiligenceRound | null> {
  const rounds = await loadRounds(admin, fundId, dealId)
  return rounds[rounds.length - 1] ?? null
}

/** A round's latest memo draft (its evidence, memo and scores), or null when it has none. */
export async function roundDraft(admin: SupabaseClient, fundId: string, roundId: string): Promise<any | null> {
  const { data } = await (admin as any).from('diligence_memo_drafts').select(DRAFT_COLS)
    .eq('round_id', roundId).eq('fund_id', fundId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data ?? null
}

/** The deal's rounds with each one's latest draft and what arrived in it. */
export async function listRounds(admin: SupabaseClient, fundId: string, dealId: string): Promise<RoundListEntry[]> {
  const rounds = await loadRounds(admin, fundId, dealId)
  if (rounds.length === 0) return []
  const ids = rounds.map(r => r.id)
  const [{ data: drafts }, { data: docs }, { data: notes }] = await Promise.all([
    (admin as any).from('diligence_memo_drafts')
      .select('id, round_id, draft_version, is_draft, finalized_at, created_at, memo_draft_output')
      .eq('deal_id', dealId).eq('fund_id', fundId).in('round_id', ids)
      .order('created_at', { ascending: false }),
    (admin as any).from('diligence_documents').select('round_id').eq('deal_id', dealId).eq('fund_id', fundId),
    (admin as any).from('diligence_notes').select('round_id').eq('deal_id', dealId).eq('fund_id', fundId),
  ])
  const latest = new Map<string, any>()
  for (const d of (drafts as any[]) ?? []) if (!latest.has(d.round_id)) latest.set(d.round_id, d)
  const count = (rows: any[] | null, id: string) => (rows ?? []).filter(r => r.round_id === id).length

  return rounds.map(r => {
    const d = latest.get(r.id)
    const memo = d?.memo_draft_output
    return {
      ...r,
      draft: d ? {
        id: d.id, draft_version: d.draft_version, is_draft: d.is_draft, finalized_at: d.finalized_at, created_at: d.created_at,
        has_memo: Array.isArray(memo?.paragraphs) && memo.paragraphs.length > 0,
        has_scores: Array.isArray(memo?.scores) && memo.scores.length > 0,
      } : null,
      documents: count(docs as any[], r.id),
      notes: count(notes as any[], r.id),
    }
  })
}

export interface RoundDetail {
  round: DiligenceRound
  previous: DiligenceRound | null
  /** What changed in the evidence since the previous round (everything is new in round 1). */
  changes: RoundChanges
  /** The previous round's request list: what this round was asked to bring. */
  requested: RequestItem[]
  /** The request list as it stands now (the stored one once the round has closed). */
  request_list: RequestItem[]
  draft_id: string | null
  documents: Array<{ id: string; file_name: string; detected_type: string | null; uploaded_at: string }>
}

/** One round in full: what changed in it, what it was asked to bring, and what it leaves to ask. */
export async function roundDetail(admin: SupabaseClient, fundId: string, dealId: string, roundRef: string): Promise<Outcome<RoundDetail>> {
  const rounds = await loadRounds(admin, fundId, dealId)
  const round = resolveRound(rounds, roundRef)
  if (!round) return fail(404, `No diligence round "${roundRef}" on this deal.`)
  const previous = rounds.filter(r => r.round_number < round.round_number).pop() ?? null

  const [draft, prevDraft, { data: docs }] = await Promise.all([
    roundDraft(admin, fundId, round.id),
    previous ? roundDraft(admin, fundId, previous.id) : Promise.resolve(null),
    (admin as any).from('diligence_documents').select('id, file_name, detected_type, uploaded_at')
      .eq('deal_id', dealId).eq('fund_id', fundId).eq('round_id', round.id).order('uploaded_at', { ascending: true }),
  ])
  const changes = diffRoundEvidence(previous ? (prevDraft ?? {}) : null, draft ?? {})
  const request_list = round.status === 'closed' ? round.request_list : await currentRequestList(admin, fundId, dealId, draft)

  return done({
    round, previous, changes,
    requested: previous?.request_list ?? [],
    request_list,
    draft_id: draft?.id ?? null,
    documents: ((docs as any[]) ?? []) as RoundDetail['documents'],
  })
}

/** A round by id, by number ("2"), or "current"/"" for the latest. */
export function resolveRound(rounds: DiligenceRound[], ref: string | number | null | undefined): DiligenceRound | null {
  if (rounds.length === 0) return null
  const s = String(ref ?? '').trim().toLowerCase().replace(/^round\s*/, '')
  if (!s || s === 'current' || s === 'latest') return rounds[rounds.length - 1]
  if (/^\d+$/.test(s)) return rounds.find(r => r.round_number === Number(s)) ?? null
  return rounds.find(r => r.id === s) ?? null
}

async function currentRequestList(admin: SupabaseClient, fundId: string, dealId: string, draft: any | null): Promise<RequestItem[]> {
  const [{ data: items }, { data: attention }] = await Promise.all([
    (admin as any).from('diligence_checklist_items').select('id, parent_id, kind, label, status').eq('deal_id', dealId).eq('fund_id', fundId),
    (admin as any).from('diligence_attention_items').select('urgency, status, body').eq('deal_id', dealId).eq('fund_id', fundId).eq('status', 'open'),
  ])
  const rows = ((items as any[]) ?? [])
  const sectionLabel = new Map(rows.filter(r => r.kind === 'section').map(r => [r.id, r.label]))
  return buildRequestList({
    checklist: rows.map(r => ({ kind: r.kind, label: r.label, status: r.status, section: r.parent_id ? sectionLabel.get(r.parent_id) ?? null : null })),
    attention: ((attention as any[]) ?? []).map(a => ({ urgency: a.urgency, status: a.status, body: a.body })),
    ingestion_output: draft?.ingestion_output,
    research_output: draft?.research_output,
  })
}

function parseOutcome(v: unknown): Outcome<RoundOutcome | null | undefined> {
  if (v === undefined) return done(undefined)
  if (v === null || v === '') return done(null)
  if (typeof v === 'string' && (ROUND_OUTCOMES as readonly string[]).includes(v)) return done(v as RoundOutcome)
  return fail(400, `outcome must be one of ${ROUND_OUTCOMES.join(', ')}.`)
}

/** Close the deal's current round, storing its outcome, notes and follow-up request list. */
export async function closeRound(
  admin: SupabaseClient, ctx: { fundId: string; userId: string | null }, dealId: string,
  input: { outcome?: unknown; summary?: unknown },
): Promise<Outcome<DiligenceRound>> {
  const outcome = parseOutcome(input.outcome)
  if (!outcome.ok) return outcome
  const rounds = await loadRounds(admin, ctx.fundId, dealId)
  const round = rounds[rounds.length - 1]
  if (!round) return fail(404, 'This deal has no diligence round.')
  if (round.status === 'closed') return fail(409, `Round ${round.round_number} is already closed.`)

  const draft = await roundDraft(admin, ctx.fundId, round.id)
  const request_list = await currentRequestList(admin, ctx.fundId, dealId, draft)
  const { data, error } = await (admin as any).from('diligence_rounds')
    .update({
      status: 'closed', closed_at: new Date().toISOString(), closed_by: ctx.userId,
      outcome: outcome.value ?? round.outcome ?? null,
      summary: input.summary === undefined ? round.summary : text(input.summary),
      request_list,
    })
    .eq('id', round.id).eq('fund_id', ctx.fundId).eq('status', 'open')
    .select(ROUND_COLS).maybeSingle()
  if (error) return dbFail(error, 'diligence-round-close')
  if (!data) return fail(409, `Round ${round.round_number} is already closed.`)
  return done(data as DiligenceRound)
}

/**
 * Start the deal's next round: close the current one (if it is still open) and open the next, with
 * the current round's latest draft copied forward so its evidence, memo and scores carry over.
 */
export async function startNextRound(
  admin: SupabaseClient, ctx: { fundId: string; userId: string | null }, dealId: string,
  input: { label?: unknown; outcome?: unknown; summary?: unknown },
): Promise<Outcome<{ round: DiligenceRound; closed: DiligenceRound; draft_id: string | null }>> {
  const outcome = parseOutcome(input.outcome)
  if (!outcome.ok) return outcome
  const rounds = await loadRounds(admin, ctx.fundId, dealId)
  let current = rounds[rounds.length - 1]
  if (!current) return fail(404, 'This deal has no diligence round.')

  // Don't start a round while a memo agent stage is still writing into this one.
  const { data: running } = await (admin as any).from('memo_agent_jobs').select('id, kind')
    .eq('deal_id', dealId).eq('fund_id', ctx.fundId).in('status', ['pending', 'running']).limit(1)
  if (((running as any[]) ?? []).length > 0) {
    return fail(409, `A memo agent stage (${(running as any[])[0].kind}) is still running on this round. Start the next round when it finishes.`)
  }

  let closedNow = false
  if (current.status === 'open') {
    const closed = await closeRound(admin, ctx, dealId, { outcome: outcome.value ?? 'advance', summary: input.summary })
    if (!closed.ok) return closed
    current = closed.value
    closedNow = true
  }

  const number = current.round_number + 1
  const { data: created, error } = await (admin as any).from('diligence_rounds')
    .insert({
      fund_id: ctx.fundId, deal_id: dealId, round_number: number,
      label: text(input.label, 200) ?? defaultRoundLabel(number), status: 'open', created_by: ctx.userId,
    })
    .select(ROUND_COLS).single()
  if (error || !created) {
    // Leave the deal as it was rather than with no open round.
    if (closedNow) {
      await (admin as any).from('diligence_rounds')
        .update({ status: 'open', closed_at: null, closed_by: null }).eq('id', current.id).eq('fund_id', ctx.fundId)
    }
    return /duplicate|unique/i.test(error?.message ?? '')
      ? fail(409, 'Another round was just started on this deal. Reload to see it.')
      : dbFail(error, 'diligence-round-start')
  }
  const round = created as DiligenceRound

  // Carry the evidence, memo and scores forward as the new round's first draft.
  const prior = await roundDraft(admin, ctx.fundId, current.id)
  let draftId: string | null = null
  if (prior) {
    const memo = prior.memo_draft_output && typeof prior.memo_draft_output === 'object'
      ? { ...prior.memo_draft_output, carried_from_round: current.round_number }
      : prior.memo_draft_output
    const { data: copy, error: copyErr } = await (admin as any).from('diligence_memo_drafts')
      .insert({
        deal_id: dealId, fund_id: ctx.fundId, round_id: round.id,
        draft_version: `R${number} v0.1`,
        agent_version: `carried forward from round ${current.round_number}`,
        ingestion_output: prior.ingestion_output, research_output: prior.research_output, qa_answers: prior.qa_answers,
        memo_draft_output: memo, is_draft: true, created_by: ctx.userId,
      })
      .select('id').single()
    if (copyErr || !copy) return dbFail(copyErr, 'diligence-round-carry-forward')
    draftId = (copy as { id: string }).id
  }
  return done({ round: { ...round, request_list: [] }, closed: current, draft_id: draftId })
}

/** Rename a round or edit its notes and outcome; or reopen the latest round when it was closed by mistake. */
export async function updateRound(
  admin: SupabaseClient, ctx: { fundId: string; userId: string | null }, dealId: string, roundRef: string,
  input: { label?: unknown; summary?: unknown; outcome?: unknown; status?: unknown },
): Promise<Outcome<DiligenceRound>> {
  const rounds = await loadRounds(admin, ctx.fundId, dealId)
  const round = resolveRound(rounds, roundRef)
  if (!round) return fail(404, `No diligence round "${roundRef}" on this deal.`)

  if (input.status === 'closed' && round.status === 'open') {
    if (round.id !== rounds[rounds.length - 1].id) return fail(409, 'Only the current round can be closed.')
    return closeRound(admin, ctx, dealId, { outcome: input.outcome, summary: input.summary })
  }

  const updates: Record<string, unknown> = {}
  if (input.status === 'open' && round.status === 'closed') {
    if (round.id !== rounds[rounds.length - 1].id) {
      return fail(409, `Round ${round.round_number} has a later round, so it stays closed. Work continues in round ${rounds[rounds.length - 1].round_number}.`)
    }
    updates.status = 'open'
    updates.closed_at = null
    updates.closed_by = null
  } else if (input.status !== undefined && input.status !== round.status) {
    return fail(400, 'status must be open or closed.')
  }
  if (input.label !== undefined) {
    const label = text(input.label, 200)
    if (!label) return fail(400, 'A round needs a name.')
    updates.label = label
  }
  if (input.summary !== undefined) updates.summary = text(input.summary)
  if (input.outcome !== undefined) {
    const outcome = parseOutcome(input.outcome)
    if (!outcome.ok) return outcome
    updates.outcome = outcome.value ?? null
  }
  if (Object.keys(updates).length === 0) return fail(400, 'Nothing to update.')

  const { data, error } = await (admin as any).from('diligence_rounds')
    .update(updates).eq('id', round.id).eq('fund_id', ctx.fundId).select(ROUND_COLS).single()
  if (error || !data) return dbFail(error, 'diligence-round-update')
  return done(data as DiligenceRound)
}
