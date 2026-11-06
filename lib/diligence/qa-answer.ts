// Answering a partner question about a deal, from the deal's own evidence.
//
// This was inline in app/api/diligence/[id]/qa-chat/route.ts. It moved here so the
// agent/MCP tool can ask the same question and get the SAME answer — same prompt, same
// citation validation, same provider and cost accounting. A second copy of this prompt
// would drift from the first within a release, and the two surfaces would start
// disagreeing about the same data room.
//
// What this does NOT do is persist anything. The chat route owns the conversation
// (`diligence_qa_chats`) and the evidence-base promotion into the draft's `qa_answers`;
// an agent asking a read-only question must not write to either, or every tool call
// would silently graffiti the partner's chat history and the memo's evidence base.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAIUsage } from '@/lib/ai/usage'
import { withTopicalGuardrail } from '@/lib/ai/topical-guard'
import { getStageProvider } from '@/lib/memo-agent/stage-provider'
import { extractJsonObject } from '@/lib/memo-agent/parse-ai-json'
import { buildQAChatContext } from '@/lib/diligence/qa-chat-context'
import { getAffinityKey } from '@/lib/affinity/credentials'
import { AFFINITY_TOOLS, makeAffinityExecutor, affinityMcpServer } from '@/lib/affinity/tools'
import { getMcpServerForUser } from '@/lib/mcp-client/connections'
import type { AIResult, McpServerConfig } from '@/lib/ai/types'

export interface QACitation {
  document_id: string
  summary: string
}

export interface DealAnswer {
  answer: string
  /** Only ever document ids that actually appear in the evidence — validated, not trusted. */
  citations: QACitation[]
  /** e.g. ['affinity_get_notes'] — which CRM lookups the model actually made. */
  affinityLookups: string[]
  /** e.g. ['find_company'] — which Specter tools the model actually called. */
  specterLookups: string[]
  model: string
  /** The documents the model was allowed to cite, so a caller can name them. */
  citableDocs: Array<{ id: string; file_name: string }>
}

export interface AnswerDealQuestionParams {
  admin: SupabaseClient
  fundId: string
  dealId: string
  question: string
  /** Prior turns, oldest first. Omit for a one-shot question. */
  history?: Array<{ role: string; content: string }>
  /**
   * Whose Affinity key to use. Affinity is only ever reached with the ASKING user's own
   * key, so the assistant can never surface CRM records that user couldn't open
   * themselves. Pass null to answer from the data room alone.
   */
  userId?: string | null
  /** What to bill the call to. */
  feature: string
}

/**
 * Answer a question about a deal from its ingested evidence.
 *
 * Retrieval is NOT search — there is no RAG, no embeddings, no full-text index. The
 * evidence is the claims the ingest stage already extracted from each document
 * (`buildQAChatContext`), stuffed into the prompt. The practical consequence, worth
 * surfacing to any caller: **if ingest has not run on this deal, there is no evidence at
 * all** and the honest answer is "the data room hasn't been analyzed yet", not a guess.
 */
export async function answerDealQuestion(params: AnswerDealQuestionParams): Promise<DealAnswer> {
  const { admin, fundId, dealId, question, history = [], userId = null, feature } = params

  const { data: deal } = await (admin as any)
    .from('diligence_deals')
    .select('affinity_organization_id')
    .eq('id', dealId)
    .eq('fund_id', fundId)
    .maybeSingle()

  const ctx = await buildQAChatContext({ admin, fundId, dealId })
  const { provider, model, providerType } = await getStageProvider(admin, fundId, 'qa')

  // Affinity rides on the asking user's own key — it carries their permissions. No user,
  // no CRM: an agent key with no human behind it answers from the data room alone.
  const affinityKey = userId ? await getAffinityKey(admin, userId) : null
  const { data: fundSettings } = await (admin as any)
    .from('fund_settings')
    .select('affinity_mcp_enabled')
    .eq('fund_id', fundId)
    .maybeSingle()
  const useMcp = !!(fundSettings as any)?.affinity_mcp_enabled

  const linkedOrgId = (deal as any)?.affinity_organization_id as number | null
  // Tool use is Anthropic-only here. On any other provider fall back to the plain
  // evidence-only answer rather than pretending the assistant has CRM access it doesn't.
  const affinityAvailable = !!affinityKey && provider.supportsToolLoop === true

  // Specter, like Affinity, rides on the asking user's own sign-in, and only its read-only
  // tools are turned on (lib/mcp-client/connections.ts). Not connected, or a provider without
  // tool use, means no Specter.
  const specterServer: McpServerConfig | null = userId && provider.supportsToolLoop === true
    ? await getMcpServerForUser(admin, userId, 'specter').catch(() => null)
    : null
  const specterAvailable = !!specterServer

  const affinityBlock = affinityAvailable
    ? `

AFFINITY CRM ACCESS
You can query the fund's Affinity CRM with the affinity_* tools to answer questions about the
RELATIONSHIP history — past meetings, call notes, who introduced us, what was discussed and when.
${linkedOrgId
    ? `This deal is already linked to Affinity organization_id ${linkedOrgId}. Use that id directly; you do not need to search for it.`
    : `This deal is not linked to an Affinity company yet, so use affinity_search_companies first to find it by name.`}

When to reach for Affinity:
- The question is about history, relationships, or what was said in a meeting — the data room holds
  documents, but the CRM holds the conversation record.
- The data-room evidence below does not answer the question and the CRM plausibly might.

Do NOT use Affinity for questions the data room already answers — it costs a round-trip and the
documents are the primary evidence. Content you take from Affinity should be attributed in your
answer as coming from an Affinity note (with its date), not cited as a data-room document.`
    : ''

  const specterBlock = specterAvailable
    ? `

SPECTER ACCESS
You can look up outside company, people and investor data in Specter with its tools: funding
rounds, investors, competitors, revenue and headcount signals, founders' career histories.

When to reach for Specter:
- The question is about the market or the outside view of the company: competitors, who has
  invested, how the team or headcount has changed, what the founders did before.
- You need to check a claim in the data room against an outside source.

Do NOT use Specter for questions the data room already answers. Resolve the company once (by its
website domain if you know it) and reuse the result. Attribute anything you take from Specter as
coming from Specter, never cite it as a data-room document, and say when Specter and the data room
disagree.`
    : ''

  const extraSources = [
    affinityAvailable ? 'the fund\'s Affinity CRM when the question is about relationship history' : null,
    specterAvailable ? 'Specter for outside company, people and investor data' : null,
  ].filter(Boolean).join(', and ')
  const systemPrompt = `You answer partner questions about an active diligence deal using the evidence below${extraSources ? `, plus ${extraSources}` : ''}. If the evidence does not contain the answer, say so plainly and suggest where the partner could look (a missing document, a research gap, a question to ask the founders).

Rules:
- Be concise and direct. No throat-clearing.
- Never fabricate numbers, names, or sources.
- When you cite a document, reference it by its file name as listed in DATA-ROOM EVIDENCE.
- If multiple sources agree, say so. If they contradict, surface the contradiction.
- Stage-aware: ${ctx.stage ? `this is a ${ctx.stage} company, calibrate expectations accordingly` : 'no stage on record, ask the partner if it matters'}.${affinityBlock}${specterBlock}

Output format: return JSON ONLY of the form:
{
  "answer": "<your answer in plain text, 1–5 short paragraphs>",
  "citations": [{ "document_id": "<doc_id from the evidence>", "summary": "<one-line note about what you took from this doc>" }]
}

Cite up to 5 documents. Only cite document_ids that actually appear in DATA-ROOM EVIDENCE.

=== EVIDENCE ===
${ctx.text}`

  const priorTurns = history.slice(-12)  // keep prompt size in check
  const userTurn = priorTurns.length > 0
    ? priorTurns.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') + `\n\nUSER: ${question}`
    : question

  let result: AIResult
  let affinityLookups: string[] = []
  let specterLookups: string[] = []

  if ((affinityAvailable || specterAvailable) && provider.createToolLoop) {
    // Affinity is either our read-only tools, or its hosted MCP server if the fund opted into
    // it (which also grants the model write access — see lib/affinity/tools.ts).
    const affinityViaMcp = affinityAvailable && useMcp
    const mcpServers: McpServerConfig[] = [
      ...(affinityViaMcp ? [affinityMcpServer(affinityKey!)] : []),
      ...(specterServer ? [specterServer] : []),
    ]
    const loop = await provider.createToolLoop({
      model,
      maxTokens: 1500,
      system: withTopicalGuardrail(systemPrompt),
      content: userTurn,
      ...(affinityAvailable && !affinityViaMcp
        ? { tools: AFFINITY_TOOLS, executeTool: makeAffinityExecutor(affinityKey!) }
        : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      maxIterations: specterAvailable ? 8 : 5,
    })
    result = loop
    const ok = loop.toolCalls.filter(c => !c.isError)
    affinityLookups = ok.filter(c => c.server !== 'specter').map(c => c.name)
    specterLookups = ok.filter(c => c.server === 'specter').map(c => c.name)
  } else {
    result = await provider.createMessage({
      model,
      maxTokens: 1500,
      system: withTopicalGuardrail(systemPrompt),
      content: userTurn,
    })
  }

  const { text, usage } = result
  logAIUsage(admin, { fundId, provider: providerType, model, feature, usage })

  let answer = text
  let citations: QACitation[] = []
  const parsed = extractJsonObject(text)
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { answer?: unknown; citations?: unknown }
    answer = typeof obj.answer === 'string' ? obj.answer : text
    if (Array.isArray(obj.citations)) {
      // Validated against the evidence, never trusted: a model that invents a document
      // id would otherwise produce a citation that looks checkable and isn't.
      const validIds = new Set(ctx.citableDocs.map(d => d.id))
      citations = (obj.citations as any[])
        .filter(c => c && typeof c === 'object' && typeof c.document_id === 'string' && validIds.has(c.document_id))
        .slice(0, 5)
        .map(c => ({ document_id: c.document_id, summary: typeof c.summary === 'string' ? c.summary : '' }))
    }
  }
  // Non-JSON reply falls through with `answer = text` — degrade, don't fail the turn.

  return { answer, citations, affinityLookups, specterLookups, model, citableDocs: ctx.citableDocs }
}
