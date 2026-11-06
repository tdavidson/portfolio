// Letter templates as the fund's voice: learning one from past letters, editing it, and choosing
// which one letters are written in. The routes under app/api/lp-letters/templates call these.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { learnVoicePrompt, parseLearnedVoice, reusedFromSources, MAX_DOCUMENTS, type SourceDocument } from './learn-voice'

type Admin = SupabaseClient

/** What a person may change on a template. */
export interface TemplateEdit {
  name?: string
  structure?: string | null
  style_guide?: string | null
  examples?: string | null
  house_rules?: string | null
}

const LIMITS = { name: 200, structure: 100_000, style_guide: 100_000, examples: 100_000, house_rules: 20_000 } as const

/** A template edit from a request body: only the known fields, as text, within their limits. */
export function templateEdit(body: any): Outcome<TemplateEdit> {
  const out: TemplateEdit = {}
  for (const key of ['name', 'structure', 'style_guide', 'examples', 'house_rules'] as const) {
    if (body?.[key] === undefined) continue
    const v = body[key]
    if (v !== null && typeof v !== 'string') return fail(400, `${key} must be text`)
    if (typeof v === 'string' && v.length > LIMITS[key]) return fail(400, `${key} is too long (at most ${LIMITS[key].toLocaleString()} characters)`)
    if (key === 'name') {
      if (!v?.trim()) return fail(400, 'A template needs a name')
      out.name = v.trim()
    } else {
      out[key] = v?.trim() ? v : null
    }
  }
  return done(out)
}

export interface LearnedTemplate {
  template: any
  /** Names and figures in the learned examples that also appear in the documents, to replace. */
  reused: string[]
}

/**
 * Learn a voice from the fund's past letters or memos with the fund's own AI, and save it as a new
 * template that is NOT the fund's voice yet: a person reviews and edits it, then chooses it.
 */
export async function learnVoiceTemplate(
  admin: Admin, ctx: { fundId: string; userId: string }, name: string, docs: SourceDocument[],
): Promise<Outcome<LearnedTemplate>> {
  const usable = docs.filter(d => d.text.trim())
  if (!usable.length) return fail(400, 'Could not read text from any of the files.')
  if (usable.length > MAX_DOCUMENTS) return fail(400, `Upload at most ${MAX_DOCUMENTS} documents at a time.`)

  const { provider, model, providerType } = await createFundAIProvider(admin as any, ctx.fundId)
  const result = await provider.createMessage({
    model,
    maxTokens: 16_000,
    system:
      "You study a venture fund's past investor letters and describe how its partners write, precisely and with evidence. " +
      'You never copy a fact from the documents into an example.',
    content: learnVoicePrompt(usable),
  })
  await logAIUsage(admin as any, {
    fundId: ctx.fundId, userId: ctx.userId, provider: providerType, model, feature: 'lp-letter-voice-learning', usage: result.usage,
  })

  let learned
  try {
    learned = parseLearnedVoice(result.text)
  } catch (e) {
    return fail(502, (e as Error).message)
  }

  const formats = new Set(usable.map(d => (/\.docx$/i.test(d.filename) ? 'docx' : /\.pdf$/i.test(d.filename) ? 'pdf' : null)))
  const { data, error } = await (admin as any)
    .from('lp_letter_templates')
    .insert({
      fund_id: ctx.fundId,
      name: name.trim().slice(0, LIMITS.name) || 'Learned voice',
      structure: learned.structure,
      style_guide: learned.voice,
      examples: learned.examples,
      source_type: 'upload',
      source_format: formats.size === 1 ? [...formats][0] : null,
      source_filename: usable.length === 1 ? usable[0].filename : `${usable.length} documents`,
      source_files: usable.map(d => ({ filename: d.filename, chars: d.text.trim().length })),
      is_default: false,
    })
    .select()
    .single()
  if (error) return dbFail(error, 'lp-letter-templates-learn')
  return done({ template: data, reused: reusedFromSources(learned.examples, usable) })
}

/** Make a template the fund's voice: the one letters are written in unless another is picked. */
export async function makeFundVoice(admin: Admin, fundId: string, id: string): Promise<Outcome<any>> {
  const { data: row } = await (admin as any).from('lp_letter_templates').select('id').eq('id', id).eq('fund_id', fundId).maybeSingle()
  if (!row) return fail(404, 'Not found')
  const cleared = await (admin as any).from('lp_letter_templates').update({ is_default: false }).eq('fund_id', fundId).neq('id', id)
  if (cleared.error) return dbFail(cleared.error, 'lp-letter-templates-default')
  const { data, error } = await (admin as any)
    .from('lp_letter_templates')
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('fund_id', fundId)
    .select()
    .single()
  if (error) return dbFail(error, 'lp-letter-templates-default')
  return done(data)
}
