// LP letters, for the web routes (app/api/lp-letters/**) and the agent tools (lib/agent/letter-tools.ts).
//
// A letter belongs to one entity (its portfolio_group), so every read and write here takes the
// caller's visible entity names (null = all of them) and treats a letter of another entity as not
// found, the way the list route always filtered it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { groupWriteDenial } from '@/lib/access/scope'
import { aggregatePortfolioData } from './aggregate'
import { buildPortfolioTableHtml } from './generate'
import type { PortfolioPreview } from './aggregate'
import { splitInternal } from './internal'
import { isContent, parseLetterText, narrativesOf, renderLetterText, reparse, replaceSection, fromLetter, orderCompanies, type LetterContent, type LetterSection } from './content'
import { sanitizeLetterHtml } from '@/lib/sanitize'

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

/**
 * The columns a letter's content is stored in: the content itself, and the copies older readers use
 * (full_draft for the portal, PDF and exports; company_narratives for older tools).
 */
export function contentColumns(content: LetterContent, userId: string | null, at = new Date().toISOString()) {
  return { content, full_draft: renderLetterText(content), company_narratives: narrativesOf(content, userId, at) }
}

/** Company sections written into a letter: each replaces its company's, and a new one goes after the last company. */
export function withCompanySections(content: LetterContent, given: { id: string; name: string; body: string }[]): LetterContent {
  let out = content
  for (const g of given) {
    const id = `company:${g.id}`
    if (out.sections.some(s => s.id === id)) { out = replaceSection(out, id, { body: g.body.trim() }); continue }
    const section: LetterSection = { id, kind: 'company', heading: g.name, body: g.body.trim(), company_id: g.id }
    const last = out.sections.map(s => s.kind).lastIndexOf('company')
    const at = last === -1 ? out.sections.length : last + 1
    out = { ...out, sections: [...out.sections.slice(0, at), section, ...out.sections.slice(at)] }
  }
  return out
}

/** A letter's content from a request: only the known fields of each section, as text. */
export function cleanContent(x: unknown): LetterContent | null {
  if (!isContent(x)) return null
  const sections: LetterSection[] = []
  for (const s of x.sections as any[]) {
    if (!s || typeof s.id !== 'string' || !s.id || typeof s.body !== 'string') return null
    const kind = s.kind === 'company' || s.kind === 'fund' ? s.kind : 'text'
    sections.push({
      id: s.id.slice(0, 200), kind,
      heading: typeof s.heading === 'string' ? s.heading.slice(0, 300) : null,
      body: s.body.slice(0, 50_000),
      ...(kind === 'company' && typeof s.company_id === 'string' ? { company_id: s.company_id } : {}),
      ...(s.sources && typeof s.sources === 'object' ? { sources: s.sources } : {}),
    })
  }
  return { version: 1, sections }
}

export interface LetterChanges {
  /** The structured letter; full_draft and company_narratives are made from it. */
  content?: unknown
  company_narratives?: unknown
  full_draft?: unknown
  /** The partners' notes kept with the letter and never shown to investors (internal.ts). */
  internal_notes?: unknown
  /** The partners' notes for writing this letter: a source, never shown to investors. */
  partner_notes?: unknown
  status?: unknown
  generation_prompt?: unknown
  company_prompts?: unknown
}

export async function updateLetter(admin: Admin, ctx: { fundId: string; visible: Visible; userId?: string | null }, letterId: string, input: LetterChanges): Promise<Outcome<any>> {
  const found = await getLetter(admin, ctx.fundId, ctx.visible, letterId)
  if (!found.ok) return found
  if (!found.value) return fail(404, 'Not found')

  const { company_narratives, full_draft, internal_notes, status, generation_prompt, company_prompts } = input
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (internal_notes !== undefined) updates.internal_notes = internal_notes == null ? null : String(internal_notes)
  if (input.partner_notes !== undefined) updates.partner_notes = input.partner_notes == null ? null : String(input.partner_notes).slice(0, 20_000).trim() || null
  // A "Missing information" section written into the text moves to the internal notes, so it can
  // never be shared with the letter.
  if (company_narratives !== undefined && input.content === undefined && full_draft === undefined) {
    // Company sections by the old shape: each replaces its company's section in the letter.
    if (!Array.isArray(company_narratives)) return fail(400, 'company_narratives must be a list')
    const given = (company_narratives as any[])
      .filter(n => n && typeof n.company_id === 'string' && typeof n.narrative === 'string')
      .map(n => ({ id: n.company_id as string, name: String(n.company_name ?? ''), body: n.narrative as string }))
    Object.assign(updates, contentColumns(withCompanySections(fromLetter(found.value), given), ctx.userId ?? null))
  }
  if (input.content !== undefined) {
    const content = cleanContent(input.content)
    if (!content) return fail(400, 'content must be a letter: { version: 1, sections: [{ id, heading, body }] }')
    // Sources are the letter's own record of what it was written from; a caller can't replace them.
    const prior = new Map(fromLetter(found.value).sections.map(s => [s.id, s.sources]))
    const kept = { ...content, sections: content.sections.map(s => ({ ...s, sources: prior.get(s.id) })) }
    Object.assign(updates, contentColumns(kept, ctx.userId ?? null))
  } else if (full_draft !== undefined) {
    // The whole letter as text: split into the letter's sections again, keeping their sources.
    const { body, internal } = splitInternal(full_draft == null ? null : String(full_draft))
    if (full_draft == null) updates.full_draft = null
    else Object.assign(updates, contentColumns(reparse(found.value, body ?? ''), ctx.userId ?? null))
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

/** The portfolio as a letter stores it for its table and exports. */
export function portfolioSummaryOf(preview: PortfolioPreview) {
  return preview.companies.map(c => ({
    company_id: c.investment.companyId, company_name: c.investment.companyName, status: c.investment.status,
    stage: c.investment.stage, total_invested: c.investment.totalInvested, fmv: c.investment.fmv, moic: c.investment.moic,
  }))
}

/** One section of a letter edited: its text, or its heading. */
export async function updateSection(
  admin: Admin, ctx: { fundId: string; userId: string; visible: Visible }, letterId: string, sectionId: string,
  change: { body?: unknown; heading?: unknown },
): Promise<Outcome<any>> {
  const found = await getLetter(admin, ctx.fundId, ctx.visible, letterId)
  if (!found.ok) return found
  const letter = found.value
  if (!letter) return fail(404, 'Not found')
  if (letter.status === 'generating') return fail(409, 'This letter is being generated. Try again when it finishes.')
  if (change.body !== undefined && typeof change.body !== 'string') return fail(400, 'body must be text')
  if (change.heading !== undefined && change.heading !== null && typeof change.heading !== 'string') return fail(400, 'heading must be text')
  let content: LetterContent
  try {
    content = replaceSection(fromLetter(letter), sectionId, {
      ...(typeof change.body === 'string' ? { body: change.body.slice(0, 50_000) } : {}),
      ...(change.heading !== undefined ? { heading: (change.heading as string | null)?.slice(0, 300) ?? null } : {}),
    })
  } catch (e) {
    return fail(404, (e as Error).message)
  }
  const { data, error } = await (admin as any)
    .from('lp_letters').update({ ...contentColumns(content, ctx.userId), updated_at: new Date().toISOString() })
    .eq('id', letterId).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-section')
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

  // Sections given replace those companies'; the rest of the letter keeps what it had.
  const now = new Date().toISOString()
  const content = orderCompanies(withCompanySections(
    fromLetter(letter),
    sections.map(sec => ({ id: sec.company_id, name: byId.get(sec.company_id)!, body: sec.narrative })),
  ), preview.companies.map(c => c.investment.companyId))
  const { data, error } = await (admin as any)
    .from('lp_letters')
    .update({
      ...contentColumns(content, ctx.userId, now),
      portfolio_table_html: sanitizeLetterHtml(buildPortfolioTableHtml(preview)) ?? '',
      portfolio_summary: portfolioSummaryOf(preview),
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

/** At most this many documents per letter, each kept to this many characters of text. */
export const MAX_LETTER_SOURCES = 10
export const MAX_SOURCE_TEXT = 50_000

/**
 * Add documents to a letter as sources, as text, or take one off. They are the letter's own: read
 * into its brief when it is written, rewritten or reviewed, and never shown to investors.
 */
export async function changeLetterSources(
  admin: Admin, ctx: { fundId: string; userId: string; visible: Visible }, letterId: string,
  change: { add?: { name: string; text: string }[]; remove?: string },
): Promise<Outcome<any>> {
  const found = await getLetter(admin, ctx.fundId, ctx.visible, letterId)
  if (!found.ok) return found
  const letter = found.value
  if (!letter) return fail(404, 'Not found')
  const current = (Array.isArray(letter.source_documents) ? letter.source_documents : []) as any[]
  let next = current.filter(d => !change.remove || d?.id !== change.remove)
  if (change.remove && next.length === current.length) return fail(404, 'No such source on this letter.')
  if (change.add?.length) {
    const at = new Date().toISOString()
    const added = change.add
      .filter(d => d.text.trim())
      .map((d, i) => ({ id: `src-${Date.now().toString(36)}-${i}`, name: d.name.slice(0, 200), text: d.text.slice(0, MAX_SOURCE_TEXT), added_at: at, added_by: ctx.userId }))
    if (current.length + added.length > MAX_LETTER_SOURCES) return fail(400, `A letter can have at most ${MAX_LETTER_SOURCES} source documents.`)
    next = [...next, ...added]
  }
  const { data, error } = await (admin as any)
    .from('lp_letters').update({ source_documents: next, updated_at: new Date().toISOString() })
    .eq('id', letterId).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-sources')
  return done(data)
}

export interface ImportedLetter {
  vehicle: string
  year: number
  quarter: number
  yearEnd?: boolean
  /** The letter's text as sent. */
  text: string
  /** The file as sent, once stored (lp-letter-originals). */
  originalFile?: { path: string; name: string; type: string; size: number } | null
}

/**
 * A letter as it was sent, brought in: final (a person sent it), source "imported", its text split
 * into sections like any other, its partners' notes (if it had them) kept apart. It then counts as
 * the entity's last sent letter for the next brief, and can seed the entity's letter profile.
 */
export async function importLetter(admin: Admin, ctx: { fundId: string; userId: string; visible: Visible }, input: ImportedLetter): Promise<Outcome<any>> {
  if (!Number.isInteger(input.year) || input.year < 1990 || input.year > 2100) return fail(400, 'year must be a four-digit year')
  if (![1, 2, 3, 4].includes(input.quarter)) return fail(400, 'quarter must be 1 to 4')
  if (!input.text?.trim()) return fail(400, 'The letter has no text.')
  const created = await createLetter(admin, ctx, {
    period_year: input.year, period_quarter: input.quarter, portfolio_group: input.vehicle, is_year_end: !!input.yearEnd,
  })
  if (!created.ok) return created
  const { data: companies } = await (admin as any).from('companies').select('id, name').eq('fund_id', ctx.fundId).eq('holding_type', 'company')
  const known = ((companies ?? []) as any[]).filter(c => c.name).map(c => ({ id: String(c.id), name: String(c.name) }))
  const { body, internal } = splitInternal(input.text.replace(/\r\n?/g, '\n').trim())
  const content = parseLetterText(body ?? '', { companies: known })
  const { data, error } = await (admin as any)
    .from('lp_letters')
    .update({
      ...contentColumns(content, ctx.userId),
      internal_notes: internal,
      source: 'imported',
      status: 'final',
      original_file: input.originalFile ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', created.value.id).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-import')
  return done(data)
}
