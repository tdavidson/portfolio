// The LP letter tools (letter-tools-manifest.ts). Each calls the function the LP Letters pages
// call (lib/lp-letters/service.ts), with the caller's visible entities, so a letter of an entity
// they can't see is not found here either.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { unwrap } from '@/lib/service-outcome'
import { reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { siteOrigin } from '@/lib/site-links'
import { createLetter, getLetter, importLetter, letterData, listLetters, shareLetter, updateLetter, updateSection, writeLetterSections } from '@/lib/lp-letters/service'
import { briefForLetter, loadLetterBrief, proposeProfile, resolveTemplate, saveDraftLetter, writeWithFundAI, type LetterPeriod } from '@/lib/lp-letters/draft-from-brief'
import { LETTER_SKILL_MD, LETTER_SKILL_VERSION, letterVoice } from '@/lib/lp-letters/skill'
import { fromLetter } from '@/lib/lp-letters/content'
import { reviewLetter, reviewOptions } from '@/lib/lp-letters/review'
import { rateLimit } from '@/lib/rate-limit'
import { loadProfile, saveProfile } from '@/lib/lp-letters/profile-store'
import { exportLetter, LETTER_EXPORT_FORMATS, type LetterExportFormat } from '@/lib/lp-letters/export-letter'
import { requireUser } from './deals-tools'
import { resolveInvestor } from './lp-record-tools'

async function visible(ctx: AgentToolContext): Promise<string[] | null> {
  return (await entityScopeFor(ctx.admin, ctx.access)).vehicleNames
}

async function letterOf(ctx: AgentToolContext, id: unknown) {
  const letter = unwrap(await getLetter(ctx.admin, ctx.fundId, await visible(ctx), String(id ?? '')))
  if (!letter) throw new Error('No letter with that id. Use lp_letters to list them.')
  return letter
}

/** An entity and quarter the caller can see, from a tool's input. */
async function periodOf(ctx: AgentToolContext, input: any): Promise<LetterPeriod> {
  const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
  const v = await visible(ctx)
  if (v !== null && !v.includes(vehicle)) throw new Error('Not found')
  const year = Number(input?.year)
  const quarter = Number(input?.quarter)
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new Error('year must be a four-digit year')
  if (![1, 2, 3, 4].includes(quarter)) throw new Error('quarter must be 1 to 4')
  return { vehicle, year, quarter, yearEnd: !!input?.year_end }
}

const briefOpts = (input: any) => ({
  template: typeof input?.template === 'string' ? input.template : null,
  guidance: typeof input?.guidance === 'string' ? input.guidance.slice(0, 4000) : null,
  partnerNotes: typeof input?.partner_notes === 'string' ? input.partner_notes.slice(0, 6000) : null,
  sources: (Array.isArray(input?.sources) ? input.sources : [])
    .filter((d: any) => d && typeof d.text === 'string' && d.text.trim())
    .slice(0, 10)
    .map((d: any, i: number) => ({ name: String(d.name ?? `Source ${i + 1}`).slice(0, 200), text: String(d.text).slice(0, 50_000) })),
})

const summary = (l: any) => ({
  id: l.id, period: l.period_label, vehicle: l.portfolio_group, status: l.status, year_end: !!l.is_year_end, updated_at: l.updated_at,
  // How it was written: generated (by the fund's AI or an assistant), imported (a letter as sent), or
  // null for a letter from before this was recorded.
  source: l.source ?? null, generated_by: l.generated_by ?? null, skill_version: l.skill_version ?? null,
})

export const LETTER_HANDLERS: Record<string, AgentToolHandler> = {
  lp_letters: async (ctx: AgentToolContext, input: any) => {
    const vehicle = input?.vehicle ? await resolveVehicle(ctx.admin, ctx.fundId, String(input.vehicle), { access: ctx.access }) : null
    const letters = unwrap(await listLetters(ctx.admin, ctx.fundId, await visible(ctx)))
    return { letters: letters.filter(l => !vehicle || l.portfolio_group === vehicle).map(summary) }
  },

  lp_letter: async (ctx: AgentToolContext, input: any) => {
    const l = await letterOf(ctx, input?.letter_id)
    return {
      ...summary(l),
      prompt: l.generation_prompt ?? null,
      full_draft: l.full_draft ?? null,
      internal_notes: l.internal_notes ?? null,
      sections: fromLetter(l).sections.map(s => ({
        section_id: s.id, kind: s.kind, heading: s.heading, ...(s.company_id ? { company_id: s.company_id } : {}), text: s.body,
      })),
      generation_error: l.generation_error ?? null,
    }
  },

  lp_letter_data: async (ctx: AgentToolContext, input: any) => {
    const l = await letterOf(ctx, input?.letter_id)
    return { letter: summary(l), ...(await letterData(ctx.admin, ctx.fundId, l)) }
  },

  lp_letter_skill: async (ctx: AgentToolContext, input: any) => {
    const template = await resolveTemplate(ctx.admin, ctx.fundId, typeof input?.template === 'string' ? input.template : null)
    const voice = letterVoice(template)
    return {
      skill: 'lp-quarterly-letter',
      version: LETTER_SKILL_VERSION,
      files: {
        'SKILL.md': LETTER_SKILL_MD,
        ...(voice.structure ? { 'references/structure.md': voice.structure } : {}),
        'references/voice.md': voice.voice,
        ...(voice.examples ? { 'references/examples.md': voice.examples } : {}),
        ...(voice.houseRules ? { 'references/house-rules.md': voice.houseRules } : {}),
      },
      voice: voice.source === 'fund'
        ? { source: 'fund', template: voice.template, note: "The fund's own voice and examples, from its letter template. They replace the general voice and examples." + (voice.structure ? " Its structure (references/structure.md) replaces the skill's general outline." : '') }
        : { source: 'default', template: voice.template, note: "The skill's general voice: this fund has not saved its own." + (voice.structure ? " Its structure (references/structure.md) replaces the skill's general outline." : '') },
      ...(voice.houseRules ? { house_rules: "The fund's house rules (references/house-rules.md) apply to every letter. Follow them over the voice and examples." } : {}),
      next: 'Follow SKILL.md with these references. Get the facts from lp_letter_brief, and save with lp_draft_letter.',
    }
  },

  lp_letter_brief: async (ctx: AgentToolContext, input: any) => {
    const { brief, template } = await loadLetterBrief(ctx.admin, ctx.fundId, await periodOf(ctx, input), briefOpts(input))
    return { template: template.name, ...brief }
  },

  lp_draft_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const p = await periodOf(ctx, input)
    const given = typeof input?.text === 'string' && input.text.trim() ? String(input.text).trim() : null
    if (!given && await rateLimit({ key: `lp-letter-gen:${userId}`, limit: 5, windowSeconds: 300 })) {
      throw new Error('Too many letters drafted in the last few minutes. Try again shortly.')
    }
    const opts = briefOpts(input)
    const loaded = await loadLetterBrief(ctx.admin, ctx.fundId, p, opts)
    const { brief, investorNames } = loaded
    const text = given ?? await writeWithFundAI(ctx.admin, ctx.fundId, userId, brief, loaded.voice, opts.guidance)
    if (!text) throw new Error('The draft came back empty. Try again, or write it from lp_letter_brief and pass text.')
    const row = unwrap(await saveDraftLetter(
      ctx.admin, { fundId: ctx.fundId, userId, visible: await visible(ctx) }, p, text, loaded, opts.guidance, given ? 'assistant' : 'fund_ai',
      { partnerNotes: opts.partnerNotes, sources: opts.sources },
    ))
    return {
      letter: summary(row),
      template: loaded.template.name,
      written_by: given ? 'assistant' : 'fund AI',
      draft: text,
      sections: fromLetter(row).sections.map(s => ({ section_id: s.id, heading: s.heading })),
      review_flags: reviewLetter(fromLetter(row), brief, investorNames, row.internal_notes, reviewOptions(loaded)),
      missing_information: brief.missing_information,
      next:
        'This is a new, unshared draft. Show the user the draft and every review flag. Its "Missing information" section is ' +
        'kept with the letter as internal notes (lp_letter internal_notes) and is never shown to investors. Edits go through lp_write_letter ' +
        '(one section by section_id, or full_draft). Once a person has reviewed it, it is marked final (lp_write_letter mark_final) and only then can an ' +
        'admin share it (lp_share_letter).',
    }
  },

  lp_letter_pdf: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const l = await letterOf(ctx, input?.letter_id)
    if (l.status === 'generating') throw new Error('This letter is being generated. Ask again when it finishes.')
    const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId, kind: 'lp_letter', args: { letter: l.id } })
    return { document: `${l.period_label} letter (PDF)`, url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt }
  },

  lp_letter_export: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const l = await letterOf(ctx, input?.letter_id)
    if (l.status === 'generating') throw new Error('This letter is being generated. Ask again when it finishes.')
    const format = String(input?.format ?? 'docx') as LetterExportFormat
    if (!LETTER_EXPORT_FORMATS.includes(format)) throw new Error('format must be docx, pdf, markdown or json')
    const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId, kind: 'lp_letter', args: { letter: l.id, format } })
    const link = { document: `${l.period_label} letter (${format === 'docx' ? 'Word' : format === 'pdf' ? 'PDF' : format === 'json' ? 'JSON' : 'Markdown'})`, url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt }
    if (format === 'markdown' || format === 'json') {
      const out = await exportLetter(ctx.admin, ctx.fundId, l, format)
      const text = out ? out.body.toString('utf8') : ''
      return { ...link, ...(format === 'json' ? { letter: JSON.parse(text || 'null') } : { text }) }
    }
    return link
  },

  lp_create_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
    const year = Number(input?.year)
    const quarter = Number(input?.quarter)
    if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new Error('year must be a four-digit year')
    if (![1, 2, 3, 4].includes(quarter)) throw new Error('quarter must be 1 to 4')
    const row = unwrap(await createLetter(ctx.admin, { fundId: ctx.fundId, userId, visible: await visible(ctx) }, {
      period_year: year, period_quarter: quarter, portfolio_group: vehicle, is_year_end: !!input?.year_end,
      generation_prompt: input?.prompt ? String(input.prompt) : null,
    }))
    return { letter: summary(row), next: 'Get the figures with lp_letter_data and write the company sections with lp_write_letter.' }
  },

  lp_write_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const id = String(input?.letter_id ?? '')
    const v = await visible(ctx)
    const wctx = { fundId: ctx.fundId, userId, visible: v }
    const sections = Array.isArray(input?.sections) ? input.sections : null
    const fullDraft = typeof input?.full_draft === 'string' ? input.full_draft : undefined
    const markFinal = !!(input?.mark_final ?? input?.mark_complete)
    if (!sections && fullDraft === undefined && !markFinal) throw new Error('Pass sections, full_draft or mark_final.')
    if (sections) {
      const clean = sections.map((s: any) => ({
        section_id: s?.section_id ? String(s.section_id) : null,
        company_id: s?.company_id ? String(s.company_id) : null,
        heading: typeof s?.heading === 'string' ? s.heading : undefined,
        text: String(s?.text ?? s?.narrative ?? ''),
      }))
      if (clean.some((s: any) => (!s.section_id && !s.company_id) || !s.text.trim())) {
        throw new Error('Each section needs a section_id (or company_id) and its text.')
      }
      // Sections named by id are edited in place; companies named by id go through the company writer,
      // which also adds a section for a company the letter has none for.
      for (const s of clean.filter((s: any) => s.section_id)) {
        unwrap(await updateSection(ctx.admin, wctx, id, s.section_id, { body: s.text, ...(s.heading !== undefined ? { heading: s.heading } : {}) }))
      }
      const byCompany = clean.filter((s: any) => !s.section_id).map((s: any) => ({ company_id: s.company_id, narrative: s.text }))
      if (byCompany.length) unwrap(await writeLetterSections(ctx.admin, wctx, id, byCompany))
    }
    let row: any = null
    if (fullDraft !== undefined || markFinal) {
      row = unwrap(await updateLetter(ctx.admin, wctx, id, {
        ...(fullDraft !== undefined ? { full_draft: fullDraft } : {}),
        ...(markFinal ? { status: 'final' } : {}),
      }))
    } else {
      row = await letterOf(ctx, id)
    }
    // Text written from chat is reviewed against the letter's sources, as a drafted letter is.
    let review_flags: unknown[] | undefined
    if (fullDraft !== undefined || sections) {
      const loadedForReview = await briefForLetter(ctx.admin, ctx.fundId, row)
      const { brief, investorNames } = loadedForReview
      const touched = new Set(fromLetter(row).sections
        .filter(s => fullDraft !== undefined || sections!.some((x: any) => x?.section_id === s.id || (x?.company_id && x.company_id === s.company_id)))
        .map(s => s.id))
      review_flags = reviewLetter(fromLetter(row), brief, investorNames, row.internal_notes, reviewOptions(loadedForReview))
        .filter(f => fullDraft !== undefined || (f.section_id !== null && touched.has(f.section_id)))
    }
    return { letter: summary(row), sections_written: sections?.length ?? 0, ...(review_flags ? { review_flags } : {}) }
  },

  lp_share_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const l = await letterOf(ctx, input?.letter_id)
    const refs: unknown[] = Array.isArray(input?.investors) ? input.investors : []
    const investors = await Promise.all(refs.map(r => resolveInvestor(ctx.admin, ctx.fundId, String(r ?? ''))))
    const out = unwrap(await shareLetter(ctx.admin, { fundId: ctx.fundId, userId }, l.id, investors.map(i => i.id)))
    return {
      letter: summary(l),
      shared_with: investors.filter(i => out.lp_investor_ids.includes(i.id)).map(i => i.name),
      note: out.lp_investor_ids.length ? 'They see it in their portal now.' : 'The letter is no longer shared with anyone.',
    }
  },

  lp_letter_profile_get: async (ctx: AgentToolContext, input: any) => {
    const vehicle = input?.vehicle ? await resolveVehicle(ctx.admin, ctx.fundId, String(input.vehicle), { access: ctx.access }) : null
    const v = await visible(ctx)
    if (vehicle && v !== null && !v.includes(vehicle)) throw new Error('Not found')
    const loaded = await loadProfile(ctx.admin, ctx.fundId, vehicle)
    const proposed = input?.propose_from_last_letter && vehicle ? await proposeProfile(ctx.admin, ctx.fundId, ctx.userId ?? null, vehicle) : null
    return {
      vehicle: vehicle ?? 'firm-wide', profile: loaded.profile, own: loaded.own, firm_wide: loaded.firm, updated_at: loaded.updated_at,
      ...(input?.propose_from_last_letter
        ? proposed
          ? { proposed: proposed.profile, from_letter: proposed.letter, next: 'Show the person the proposed profile; save it with lp_letter_profile_save once they agree.' }
          : { proposed: null, note: vehicle ? 'No sent letter for this entity. Import one with lp_import_letter first.' : 'Name the entity whose last letter to read.' }
        : {}),
    }
  },

  lp_letter_profile_save: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = input?.vehicle ? await resolveVehicle(ctx.admin, ctx.fundId, String(input.vehicle), { access: ctx.access }) : null
    const v = await visible(ctx)
    if (vehicle && v !== null && !v.includes(vehicle)) throw new Error('Not found')
    const template = typeof input?.template === 'string' && input.template.trim() ? (await resolveTemplate(ctx.admin, ctx.fundId, input.template)).id : null
    const saved = unwrap(await saveProfile(ctx.admin, { fundId: ctx.fundId, userId, visible: v }, vehicle, { ...input, template_id: template }))
    return { vehicle: vehicle ?? 'firm-wide', profile: saved.profile }
  },

  lp_import_letter: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, String(input?.vehicle ?? '') || undefined, { access: ctx.access })
    const row = unwrap(await importLetter(ctx.admin, { fundId: ctx.fundId, userId, visible: await visible(ctx) }, {
      vehicle, year: Number(input?.year), quarter: Number(input?.quarter), yearEnd: !!input?.year_end, text: String(input?.text ?? ''),
    }))
    return { letter: summary(row), sections: fromLetter(row).sections.map(s => ({ section_id: s.id, heading: s.heading })) }
  },
}
