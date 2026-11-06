import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { answerDealQuestion } from '@/lib/diligence/qa-answer'
import { dbError } from '@/lib/api-error'

// The POST handler makes a synchronous, user-facing LLM call plus several DB
// round-trips. Netlify functions default to a 10s timeout, which the model
// call alone can exceed — the function is then killed before returning a
// Response and the browser surfaces a bare "Failed to fetch". Extend it to
// match the other LLM-bound routes in this repo (companies/documents = 60).
export const maxDuration = 60

interface ChatRow {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: Array<{ document_id: string; summary: string }>
  author_id: string | null
  model: string | null
  created_at: string
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const { data, error } = await (admin as any)
    .from('diligence_qa_chats')
    .select('id, role, content, citations, author_id, model, created_at')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('created_at', { ascending: true })

  if (error) return dbError(error, 'diligence-qa-chat-list')
  return NextResponse.json({ messages: (data ?? []) as ChatRow[] })
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId, userId } = guard

  const body = await req.json().catch(() => ({}))
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) return NextResponse.json({ error: 'question is required' }, { status: 400 })

  const { data: deal } = await (admin as any)
    .from('diligence_deals')
    .select('id, name, affinity_organization_id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Persist user message first so the UI sees consistent state even if the
  // assistant call later fails.
  const { data: userMsg, error: userErr } = await (admin as any)
    .from('diligence_qa_chats')
    .insert({
      fund_id: fundId,
      deal_id: params.id,
      role: 'user',
      content: question,
      author_id: userId,
    })
    .select('id, role, content, citations, author_id, model, created_at')
    .single()
  if (userErr) return dbError(userErr, 'diligence-qa-chat-user-insert')

  // Load conversation history (excluding the just-inserted user message —
  // we'll add it as the final turn explicitly below).
  const { data: history } = await (admin as any)
    .from('diligence_qa_chats')
    .select('role, content, created_at')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('created_at', { ascending: true })
    .limit(40)
  const prior = ((history ?? []) as Array<{ role: 'user' | 'assistant'; content: string; created_at: string }>)
    .filter(m => m.content !== question || m.role !== 'user')
    .slice(-12)  // keep prompt size in check, last ~6 user/assistant pairs

  // The answer itself — prompt, provider, Affinity tool loop and citation validation all
  // live in lib/diligence/qa-answer.ts, so the agent/MCP `diligence_ask` tool gives the
  // same answer to the same question. What stays HERE is everything that writes: the
  // conversation rows and the evidence-base promotion below. An agent must not do either.
  let answerText: string
  let citations: Array<{ document_id: string; summary: string }>
  let affinityLookups: string[]
  let specterLookups: string[]
  let model: string
  try {
    const result = await answerDealQuestion({
      admin,
      fundId,
      dealId: params.id,
      question,
      history: prior,
      userId,
      feature: 'diligence_qa_chat',
    })
    answerText = result.answer
    citations = result.citations
    affinityLookups = result.affinityLookups
    specterLookups = result.specterLookups
    model = result.model
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({
      error: `Chat call failed: ${msg}`,
      user_message: userMsg,
    }, { status: 500 })
  }


  const { data: assistantMsg, error: assistantErr } = await (admin as any)
    .from('diligence_qa_chats')
    .insert({
      fund_id: fundId,
      deal_id: params.id,
      role: 'assistant',
      content: answerText,
      citations,
      model,
    })
    .select('id, role, content, citations, author_id, model, created_at')
    .single()
  if (assistantErr) return dbError(assistantErr, 'diligence-qa-chat-assistant-insert')

  // Auto-promote the exchange into the deal's evidence base. The memo draft,
  // checklist assessment, and future Q&A chat all read qa_answers on the
  // latest draft — so writing here makes the conversation visible to every
  // downstream agent stage without partner action.
  //
  // Best-effort: if there's no in-flight draft yet, skip (chat still works,
  // the exchange just doesn't enrich evidence until ingest has run). Errors
  // are swallowed so a write hiccup doesn't fail the chat response.
  try {
    const { data: draft } = await (admin as any)
      .from('diligence_memo_drafts')
      .select('id, qa_answers')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId)
      .eq('is_draft', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (draft) {
      const existing = Array.isArray((draft as any).qa_answers) ? (draft as any).qa_answers as any[] : []
      // Stable id linked to the assistant chat message so the same exchange
      // doesn't duplicate if this code path runs twice.
      const linkedId = `chat_${(assistantMsg as any).id.slice(0, 12)}`
      if (!existing.some(e => e && e.question_id === linkedId)) {
        existing.push({
          question_id: linkedId,
          question_text: question,
          answer_text: answerText,
          partner_id: userId,
          answered_at: (assistantMsg as any).created_at,
          feeds_dimensions: [],
          category: 'chat_qa',
          citations,
        })
        await (admin as any)
          .from('diligence_memo_drafts')
          .update({ qa_answers: existing })
          .eq('id', (draft as any).id)
      }
    }
  } catch {
    // ignore — evidence-base feed is best-effort
  }

  return NextResponse.json({
    user_message: userMsg,
    assistant_message: assistantMsg,
    // e.g. ['affinity_get_notes'] — lets the UI show "checked Affinity".
    affinity_lookups: affinityLookups,
    specter_lookups: specterLookups,
  })
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  // Bulk delete — partner-initiated "clear conversation".
  const { error } = await (admin as any)
    .from('diligence_qa_chats')
    .delete()
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
  if (error) return dbError(error, 'diligence-qa-chat-clear')
  return NextResponse.json({ ok: true })
}

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, fundId: (membership as any).fund_id as string, userId: user.id }
}
