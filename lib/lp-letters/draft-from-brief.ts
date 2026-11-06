// A quarterly LP letter drafted from a brief (brief.ts): gathering its sources and saving the draft.
//
// Sources are the entity's portfolio as the letter generator sees it (aggregate.ts) plus the
// companies' stored updates for the quarter (company_updates). Structure and style are the fund's
// letter template (lp_letter_templates). Nothing about the fund's investors is read except their
// names, and only so they can be kept out.
//
// A draft is always a NEW letter, status draft, shared with no one: drafting never overwrites a
// letter someone has edited, completed or shared. Review, editing and sharing are the LP Letters
// page's (or lp_write_letter / lp_share_letter's), as for any other letter.

import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregatePortfolioData, type PortfolioPreview } from './aggregate'
import { buildPortfolioTableHtml } from './generate'
import { createLetter } from './service'
import { letterVoice, LETTER_SKILL_VERSION, type LetterVoice } from './skill'
import { splitInternal } from './internal'
import { sanitizeLetterHtml } from '@/lib/sanitize'
import { done, dbFail, type Outcome } from '@/lib/service-outcome'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import {
  buildLetterBrief, quarterBounds, writerPrompt,
  type LetterBrief, type StoredUpdate,
} from './brief'

type Admin = SupabaseClient

export interface LetterPeriod {
  vehicle: string
  year: number
  quarter: number
  yearEnd?: boolean
}

/** Updates arriving this long after quarter end, with no period of their own, count as the quarter's. */
const LATE_REPORTING_DAYS = 60

function updateInQuarter(u: any, year: number, quarter: number): boolean {
  if (u.period_year != null) {
    if (Number(u.period_year) !== year) return false
    if (u.period_quarter != null) return Number(u.period_quarter) === quarter
    if (u.period_month != null) return Math.ceil(Number(u.period_month) / 3) === quarter
    return false
  }
  const { start, end } = quarterBounds(year, quarter)
  const late = new Date(`${end}T00:00:00Z`)
  late.setUTCDate(late.getUTCDate() + LATE_REPORTING_DAYS)
  const received = String(u.received_at ?? '').slice(0, 10)
  return received >= start && received <= late.toISOString().slice(0, 10)
}

/** The quarter's stored updates per company, newest first, three at most. Sender details are not read. */
export async function quarterUpdates(admin: Admin, fundId: string, companyIds: string[], year: number, quarter: number): Promise<Map<string, StoredUpdate[]>> {
  const out = new Map<string, StoredUpdate[]>()
  if (!companyIds.length) return out
  const { data } = await (admin as any)
    .from('company_updates')
    .select('company_id, received_at, subject, period_label, period_year, period_quarter, period_month, body_current, body_original')
    .eq('fund_id', fundId)
    .in('company_id', companyIds)
    .order('received_at', { ascending: false })
    .limit(500)
  for (const u of (data ?? []) as any[]) {
    if (!updateInQuarter(u, year, quarter)) continue
    const text = String(u.body_current ?? u.body_original ?? '').trim()
    if (!text) continue
    const list = out.get(u.company_id) ?? []
    if (list.length < 3) list.push({ receivedAt: String(u.received_at), subject: u.subject ?? null, periodLabel: u.period_label ?? null, text })
    out.set(u.company_id, list)
  }
  return out
}

async function investorNames(admin: Admin, fundId: string): Promise<string[]> {
  const { data } = await (admin as any).from('lp_investors').select('name').eq('fund_id', fundId)
  return ((data ?? []) as any[]).map(r => String(r.name ?? '')).filter(Boolean)
}

/** A fund's saved letter template, or the built-in one (id null, no style guide of its own). */
export interface LetterTemplate {
  id: string | null
  name: string
  styleGuide: string | null
  examples?: string | null
  houseRules?: string | null
  structure?: string | null
}

const asTemplate = (t: any): LetterTemplate => ({
  id: t.id, name: t.name, styleGuide: t.style_guide, examples: t.examples ?? null, houseRules: t.house_rules ?? null, structure: t.structure ?? null,
})

/**
 * The letter template whose style guide is the letter's voice: the one asked for (by id or name),
 * else the fund's default, else none, and the skill's general voice applies (skill.ts). A name that
 * matches nothing is an error, so a typo doesn't quietly fall back.
 */
export async function resolveTemplate(admin: Admin, fundId: string, ref?: string | null): Promise<LetterTemplate> {
  const { data } = await (admin as any).from('lp_letter_templates')
    .select('id, name, style_guide, structure, examples, house_rules, is_default').eq('fund_id', fundId)
  const rows = ((data ?? []) as any[]).filter(t => t.style_guide || t.structure || t.house_rules)
  if (ref?.trim()) {
    const want = ref.trim().toLowerCase()
    const hit = rows.find(t => t.id === ref.trim() || String(t.name).toLowerCase() === want)
    if (!hit) throw new Error(`No letter template "${ref}". Templates: ${rows.map(t => t.name).join(', ') || 'none saved yet'}.`)
    return asTemplate(hit)
  }
  const def = rows.find(t => t.is_default)
  return def ? asTemplate(def) : { id: null, name: 'Default', styleGuide: null }
}

/**
 * A letter's template: the one it was created with, else (none chosen, or since deleted) the
 * fund's default, so a letter made without picking one is still written in the fund's voice.
 */
export async function templateForLetter(admin: Admin, fundId: string, templateId: string | null | undefined): Promise<LetterTemplate> {
  if (templateId) {
    try { return await resolveTemplate(admin, fundId, templateId) } catch { /* deleted: the default applies */ }
  }
  return resolveTemplate(admin, fundId, null)
}

export interface LoadedBrief {
  brief: LetterBrief
  preview: PortfolioPreview
  investorNames: string[]
  template: LetterTemplate
  voice: LetterVoice
}

export async function loadLetterBrief(
  admin: Admin, fundId: string, p: LetterPeriod, opts: { template?: string | null; guidance?: string | null } = {},
): Promise<LoadedBrief> {
  const template = await resolveTemplate(admin, fundId, opts.template)
  const voice = letterVoice(template)
  const preview = await aggregatePortfolioData(admin as any, fundId, p.year, p.quarter, p.vehicle, !!p.yearEnd)
  const ids = preview.companies.map(c => c.investment.companyId)
  const [updates, names] = await Promise.all([
    quarterUpdates(admin, fundId, ids, p.year, p.quarter),
    investorNames(admin, fundId),
  ])
  const brief = buildLetterBrief({
    preview, year: p.year, quarter: p.quarter, updates, investorNames: names, voice, guidance: opts.guidance,
  })
  return { brief, preview, investorNames: names, template, voice }
}

/** The fund's own AI provider writes the letter from the brief, in one call, in the layers of writerPrompt. */
export async function writeWithFundAI(
  admin: Admin, fundId: string, userId: string | null, brief: LetterBrief, voice: LetterVoice, guidance?: string | null,
): Promise<string> {
  const { provider, model, providerType } = await createFundAIProvider(admin as any, fundId)
  const result = await provider.createMessage({
    model,
    maxTokens: 8000,
    system:
      "You write a venture fund's quarterly letter to its limited partners. You write plainly and precisely, state bad news " +
      'directly, and never add a number or claim your sources do not contain. Plain text, no markdown.',
    content: writerPrompt(brief, voice, guidance),
  })
  await logAIUsage(admin as any, {
    fundId, userId: userId ?? undefined, provider: providerType, model, feature: 'lp-letter-draft', usage: result.usage,
  })
  return result.text.trim()
}

/**
 * Save a drafted letter as a new letter: status draft, shared with no one. The portfolio table and
 * summary come from the books, as for a generated letter, so the PDF and export carry the same
 * figures the draft was written from.
 */
export async function saveDraftLetter(
  admin: Admin, ctx: { fundId: string; userId: string; visible: string[] | null },
  p: LetterPeriod, text: string, loaded: Pick<LoadedBrief, 'preview' | 'template'>, guidance?: string | null,
  generatedBy: 'fund_ai' | 'assistant' = 'fund_ai',
): Promise<Outcome<any>> {
  const { preview } = loaded
  const { body, internal } = splitInternal(text)
  const created = await createLetter(admin, ctx, {
    period_year: p.year, period_quarter: p.quarter, portfolio_group: p.vehicle, is_year_end: !!p.yearEnd,
    template_id: loaded.template.id, generation_prompt: guidance?.trim() || null,
  })
  if (!created.ok) return created
  const { data, error } = await (admin as any)
    .from('lp_letters')
    .update({
      // The "Missing information" section is kept with the letter, apart from what investors see.
      full_draft: body,
      internal_notes: internal,
      source: 'generated',
      generated_by: generatedBy,
      skill_version: LETTER_SKILL_VERSION,
      portfolio_table_html: sanitizeLetterHtml(buildPortfolioTableHtml(preview)) ?? '',
      portfolio_summary: preview.companies.map(c => ({
        company_id: c.investment.companyId, company_name: c.investment.companyName, status: c.investment.status,
        stage: c.investment.stage, total_invested: c.investment.totalInvested, fmv: c.investment.fmv, moic: c.investment.moic,
      })),
      status: 'draft',
      updated_at: new Date().toISOString(),
    })
    .eq('id', created.value.id).eq('fund_id', ctx.fundId).select().single()
  if (error) return dbFail(error, 'lp-letters-draft')
  return done(data)
}
