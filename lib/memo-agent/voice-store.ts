// A fund's memo voice (diligence_memo_voice): read, saved and learned. Shared by the Settings page's
// routes and the MCP tools, so the app and a connected assistant change the same row the same way.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createFundAIProvider } from '@/lib/ai'
import { logAIUsage } from '@/lib/ai/usage'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { learnMemoVoicePrompt, parseLearnedMemoVoice, type LearnedMemoVoice, type SourceDocument } from './learn-voice'
import { memoVoice, type MemoVoice, type MemoVoiceRow } from './skill'
import { getActiveAnchors } from './style-anchors'

type Admin = SupabaseClient

export interface MemoVoiceEdit {
  voice?: string | null
  house_rules?: string | null
  examples?: string | null
  learned_from?: string[]
}

const LIMITS = { voice: 100_000, house_rules: 20_000, examples: 100_000 } as const
const MAX_MEMOS = 12

/** A voice edit from a request or tool input: only the known fields, as text, within their limits. */
export function memoVoiceEdit(body: any): Outcome<MemoVoiceEdit> {
  const out: MemoVoiceEdit = {}
  for (const key of ['voice', 'house_rules', 'examples'] as const) {
    if (body?.[key] === undefined) continue
    const v = body[key]
    if (v !== null && typeof v !== 'string') return fail(400, `${key} must be text`)
    if (typeof v === 'string' && v.length > LIMITS[key]) return fail(400, `${key} is too long (at most ${LIMITS[key].toLocaleString()} characters)`)
    out[key] = typeof v === 'string' && v.trim() ? v : null
  }
  if (Array.isArray(body?.learned_from)) out.learned_from = body.learned_from.filter((x: unknown) => typeof x === 'string').slice(0, MAX_MEMOS)
  if (Object.keys(out).length === 0) return fail(400, 'Nothing to save: pass voice, house_rules or examples.')
  return done(out)
}

export async function getMemoVoiceRow(admin: Admin, fundId: string): Promise<MemoVoiceRow | null> {
  const { data } = await (admin as any)
    .from('diligence_memo_voice')
    .select('voice, house_rules, examples, learned_from, learned_at, updated_at')
    .eq('fund_id', fundId)
    .maybeSingle()
  return (data as MemoVoiceRow | null) ?? null
}

export async function getMemoVoice(admin: Admin, fundId: string): Promise<MemoVoice> {
  return memoVoice(await getMemoVoiceRow(admin, fundId))
}

/** Save the fields given (others are kept). Saving makes it the voice every memo is written in. */
export async function saveMemoVoice(admin: Admin, ctx: { fundId: string; userId: string | null }, edit: MemoVoiceEdit): Promise<Outcome<MemoVoiceRow>> {
  const row: Record<string, unknown> = { fund_id: ctx.fundId, updated_by: ctx.userId, updated_at: new Date().toISOString() }
  for (const k of ['voice', 'house_rules', 'examples'] as const) if (edit[k] !== undefined) row[k] = edit[k]
  if (edit.learned_from) { row.learned_from = edit.learned_from; row.learned_at = new Date().toISOString() }
  const { data, error } = await (admin as any)
    .from('diligence_memo_voice')
    .upsert(row, { onConflict: 'fund_id' })
    .select('voice, house_rules, examples, learned_from, learned_at, updated_at')
    .single()
  if (error) return dbFail(error, 'memo-voice-save')
  return done(data as MemoVoiceRow)
}

/** The fund's sample memos, as text, for learning a voice (by the app's AI or by a connected assistant). */
export async function sampleMemoTexts(admin: Admin, fundId: string, anchorIds?: string[]): Promise<Array<SourceDocument & { id: string }>> {
  const anchors = await getActiveAnchors(fundId, admin as any)
  return anchors
    .filter(a => !anchorIds?.length || anchorIds.includes(a.id))
    .filter(a => (a.voice_representativeness ?? 'representative') !== 'do_not_match_voice')
    .map(a => ({ id: a.id, filename: a.file_name ?? a.title ?? a.id, text: a.extracted_text ?? '' }))
    .filter(d => d.text.trim())
    .slice(0, MAX_MEMOS)
}

/**
 * Learn a memo voice from the fund's sample memos with the fund's own AI. Saves nothing: the result
 * is a draft for a person to read, edit and save.
 */
export async function learnMemoVoice(
  admin: Admin, ctx: { fundId: string; userId: string | null }, anchorIds?: string[],
): Promise<Outcome<LearnedMemoVoice & { learned_from: string[] }>> {
  const docs = await sampleMemoTexts(admin, ctx.fundId, anchorIds)
  if (!docs.length) return fail(400, 'No sample memos with readable text. Upload the fund\'s memos under Settings, Memo agent, Style anchors first.')
  const { provider, model, providerType } = await createFundAIProvider(admin as any, ctx.fundId)
  const result = await provider.createMessage({
    model,
    maxTokens: 16_000,
    system:
      "You study a venture fund's past investment memos and describe how its partners write, precisely and with evidence. " +
      'You never copy a fact from the memos into an example.',
    content: learnMemoVoicePrompt(docs),
  })
  await logAIUsage(admin as any, {
    fundId: ctx.fundId, userId: ctx.userId ?? undefined, provider: providerType, model, feature: 'memo-voice-learning', usage: result.usage,
  })
  try {
    return done({ ...parseLearnedMemoVoice(result.text, docs), learned_from: docs.map(d => d.id) })
  } catch (e) {
    return fail(502, (e as Error).message)
  }
}
