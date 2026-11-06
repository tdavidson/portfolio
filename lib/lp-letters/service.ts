// LP letters, for the web routes (app/api/lp-letters/**) and the agent tools (lib/agent/letter-tools.ts).
//
// A letter belongs to one entity (its portfolio_group), so every read and write here takes the
// caller's visible entity names (null = all of them) and treats a letter of another entity as not
// found, the way the list route always filtered it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { groupWriteDenial } from '@/lib/access/scope'
import { aggregatePortfolioData } from './aggregate'
import { assembleFullDraft, buildPortfolioTableHtml } from './generate'
import { splitInternal } from './internal'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import type { CompanyNarrative } from '@/lib/types/database'

type Admin = SupabaseClient
/** The caller's visible entity names; null = every entity. */
type Visible = string[] | null

const LIST_COLUMNS = 'id, period_year, period_quarter, period_label, portfolio_group, status, is_year_end, created_at, updated_at'

const canSee = (visible: Visible, group: string | null | undefined) =>
  visible === null || (!!group && visible.includes(group))

export async function listLetters(admin: Admin, fundId: string, visible: Visible): Promise<Outcome<any[]>> {
  const { data, error } = await (admin as any)
    .from('lp_letters').select(LIST_COLUMNS).eq('fund_id', fundId)
    .order('period_year', { ascending: false }).order('period_quarter', { ascending: false })
  if (error) return dbFail(error, 'lp-letters')
  return done(((data ?? []) as any[]).filter(l => canSee(visible, l.portfolio_group)))
}

/** One letter of this fund the caller can see, or null. */
export async function getLetter(admin: Admin, fundId: string, visible: Visible, letterId: string): Promise<Outcome<any | null>> {
  if (!letterId) return done(null)
  const { data, error } = await (admin as any).from('lp_letters').select('*').eq('id', letterId).eq('fund_id', fundId).maybeSingle()
  if (error) return dbFail(error, 'lp-letters-id')
  return done(data && canSee(visible, data.portfolio_group) ? data : null)
}

export interface NewLetter {
  period_year: unknown
  period_quarter: unknown
  portfolio_group: unknown
  is_year_end?: unknown
  template_id?: unknown
  generation_prompt?: unknown
}

export async function createLetter(admin: Admin, ctx: { fundId: string; userId: string; visible: Visible }, input: NewLetter): Promise<Outcome<any>> {
  const { period_year, period_quarter, portfolio_group, is_year_end, template_id, generation_prompt } = input
  if (!period_year || !period_quarter || !portfolio_group) {
    return fail(400, 'period_year, period_quarter, and portfolio_group are required')
  }
  const denied = groupWriteDenial(ctx.visible, String(portfolio_group))
  if (denied) return fail(403, denied)

  // The entity by id as well as by name, so a renamed or merged vehicle keeps its letters.
  const { data: vehicle } = await (admin as any)
    .from('fund_vehicles').select('id').eq('fund_id', ctx.fundId).eq('name', String(portfolio_group)).maybeSingle()

  const periodLabel = is_year_end
    ? `Q${period_quarter} ${period_year} / Year End ${period_year}`
    : `Q${period_quarter} ${period_year}`

  const { data, error } = await (admin as any)
    .from('lp_letters')
    .insert({
      fund_id: ctx.fundId,
      template_id: template_id ?? null,
      period_year,
      period_quarter,
      is_year_end: is_year_end ?? false,
      period_label: periodLabel,
      portfolio_group,
      vehicle_id: vehicle?.id ?? null,
      generation_prompt: generation_prompt ?? null,
      status: 'draft',
      created_by: ctx.userId,
    })
    .select()
    .single()
  if (error) return dbFail(error, 'lp-letters')
  return done(data)
}

export interface LetterChanges {
  company_narratives?: unknown
  full_draft?: unknown
  /** The partners' notes kept with the letter and never shown to investors (internal.ts). */
  internal_notes?: unknown
  status?: unknown
  generation_prompt?: unknown
  company_prompts?: unknown
}

export async function updateLetter(admin: Admin, ctx: { fundId: string; visible: Visible }, letterId: string, input: LetterChanges): Promise<Outcome<any>> {
  const found = await getLetter(admin, ctx.fundId, ctx.visible, letterId)
  if (!found.ok) return found
  if (!found.value) return fail(404, 'Not found')

  const { company_narratives, full_draft, internal_notes, status, generation_prompt, company_prompts } = input
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (company_narratives !== undefined) updates.company_narratives = company_narratives
  if (internal_notes !== undefined) updates.internal_notes = internal_notes == null ? null : String(internal_notes)
  // A "Missing information" section written into the text moves to the internal notes, so it can
  // never be shared with the letter.
  if (full_draft !== undefined) {
    const { body, internal } = splitInternal(full_draft == null ? null : String(full_draft))
    updates.full_draft = full_draft == null ? null : body
    if (internal) updates.internal_notes = internal
  }
  // 'final' is a reviewed letter, the only kind that can be shared (shareLetter). 'complete' was a
  // name the code used and the table's check never allowed; it means final.
  if (status !== undefined) {
    const next = String(status) === 'complete' ? 'final' : String(status)
    if (!['draft', 'final'].includes(next)) return fail(400, 'status must be draft or final')
    if (next === 'final' && found.value.status === 'generating') return fail(409, 'This letter is being generated. Try again when it finishes.')
    updates.status = next
  }
  if (generation_prompt !== undefined) updates.generation_prompt = generation_prompt
  // portfolio_table_html is always derived server-side — not accepted from the caller
  if (company_prompts !== undefined) updates.company_prompts = company_prompts

  const { data, error } = await (admin as any)
    .from('lp_letters').update(updates).eq('id', letterId).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-id')
  return done(data)
}

/** The figures a letter is written from: its entity's portfolio for its quarter. */
export async function letterData(admin: Admin, fundId: string, letter: { period_year: number; period_quarter: number; portfolio_group: string; is_year_end: boolean }) {
  return aggregatePortfolioData(admin, fundId, letter.period_year, letter.period_quarter, letter.portfolio_group, letter.is_year_end)
}

/**
 * Write a letter's company sections from text the caller wrote (an assistant in a chat, rather
 * than the fund's own AI provider), and rebuild everything else as generation does: the portfolio
 * table and summary from the books, and the full draft around the sections. A section for a company
 * not in the letter's portfolio is refused, so a draft cannot name a company the entity doesn't hold.
 */
export async function writeLetterSections(
  admin: Admin, ctx: { fundId: string; userId: string; visible: Visible }, letterId: string,
  sections: { company_id: string; narrative: string }[],
): Promise<Outcome<any>> {
  const found = await getLetter(admin, ctx.fundId, ctx.visible, letterId)
  if (!found.ok) return found
  const letter = found.value
  if (!letter) return fail(404, 'Not found')
  if (letter.status === 'generating') return fail(409, 'This letter is being generated. Try again when it finishes.')

  const preview = await letterData(admin, ctx.fundId, letter)
  const byId = new Map(preview.companies.map(c => [c.investment.companyId, c.investment.companyName]))
  const unknown = sections.filter(s => !byId.has(s.company_id))
  if (unknown.length) return fail(400, `Not in this letter's portfolio: ${unknown.map(s => s.company_id).join(', ')}`)

  // Sections given replace those companies'; the rest keep what they had.
  const now = new Date().toISOString()
  const existing = new Map(((letter.company_narratives ?? []) as CompanyNarrative[]).map(n => [n.company_id, n]))
  for (const s of sections) {
    existing.set(s.company_id, { company_id: s.company_id, company_name: byId.get(s.company_id)!, narrative: s.narrative.trim(), updated_by: ctx.userId, updated_at: now })
  }
  // In the portfolio's order, as generation writes them.
  const narratives = preview.companies.map(c => existing.get(c.investment.companyId)).filter((n): n is CompanyNarrative => !!n)

  const portfolioTableHtml = sanitizeLetterHtml(buildPortfolioTableHtml(preview)) ?? ''
  const { data, error } = await (admin as any)
    .from('lp_letters')
    .update({
      portfolio_table_html: portfolioTableHtml,
      company_narratives: narratives,
      full_draft: assembleFullDraft(preview, portfolioTableHtml, narratives, preview.fundCurrency),
      portfolio_summary: preview.companies.map(c => ({
        company_id: c.investment.companyId, company_name: c.investment.companyName, status: c.investment.status,
        stage: c.investment.stage, total_invested: c.investment.totalInvested, fmv: c.investment.fmv, moic: c.investment.moic,
      })),
      updated_at: now,
    })
    .eq('id', letterId).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-sections')
  return done(data)
}

/** Set exactly which of this fund's investors a letter is shared with. Admin only (lib/access/admin-only.ts); only a final letter can be shared. */
export async function shareLetter(admin: Admin, ctx: { fundId: string; userId: string }, letterId: string, investorIds: string[]): Promise<Outcome<{ lp_investor_ids: string[] }>> {
  const db = admin as any
  const { data: letter } = await db.from('lp_letters').select('id, status').eq('id', letterId).eq('fund_id', ctx.fundId).maybeSingle()
  if (!letter) return fail(404, 'Letter not found')

  const requested = investorIds.filter((x): x is string => typeof x === 'string')
  const { data: validRows } = await db
    .from('lp_investors').select('id').eq('fund_id', ctx.fundId)
    .in('id', requested.length ? requested : ['00000000-0000-0000-0000-000000000000'])
  const valid = new Set(((validRows ?? []) as any[]).map(r => r.id))
  const target = requested.filter(id => valid.has(id))

  const { data: current } = await db.from('lp_letter_shares').select('lp_investor_id').eq('letter_id', letterId).eq('fund_id', ctx.fundId)
  const currentIds = new Set(((current ?? []) as any[]).map(r => r.lp_investor_id as string))
  const toRemove = Array.from(currentIds).filter(id => !target.includes(id))
  const toAdd = target.filter(id => !currentIds.has(id))
  // A draft has not been reviewed: it reaches no investor. Unsharing is always allowed.
  if (toAdd.length && letter.status !== 'final') return fail(409, 'Mark the letter final before sharing it with investors.')

  if (toRemove.length) {
    await db.from('lp_letter_shares').delete().eq('letter_id', letterId).eq('fund_id', ctx.fundId).in('lp_investor_id', toRemove)
  }
  if (toAdd.length) {
    const rows = toAdd.map(lp_investor_id => ({ letter_id: letterId, lp_investor_id, fund_id: ctx.fundId, shared_by: ctx.userId }))
    const { error } = await db.from('lp_letter_shares').insert(rows)
    if (error) return dbFail(error, 'lp-letters-share')
  }
  return done({ lp_investor_ids: target })
}
