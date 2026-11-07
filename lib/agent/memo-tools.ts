// Handlers for the investment MEMO tools (manifest: memo-tools-manifest.ts). Each calls the same
// function the Diligence pages do (lib/memo-agent/*), so a memo written, saved, exported or set up in
// a chat is the same as one done in the app. Writes from a connected chat are staged for approval,
// except saving a memo or research into the deal's open draft (lib/agent/dispatch.ts DRAFT_ONLY).

import { linkNote } from '@/lib/agent/report-links'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { unwrap } from '@/lib/service-outcome'
import { parseUpdateFiles } from '@/lib/company-updates/submit'
import { extractText } from '@/lib/memo-agent/extract-text'
import { resolveDeal } from './diligence-tools'
import { requireUser } from './deals-tools'
import { MEMO_SKILL_MD, MEMO_SKILL_VERSION } from '@/lib/memo-agent/skill'
import { getMemoVoice, getMemoVoiceRow, learnMemoVoice, memoVoiceEdit, sampleMemoTexts, saveMemoVoice } from '@/lib/memo-agent/voice-store'
import { latestDraftRow, loadMemoBrief, memoSections } from '@/lib/memo-agent/brief'
import { addResearchFindings, importWordMemo, saveMemoDraft } from '@/lib/memo-agent/assistant-memo'
import { describeDesignTemplate, STYLE_ANCHOR_BUCKET } from '@/lib/memo-agent/design'
import { designSections, schemaSectionsOf } from '@/lib/memo-agent/design-sections'
import { ensureDefaults, getActiveSchema, getActiveSchemas, saveSchema } from '@/lib/memo-agent/firm-schemas'
import { SCHEMA_NAMES, type SchemaName } from '@/lib/memo-agent/validate'
import { runRenderJob } from '@/lib/memo-agent/jobs/render-job'
import type { MemoTemplateConfig } from '@/lib/memo-agent/prompts/memo-config'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const DEPTHS = new Set(['brief', 'standard', 'detailed', 'comprehensive'])

/** A sample memo (style anchor) by id or title / file name. */
async function resolveSampleMemo(admin: SupabaseClient, fundId: string, ref: string): Promise<{ id: string; label: string }> {
  const { data } = await (admin as any).from('style_anchor_memos').select('id, title, file_name').eq('fund_id', fundId)
  const rows = ((data as any[]) ?? [])
  const needle = ref.toLowerCase()
  const hit = rows.find(r => r.id === ref) ?? rows.filter(r => [r.title, r.file_name].some((x: string | null) => x?.toLowerCase() === needle))[0]
    ?? (rows.filter(r => [r.title, r.file_name].some((x: string | null) => x?.toLowerCase().includes(needle))).length === 1
      ? rows.find(r => [r.title, r.file_name].some((x: string | null) => x?.toLowerCase().includes(needle))) : null)
  if (!hit) throw new Error(`No sample memo "${ref}". This fund has: ${rows.slice(0, 10).map(r => r.title || r.file_name).join(', ') || 'none yet'}.`)
  return { id: hit.id, label: hit.title || hit.file_name }
}

export const MEMO_HANDLERS: Record<string, AgentToolHandler> = {
  diligence_memo_skill: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = str(input?.deal) ? await resolveDeal(admin, fundId, str(input.deal), access) : null
    const [voice, sections, design] = await Promise.all([
      getMemoVoice(admin, fundId),
      memoSections(admin, fundId, (deal?.memo_template_config ?? null) as MemoTemplateConfig | null),
      describeDesignTemplate(admin, fundId),
    ])
    return {
      skill: 'investment-memo',
      version: MEMO_SKILL_VERSION,
      files: {
        'SKILL.md': MEMO_SKILL_MD,
        'references/voice.md': voice.voice,
        ...(voice.examples ? { 'references/examples.md': voice.examples } : {}),
        ...(voice.houseRules ? { 'references/house-rules.md': voice.houseRules } : {}),
      },
      voice: voice.source === 'fund'
        ? { source: 'fund', note: "The fund's own memo voice and examples, learned from its memos and edited by the partners. They replace the general ones." }
        : { source: 'default', note: "The skill's general voice: this fund has not saved its own (diligence_memo_voice_learn, then diligence_memo_voice_save)." },
      ...(voice.houseRules ? { house_rules: "The fund's house rules (references/house-rules.md) apply to every memo. Follow them over the voice and examples, never over the hard rules." } : {}),
      sections: sections.map(s => ({ id: s.id, title: s.title, depth: s.depth, partner_only: s.partner_only, covers: s.covers })),
      sections_for: deal ? deal.name : 'the fund default',
      design: design.status === 'ready'
        ? { template: design.anchor.title || design.anchor.file_name, headings: design.design.headings, first_page_fields: design.design.fields.map(f => f.label), note: 'Exports copy this sample memo\'s Word design; the memo\'s header fields fill its first page.' }
        : design.status === 'unusable' ? { template: design.anchor.title || design.anchor.file_name, problem: design.reason } : null,
      next: 'Follow SKILL.md with these references and sections. Get the facts from diligence_memo_brief, and save with diligence_draft_memo.',
    }
  },

  diligence_memo_brief: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const brief = await loadMemoBrief(admin, fundId, deal)
    if (!brief.draft_id) return { ...brief, note: 'This deal has no evidence yet: analyze its data room first (diligence_run_agent with stage "analyze").' }
    return brief
  },

  diligence_draft_memo: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const saved = unwrap(await saveMemoDraft(admin, { fundId, userId }, deal, {
      paragraphs: Array.isArray(input?.paragraphs) ? input.paragraphs : [],
      header: input?.header && typeof input.header === 'object' ? input.header : undefined,
      attention: Array.isArray(input?.attention) ? input.attention : undefined,
      notes: typeof input?.notes === 'string' ? input.notes : undefined,
    }, 'assistant'))
    const mustFix = saved.flags.filter(f => f.severity === 'must_fix').length
    return {
      deal: deal.name, ...saved,
      next: mustFix
        ? `${mustFix} flag${mustFix === 1 ? '' : 's'} must be fixed: correct the paragraphs and save again (a new draft), and tell the person about any you can't fix.`
        : 'Show the person the memo and any flags to check. A partner writes the recommendation and finalizes it in the app.',
    }
  },

  diligence_add_research: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    return { deal: deal.name, ...unwrap(await addResearchFindings(admin, { fundId, userId }, deal, input?.findings)) }
  },

  diligence_memo_voice: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const row = await getMemoVoiceRow(admin, fundId)
    const out: Record<string, unknown> = {
      saved: row?.voice ? { voice: row.voice, house_rules: row.house_rules, examples: row.examples, learned_from: row.learned_from ?? [], updated_at: row.updated_at } : null,
      note: row?.voice ? "The fund's memo voice, used for every memo." : 'No memo voice saved: memos use the general voice in the investment-memo skill.',
    }
    if (input?.include_sample_memos === true) {
      const docs = await sampleMemoTexts(admin, fundId)
      out.sample_memos = docs.map(d => ({ id: d.id, filename: d.filename, text: d.text.slice(0, 40_000) }))
      out.learning = 'Learn the voice, house rules and examples from these. Examples must use invented companies, people and figures. ' +
        'Never copy a fact from a sample memo. Show the person the result, then save with diligence_memo_voice_save.'
    }
    return out
  },

  diligence_memo_voice_learn: async ({ admin, fundId, userId }: AgentToolContext, input: any) => {
    const ids = Array.isArray(input?.sample_memos) ? input.sample_memos.filter((x: unknown) => typeof x === 'string') : undefined
    const learned = unwrap(await learnMemoVoice(admin, { fundId, userId }, ids))
    return { ...learned, next: 'Show the person this draft. Replace any reused names or figures, then save it with diligence_memo_voice_save.' }
  },

  diligence_memo_voice_save: async ({ admin, fundId, userId }: AgentToolContext, input: any) => {
    const edit = unwrap(memoVoiceEdit(input))
    return { saved: unwrap(await saveMemoVoice(admin, { fundId, userId }, edit)) }
  },

  diligence_memo_settings: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    await ensureDefaults(fundId, admin as any)
    const [{ data: settings }, { data: anchors }, { data: presets }, schemas, design] = await Promise.all([
      (admin as any).from('fund_settings').select('memo_first_page_anchor_id, memo_design_anchor_id').eq('fund_id', fundId).maybeSingle(),
      (admin as any).from('style_anchor_memos').select('id, title, file_name, file_format, voice_representativeness').eq('fund_id', fundId).order('uploaded_at', { ascending: false }),
      (admin as any).from('fund_memo_presets').select('id, name, default_for_stage, memo_template_config, partner_memo_guidance').eq('fund_id', fundId),
      getActiveSchemas(fundId, admin as any),
      describeDesignTemplate(admin, fundId),
    ])
    const out: Record<string, unknown> = {
      design_template: design.status === 'ready'
        ? { id: design.anchor.id, name: design.anchor.title || design.anchor.file_name, headings: design.design.headings, first_page_fields: design.design.fields, warnings: design.design.warnings }
        : design.status === 'unusable' ? { id: design.anchor.id, name: design.anchor.title || design.anchor.file_name, problem: design.reason } : null,
      first_page_exemplar: (settings as any)?.memo_first_page_anchor_id ?? null,
      sample_memos: ((anchors as any[]) ?? []).map(a => ({ id: a.id, name: a.title || a.file_name, format: a.file_format, voice: a.voice_representativeness, can_be_design_template: String(a.file_format).toLowerCase() === 'docx' })),
      schemas: Object.fromEntries(SCHEMA_NAMES.map(n => [n, (schemas as any)[n]?.schema_version ?? null])),
      presets: ((presets as any[]) ?? []).map(p => ({ id: p.id, name: p.name, default_for_stage: p.default_for_stage, sections: (p.memo_template_config?.sections ?? []).map((s: any) => s.title) })),
    }
    if (str(input?.deal)) {
      const deal = await resolveDeal(admin, fundId, str(input.deal), access)
      const cfg = (deal.memo_template_config ?? {}) as MemoTemplateConfig
      out.deal = {
        name: deal.name,
        sections: await memoSections(admin, fundId, cfg),
        sections_source: cfg.sections?.length ? 'deal' : design.status === 'ready' && design.design.headings.length ? 'design template' : 'memo_output schema',
        partner_guidance: deal.partner_memo_guidance ?? '',
        analyst_persona: cfg.analyst_persona ?? '',
        style: cfg.style_override ?? null,
      }
    }
    const schema = str(input?.schema)
    if (schema) {
      if (!SCHEMA_NAMES.includes(schema as SchemaName)) throw new Error(`Unknown schema "${schema}".`)
      const row = await getActiveSchema(fundId, schema as SchemaName, admin as any)
      out.schema = { name: schema, version: row?.schema_version ?? null, yaml: row?.yaml_content ?? '' }
    }
    return out
  },

  diligence_memo_settings_save: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const done: string[] = []
    const fundPatch: Record<string, unknown> = {}
    for (const [key, col] of [['design_template', 'memo_design_anchor_id'], ['first_page_exemplar', 'memo_first_page_anchor_id']] as const) {
      if (typeof input?.[key] !== 'string') continue
      const ref = input[key].trim()
      if (!ref) { fundPatch[col] = null; done.push(`${key.replace('_', ' ')} cleared`); continue }
      const memo = await resolveSampleMemo(admin, fundId, ref)
      fundPatch[col] = memo.id
      done.push(`${key.replace('_', ' ')} set to ${memo.label}`)
    }
    if (Object.keys(fundPatch).length) {
      const { error } = await (admin as any).from('fund_settings').update(fundPatch).eq('fund_id', fundId)
      if (error) throw new Error('Could not save the memo settings.')
    }

    if (str(input?.deal)) {
      const deal = await resolveDeal(admin, fundId, str(input.deal), access)
      const cfg: MemoTemplateConfig = { ...((deal.memo_template_config ?? {}) as MemoTemplateConfig) }
      const patch: Record<string, unknown> = {}
      if (input?.use_design_sections === true) {
        const design = await describeDesignTemplate(admin, fundId)
        if (design.status !== 'ready') throw new Error(design.status === 'unusable' ? design.reason : 'The fund has no design template.')
        cfg.sections = (await designSections(admin, fundId, design.design.headings)).map(s => ({ ...s, complexity: 'standard' as const }))
        done.push(`${deal.name}'s sections set from the design template`)
      } else if (Array.isArray(input?.sections)) {
        const schema = await getActiveSchema(fundId, 'memo_output', admin as any)
        const known = schemaSectionsOf(schema?.yaml_content ?? '')
        cfg.sections = (input.sections as any[]).slice(0, 50).filter(s => str(s?.title)).map(s => {
          const match = known.find(k => k.id === str(s.id) || k.title.toLowerCase() === str(s.title).toLowerCase())
          const id = match?.id ?? (str(s.id) || `custom_${str(s.title).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`)
          return {
            id, title: str(s.title).slice(0, 120), included: s.included !== false,
            ...(DEPTHS.has(s.depth) ? { complexity: s.depth } : {}),
            ...(match ? {} : { custom: true, cover: str(s.cover).slice(0, 500) }),
          }
        })
        done.push(`${deal.name}'s sections saved`)
      }
      if (typeof input?.analyst_persona === 'string') { cfg.analyst_persona = input.analyst_persona.slice(0, 500); done.push('analyst persona saved') }
      if (typeof input?.partner_guidance === 'string') { patch.partner_memo_guidance = input.partner_guidance.slice(0, 10_000); done.push('partner guidance saved') }
      patch.memo_template_config = cfg
      const { error } = await (admin as any).from('diligence_deals').update(patch).eq('id', deal.id).eq('fund_id', fundId)
      if (error) throw new Error("Could not save the deal's memo settings.")
    }

    if (str(input?.schema)) {
      const name = str(input.schema) as SchemaName
      if (!SCHEMA_NAMES.includes(name)) throw new Error(`Unknown schema "${name}".`)
      if (!str(input?.schema_yaml)) throw new Error('schema_yaml is required to save a schema.')
      const result = await saveSchema(fundId, name, String(input.schema_yaml), requireUser(userId), str(input?.schema_note) || null, {}, admin as any)
      if (!result.ok) {
        const errs = (result.errors ?? []).map((e: any) => e.message ?? String(e))
        const warns = (result.warnings ?? []).map((w: any) => w.message ?? String(w))
        throw new Error(`The ${name} schema was not saved. ${[...errs, ...warns].slice(0, 10).join(' ')}`)
      }
      done.push(`${name} schema saved`)
    }
    if (!done.length) throw new Error('Nothing to change: pass design_template, first_page_exemplar, a deal with its settings, or a schema.')
    return { done }
  },

  diligence_add_sample_memo: async ({ admin, fundId, userId }: AgentToolContext, input: any) => {
    const [file] = parseUpdateFiles(input?.file ? [input.file] : [])
    if (!file) throw new Error('Send the memo as file: { filename, content_base64 }.')
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
    if (!['pdf', 'docx', 'md', 'markdown', 'txt'].includes(ext)) throw new Error('A sample memo is a PDF, Word (.docx) or Markdown file.')
    const storagePath = `${fundId}/${Date.now()}_${file.name}`
    const { error: upErr } = await admin.storage.from(STYLE_ANCHOR_BUCKET).upload(storagePath, file.bytes, { contentType: file.type, upsert: false })
    if (upErr) throw new Error('Could not store the memo.')
    const text = await extractText(file.bytes, ext)
    const voice = ['exemplary', 'representative', 'atypical', 'do_not_match_voice'].includes(input?.voice) ? input.voice : 'representative'
    const { data: row, error } = await (admin as any).from('style_anchor_memos').insert({
      fund_id: fundId, storage_path: storagePath, file_name: file.name,
      file_format: ext === 'markdown' || ext === 'txt' ? 'md' : ext, file_size_bytes: file.bytes.length,
      extracted_text: text, extracted_at: text ? new Date().toISOString() : null, uploaded_by: userId,
      voice_representativeness: voice, anonymized: false,
      ...(str(input?.title) ? { title: str(input.title).slice(0, 200) } : {}),
      ...(str(input?.notes) ? { partner_notes: str(input.notes).slice(0, 2000) } : {}),
    }).select('id, file_name, file_format').single()
    if (error || !row) {
      await admin.storage.from(STYLE_ANCHOR_BUCKET).remove([storagePath]).catch(() => {})
      throw new Error('Could not save the sample memo.')
    }
    return {
      sample_memo: row, text_extracted: !!text,
      next: (row as any).file_format === 'docx'
        ? 'It can be the design template: diligence_memo_settings_save with design_template.'
        : 'Only a Word (.docx) sample memo can be the design template.',
    }
  },

  diligence_memo_export: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const format = str(input?.format) || 'docx'
    if (!['docx', 'gdoc', 'pdf', 'markdown'].includes(format)) throw new Error('format is docx, gdoc, pdf or markdown.')
    let draftId = str(input?.draft_id)
    if (draftId) {
      const { data } = await (admin as any).from('diligence_memo_drafts').select('id').eq('id', draftId).eq('deal_id', deal.id).eq('fund_id', fundId).maybeSingle()
      if (!data) throw new Error('That draft is not one of this deal\'s.')
    } else {
      const latest = await latestDraftRow(admin, fundId, deal.id)
      if (!latest?.memo_draft_output) throw new Error('This deal has no memo yet.')
      draftId = latest.id
    }
    const result = await runRenderJob(admin as any, { id: 'sync', fund_id: fundId, deal_id: deal.id, draft_id: draftId, payload: { format } } as any)
    const out = { deal: deal.name, draft_id: draftId, ...(result as object) }
    // A Word or PDF render is a download link; markdown comes back as text, and a Google Doc is a view link.
    return format === 'docx' || format === 'pdf'
      ? { ...out, note: linkNote('The link works for 24 hours. For the memo as text, call this tool again with format "markdown".') }
      : out
  },

  diligence_import_memo: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const [file] = parseUpdateFiles(input?.file ? [input.file] : [])
    if (!file || !/\.docx$/i.test(file.name)) throw new Error('Send the edited memo as a Word (.docx) file: { filename, content_base64 }.')
    let draftId = str(input?.draft_id)
    if (!draftId) {
      const latest = await latestDraftRow(admin, fundId, deal.id)
      if (!latest) throw new Error('This deal has no memo yet.')
      draftId = latest.id
    }
    return { deal: deal.name, ...unwrap(await importWordMemo(admin, { fundId, userId }, deal, draftId, file.bytes)) }
  },
}
