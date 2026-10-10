import { createFundAIProviderWithOverride } from '@/lib/ai'
import { withTopicalGuardrail } from '@/lib/ai/topical-guard'
import type { AIProvider, ChatMessage } from '@/lib/ai/types'
import { logAIUsage } from '@/lib/ai/usage'
import { buildCompanyContext, buildPortfolioContext, buildDealContext } from '@/lib/ai/context-builder'
import {
  buildAccountingContext,
  accountingAnalystGuide,
  ACCOUNTING_DOCUMENT_GUIDE,
  ACCOUNTING_DRAFTING_PROTOCOL,
  type AssistantProposal,
} from '@/lib/accounting/assistant'
import { resolveVehicle } from '@/lib/accounting/agent-tools'
import {
  buildAnalystTools,
  type CompletedAnalystTool,
  type StagedActionRecord,
} from '@/lib/ai/analyst-tools'
import { buildLpContext, LP_ANALYST_GUIDE } from '@/lib/ai/lp-fund-context'
import { buildDiligenceContext, DILIGENCE_ANALYST_GUIDE } from '@/lib/diligence/analyst-context'
import { extractText } from '@/lib/memo-agent/extract-text'
import { hasAccess } from '@/lib/access/effective'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { canSeeVehicle, filterByCompany } from '@/lib/access/scope'
import type { ToolExecutor } from '@/lib/ai/types'
import type { AnalystProgressEvent } from './types'
import {
  conversationBelongsToPrincipal,
  loadConversationMemory,
  persistConversation,
  type ConversationCoordinates,
} from './conversation-store'
import { buildPresentationBlocks } from './response'
import {
  AnalystRequestError,
  type AnalystDependencies,
  type AnalystPrincipal,
  type AnalystRequest,
  type AnalystResult,
  type AnalystRateLimitSpec,
} from './types'
import { listDocuments, KIND_LABELS } from '@/lib/entity-documents'
import { GOVERNING_DOCUMENTS_GUIDE, resolveDocumentEntity } from '@/lib/entity-documents/analyst'

async function enforceRateLimit(deps: AnalystDependencies, spec: AnalystRateLimitSpec): Promise<void> {
  if (await deps.isRateLimited(spec)) {
    throw new AnalystRequestError(
      'Too many requests. Please try again later.',
      429,
      'RATE_LIMITED',
      spec.windowSeconds,
    )
  }
}

const DOMAIN_SCOPED_SYSTEM_PROMPT = `You are a senior venture-capital analyst. Answer only from the
authorized context and tools supplied for this request. If the requested information is not present,
say that it is unavailable rather than inferring or requesting data from another domain. Keep
responses concise and analytical. Use plain text (no markdown formatting).`

/**
 * Shared Analyst orchestration. The caller supplies an already-authenticated, live principal;
 * request fields can narrow scope but can never provide or widen identity, fund, role, or access.
 */
/**
 * Wrap a tool executor so each call is announced before and after it runs.
 *
 * Nothing about the call's arguments or its result crosses this boundary — only the tool's name and
 * a humanized label. `isError` is reported because "that lookup failed" is useful to a person
 * waiting, and it says nothing about what was looked up.
 *
 * The callback is best-effort: a transport whose client has already disconnected should not turn
 * into a failed Analyst run, so anything it throws is swallowed.
 */
function withProgress(
  execute: ToolExecutor,
  onProgress?: (event: AnalystProgressEvent) => void,
): ToolExecutor {
  if (!onProgress) return execute
  const emit = (event: AnalystProgressEvent) => {
    try {
      onProgress(event)
    } catch {
      /* a broken transport must not fail the run */
    }
  }
  return async call => {
    const label = toolLabel(call.name)
    emit({ kind: 'tool.started', tool: call.name, label })
    try {
      const result = await execute(call)
      emit({ kind: 'tool.completed', tool: call.name, label, isError: false })
      return result
    } catch (error) {
      emit({ kind: 'tool.completed', tool: call.name, label, isError: true })
      throw error
    }
  }
}

/** `list_capital_calls` -> `List capital calls`. A name, not a database detail. */
/**
 * What a step is DOING, in words, for the ones a person waits on longest. Shown live while the
 * Analyst works ("Reading account history…"), so a long run reads as progress, not a hang. Any tool
 * not named here falls back to its name made readable.
 */
const TOOL_LABELS: Record<string, string> = {
  forecast_suggest_rules: 'Reading account history to suggest forecast rules',
  forecast_list_plans: 'Looking up budgets and forecasts',
  forecast_series: 'Loading actuals and the forecast',
  forecast_explain: 'Reading the plan’s rules and sources',
  forecast_variance: 'Comparing against the plan',
  forecast_fee_links: 'Looking up fee links',
  create_forecast_plan: 'Drafting the forecast for your approval',
  update_forecast_plan: 'Drafting changes to the forecast for your approval',
  publish_forecast_plan: 'Preparing the plan to publish',
  portfolio_construction: 'Loading portfolio construction',
  update_portfolio_construction: 'Drafting construction changes for your approval',
}

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Working'
}

export async function runAnalyst(
  principal: AnalystPrincipal,
  request: AnalystRequest,
  deps: AnalystDependencies,
): Promise<AnalystResult> {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AnalystRequestError('messages array is required', 400, 'INVALID_REQUEST')
  }
  request.signal?.throwIfAborted()
  if (request.conversationId && !(await conversationBelongsToPrincipal(
    deps.admin,
    principal,
    request.conversationId,
  ))) {
    throw new AnalystRequestError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND')
  }

  const scopeInput = request.scope ?? {}
  const canReadPortfolio = hasAccess(principal.access, 'portfolio', 'read')
  // The caller's entities: every context below reads only their companies and positions, and a
  // company or deal outside them is "not found" — the model is never handed it.
  const entityScope = await entityScopeFor(deps.admin as any, principal.access)
  const { data: allFundCompanies } = canReadPortfolio
    ? await filterByCompany(deps.admin
        .from('companies')
        .select('id, name, aliases')
        .eq('fund_id', principal.fundId)
        .eq('holding_type', 'company'), entityScope.companyIds, { column: 'id' })
    : { data: null }

  const companyNameLookup = new Map<string, string>()
  if (allFundCompanies) {
    for (const company of allFundCompanies) {
      if (company.name && company.name.length > 2) {
        companyNameLookup.set(company.name.toLowerCase(), company.id)
      }
      if (company.aliases) {
        for (const alias of company.aliases) {
          if (alias && alias.length > 2) companyNameLookup.set(alias.toLowerCase(), company.id)
        }
      }
    }
  }

  const contextOptions = {
    includeTeamNotes: hasAccess(principal.access, 'relationships', 'read', 'notes'),
    scope: entityScope,
  }
  let systemPrompt: string

  if (scopeInput.dealId) {
    if (!hasAccess(principal.access, 'dealflow', 'read')) {
      throw new AnalystRequestError('Forbidden', 403, 'FORBIDDEN')
    }
    // '*': vehicle_id exists only once the entity migration has run.
    const { data: dealCheck } = await deps.admin
      .from('inbound_deals')
      .select('*')
      .eq('id', scopeInput.dealId)
      .maybeSingle()
    if (!dealCheck || !canSeeVehicle(principal.access, (dealCheck as any).vehicle_id ?? null)) {
      throw new AnalystRequestError('Not found', 404, 'NOT_FOUND')
    }
    if ((dealCheck as { fund_id: string }).fund_id !== principal.fundId) {
      throw new AnalystRequestError('Forbidden', 403, 'FORBIDDEN')
    }

    const context = await buildDealContext(deps.admin, scopeInput.dealId, principal.access)
    if (!context) throw new AnalystRequestError('Not found', 404, 'NOT_FOUND')
    systemPrompt = context.systemPrompt
    systemPrompt += `\n\n=== FUND THESIS ===\n${context.thesisBlock}`
    systemPrompt += `\n\n=== DEAL ===\n${context.dealBlock}`
    if (context.emailBlock) systemPrompt += `\n\n=== ORIGINATING EMAIL ===\n${context.emailBlock}`
  } else if (scopeInput.companyId) {
    if (!canReadPortfolio) {
      throw new AnalystRequestError('Forbidden', 403, 'FORBIDDEN')
    }
    const { data: companyCheck } = await deps.admin
      .from('companies')
      .select('fund_id')
      .eq('id', scopeInput.companyId)
      .maybeSingle()
    if (!companyCheck || (entityScope.companyIds !== null && !entityScope.companyIds.includes(scopeInput.companyId))) {
      throw new AnalystRequestError('Not found', 404, 'NOT_FOUND')
    }
    if (companyCheck.fund_id !== principal.fundId) {
      throw new AnalystRequestError('Forbidden', 403, 'FORBIDDEN')
    }

    const context = await buildCompanyContext(deps.admin, scopeInput.companyId, contextOptions)
    if (!context) throw new AnalystRequestError('Not found', 404, 'NOT_FOUND')
    systemPrompt = context.systemPrompt
    systemPrompt += '\n\nYou are the Analyst for this portfolio company. Answer questions using the data provided below. Reference specific numbers and dates. Do not perform new calculations, only reference pre-computed data. You can also draft or refine company summaries when asked.\n\nKeep responses concise and analytical. Use plain text (no markdown formatting).'
    if (context.metricsBlock) systemPrompt += `\n\n=== QUANTITATIVE DATA ===\n${context.metricsBlock}`
    if (context.recentUpdatesBlock) {
      systemPrompt += `\n\n=== RECENT COMPANY UPDATES (source text) ===\n${context.recentUpdatesBlock}`
      systemPrompt += '\n\nUse get_updates to search older history, read full updates by id, or page through a long attachment. Cite update ids and attachment locators for anything you state from an update, and say so when extraction of the relevant source was partial or failed.'
    } else if (context.reportContentBlock) {
      systemPrompt += `\n\n=== LATEST REPORT CONTENT ===\n${context.reportContentBlock}`
    }
    if (context.previousSummariesBlock) systemPrompt += `\n\n=== PREVIOUS SUMMARIES ===\n${context.previousSummariesBlock}`
    if (context.documentsBlock) systemPrompt += `\n\n=== DOCUMENTS ===\n${context.documentsBlock}`
    if (context.investmentBlock) systemPrompt += `\n\n=== INVESTMENT DATA ===\n${context.investmentBlock}`
    if (context.portfolioBlock) systemPrompt += `\n\n=== PORTFOLIO PEERS (for comparison) ===\n${context.portfolioBlock}`
    if (context.teamNotesBlock) {
      systemPrompt += `\n\n=== TEAM DISCUSSION NOTES ===\nRecent internal team notes and discussions about this company:\n${context.teamNotesBlock}`
    }
  } else {
    if (canReadPortfolio) {
      const context = await buildPortfolioContext(deps.admin, principal.fundId, contextOptions)
      systemPrompt = context.systemPrompt
      if (context.portfolioBlock) systemPrompt += `\n\n=== PORTFOLIO DATA ===\n${context.portfolioBlock}`
      if (context.teamNotesBlock) {
        systemPrompt += `\n\n=== TEAM DISCUSSION NOTES ===\nRecent internal team notes and discussions across the portfolio:\n${context.teamNotesBlock}`
      }
      systemPrompt += '\n\nIf detailed data about a specific company is included below in a "REFERENCED COMPANY" section, use that data to answer questions about that company.'
    } else {
      systemPrompt = DOMAIN_SCOPED_SYSTEM_PROMPT
    }
  }

  // An attached document is read once, before any scope decides what to do with it. Accounting
  // scope pairs it with the entry-drafting guide; every other scope gets it as plain source
  // material. Either way a document the server can't read is an error the user sees, never a
  // silent drop — a file the Analyst ignored while appearing to have received it is worse than
  // no attachment at all.
  let documentBlock = ''
  const documentName = request.document?.name ?? 'attachment'
  if (request.document?.base64) {
    const document = await extractAttachment(request.document)
    if ('error' in document) {
      throw new AnalystRequestError(document.error, 400, 'INVALID_DOCUMENT')
    }
    documentBlock = document.text
  }

  let accountingGroup: string | null = null
  if (scopeInput.vehicle && hasAccess(principal.access, 'accounting', 'read')) {
    await enforceRateLimit(deps, {
      key: `ai-analyst-acct:${principal.userId}`,
      limit: 10,
      windowSeconds: 300,
    })

    const options = {
      includeRelatedEntities: hasAccess(principal.access, 'gp_economics', 'read'),
      access: principal.access,
    }
    try {
      const group = await resolveVehicle(deps.admin, principal.fundId, scopeInput.vehicle, { access: principal.access })
      const books = await buildAccountingContext(deps.admin, principal.fundId, group, options)
      systemPrompt += `\n\n=== ACCOUNTING: ${group} ===\n${accountingAnalystGuide(options)}\n\n${books}`
      if (documentBlock) {
        systemPrompt += `\n\n=== SOURCE DOCUMENT: ${documentName} ===\n${documentBlock}\n\n${ACCOUNTING_DOCUMENT_GUIDE}`
        documentBlock = ''
      }
      if (hasAccess(principal.access, 'accounting', 'write')) {
        systemPrompt += `\n\n${ACCOUNTING_DRAFTING_PROTOCOL}`
      }
      accountingGroup = group
    } catch (error) {
      console.error('[analyst] accounting context skipped:', error)
    }
  }

  // Governing documents: for anyone who can see the entity in view, with or without the books.
  let documentsEntity: string | null = null
  if (scopeInput.vehicle) {
    try {
      const { id: vehicleId, name } = await resolveDocumentEntity(deps.admin, principal.fundId, principal.access, scopeInput.vehicle)
      const docs = await listDocuments(deps.admin, principal.fundId, [vehicleId])
      documentsEntity = name
      if (docs.length > 0) {
        const lines = docs.map(d => `  - ${d.title} (${KIND_LABELS[d.kind] ?? d.kind}${d.effective_date ? `, effective ${d.effective_date}` : ''}${d.page_count ? `, ${d.page_count} pages` : ''}${d.ocr_status === 'pending' ? ', scan still being read' : ''}) [id ${d.id}]`)
        systemPrompt += `\n\n=== GOVERNING DOCUMENTS: ${name} ===\n${lines.join('\n')}\n\n${GOVERNING_DOCUMENTS_GUIDE}`
        if (!accountingGroup) {
          systemPrompt += `\n\nThis conversation does not include ${name}'s books, so a compliance review can state the terms but not test the figures against them.`
        }
      }
    } catch (error) {
      console.error('[analyst] governing documents skipped:', error)
    }
  }

  let lpScoped = false
  if (scopeInput.domain === 'lps' && hasAccess(principal.access, 'lp_capital', 'read')) {
    await enforceRateLimit(deps, {
      key: `ai-analyst-lps:${principal.userId}`,
      limit: 10,
      windowSeconds: 300,
    })
    lpScoped = true
    try {
      const block = await buildLpContext(deps.admin, principal.fundId, entityScope.vehicleNames)
      if (block) systemPrompt += `\n\n=== LP CAPITAL ===\n${LP_ANALYST_GUIDE}\n\n${block}`
    } catch (error) {
      console.error('[analyst] LP context skipped:', error)
    }
  }

  let diligenceScoped = false
  if (scopeInput.domain === 'diligence' && hasAccess(principal.access, 'diligence', 'read')) {
    diligenceScoped = true
    try {
      const block = await buildDiligenceContext(deps.admin, principal.fundId, principal.access)
      if (block) systemPrompt += `\n\n=== DILIGENCE PIPELINE ===\n${DILIGENCE_ANALYST_GUIDE}\n\n${block}`
    } catch (error) {
      console.error('[analyst] diligence context skipped:', error)
    }
  }

  if (documentBlock) {
    await enforceRateLimit(deps, {
      key: `ai-analyst-doc:${principal.userId}`,
      limit: 10,
      windowSeconds: 300,
    })
    systemPrompt += `\n\n=== SOURCE DOCUMENT: ${documentName} ===\n${documentBlock}\n\n${SOURCE_DOCUMENT_GUIDE}`
  }

  const conversationScope: string | null = accountingGroup
    ? `accounting:${accountingGroup}`
    : lpScoped
      ? 'lps'
      : diligenceScoped
        ? 'diligence'
        : null

  const referencedCompanyIds = canReadPortfolio
    ? detectReferencedCompanies(request.messages, companyNameLookup, scopeInput.companyId ?? null)
    : []
  if (referencedCompanyIds.length > 0) {
    await enforceRateLimit(deps, {
      key: `ai-analyst-xref:${principal.userId}`,
      limit: 10,
      windowSeconds: 300,
    })
    const contexts = await Promise.all(
      referencedCompanyIds.map(id => buildCompanyContext(deps.admin, id, contextOptions)),
    )
    for (const context of contexts) {
      if (!context) continue
      let block = `\n\n=== REFERENCED COMPANY: ${context.company.name} ===\n(This data was loaded because the user mentioned this company. Use it to answer their question.)`
      if (context.metricsBlock) block += `\n\nMetrics:\n${context.metricsBlock}`
      if (context.investmentBlock) block += `\n\nInvestment data:\n${context.investmentBlock}`
      if (context.reportContentBlock) block += `\n\nLatest report:\n${context.reportContentBlock}`
      if (context.documentsBlock) block += `\n\nDocuments:\n${context.documentsBlock}`
      systemPrompt += block
    }
  }

  const coordinates: ConversationCoordinates = {
    companyId: scopeInput.companyId ?? null,
    dealId: scopeInput.dealId ?? null,
    scope: conversationScope,
  }
  const memory = deps.ephemeral ? '' : await loadConversationMemory(
    deps.admin,
    principal,
    coordinates,
    request.conversationId,
  )
  if (memory) {
    systemPrompt += `\n\n=== PREVIOUS CONVERSATION MEMORY ===\nRecent discussions with this user (for context continuity):\n${memory}`
  }

  let providerResult: { provider: AIProvider; model: string; providerType: string }
  try {
    providerResult = deps.provider ?? await createFundAIProviderWithOverride(
      deps.admin,
      principal.fundId,
      request.model?.provider,
    )
  } catch {
    throw new AnalystRequestError(
      'AI API key not configured. Add one in Settings.',
      400,
      'AI_NOT_CONFIGURED',
    )
  }
  const { provider, providerType } = providerResult
  const model = request.model?.id ?? providerResult.model
  const messages: ChatMessage[] = request.messages.map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content).slice(0, 10_000),
  }))

  try {
    let text: string
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }
    let toolCalls: Array<{ name: string }> = []
    const stagedActions: StagedActionRecord[] = []
    const completedTools: CompletedAnalystTool[] = []

    if (provider.supportsToolLoop && provider.createToolLoop) {
      const analystTools = buildAnalystTools({
        admin: deps.admin,
        fundId: principal.fundId,
        userId: principal.userId,
        access: principal.access,
        vehicle: accountingGroup ?? undefined,
        entity: documentsEntity,
        enableDrafts: request.allowDrafts !== false,
        createdVia: 'analyst',
        stagedActions,
        completedTools,
      })
      const result = await provider.createToolLoop({
        model,
        maxTokens: 2000,
        effort: request.effort,
        signal: request.signal,
        system: withTopicalGuardrail(systemPrompt),
        messages,
        tools: analystTools.tools,
        // The streaming seam. The orchestrator owns the executor, so announcing a tool call needs
        // no change to the provider layer — which is why coarse progress is cheap and token-level
        // progress is not.
        executeTool: withProgress(analystTools.executeTool, request.onProgress),
        maxIterations: 6,
      })
      text = result.text
      usage = result.usage
      toolCalls = result.toolCalls.map(call => ({ name: call.name }))
    } else {
      const result = await provider.createChat({
        model,
        maxTokens: 2000,
        effort: request.effort,
        signal: request.signal,
        system: withTopicalGuardrail(systemPrompt),
        messages,
      })
      text = result.text
      usage = result.usage
    }

    request.signal?.throwIfAborted()

    if (!deps.ephemeral) await logAIUsage(deps.admin, {
      fundId: principal.fundId,
      userId: principal.userId,
      provider: providerType,
      model,
      feature: 'analyst',
      usage,
    })

    const { reply, proposals } = accountingGroup && hasAccess(principal.access, 'accounting', 'write')
      ? extractProposals(text)
      : { reply: text, proposals: [] as AssistantProposal[] }
    request.signal?.throwIfAborted()
    const conversationId = deps.ephemeral ? null : await persistConversation({
      admin: deps.admin,
      principal,
      coordinates,
      conversationId: request.conversationId,
      messages,
      reply,
      provider,
      model,
    })
    const blocks = buildPresentationBlocks(completedTools, stagedActions)

    return {
      reply,
      conversationId,
      proposals,
      vehicle: accountingGroup,
      scope: conversationScope,
      toolCalls,
      stagedActions,
      blocks,
      usage: { ...usage, provider: providerType, model },
    }
  } catch (error) {
    if (request.signal?.aborted) throw error
    if (error instanceof AnalystRequestError) throw error
    console.error('[analyst] AI error:', error instanceof Error ? error.message : String(error), error)
    throw new AnalystRequestError(
      'Analyst request failed. Check your API key in Settings.',
      500,
      'ANALYST_FAILED',
    )
  }
}

/** The general-scope counterpart of ACCOUNTING_DOCUMENT_GUIDE: read the file, don't draft from it. */
const SOURCE_DOCUMENT_GUIDE = `The SOURCE DOCUMENT above was attached by the user with their question. Treat it as source material: answer from it, quote or cite it where that helps, and relate it to the fund data you have when the user asks. If the document does not contain what the user is asking about, say so plainly rather than guessing.`

const DOCUMENT_FORMATS = ['pdf', 'docx', 'xlsx', 'xls', 'md', 'markdown', 'txt', 'csv']
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const MAX_DOCUMENT_CHARS = 20_000

async function extractAttachment(
  document: { name?: string; format?: string; base64?: string },
): Promise<{ text: string } | { error: string }> {
  const format = String(document.format ?? '').toLowerCase().replace(/^\./, '')
  if (!DOCUMENT_FORMATS.includes(format)) {
    return { error: `Can't read a .${format || '?'} file — attach a PDF, Word doc, Excel file, or text file.` }
  }
  let buffer: Buffer
  try {
    buffer = Buffer.from(String(document.base64), 'base64')
  } catch {
    return { error: 'That attachment could not be decoded.' }
  }
  if (buffer.length === 0) return { error: 'That attachment is empty.' }
  if (buffer.length > MAX_DOCUMENT_BYTES) return { error: 'That attachment is too large (max 10MB).' }
  const text = await extractText(buffer, format)
  if (!text || !text.trim()) {
    return { error: `No text could be read from ${document.name ?? 'that file'} — a scanned image PDF won't work.` }
  }
  return { text: text.slice(0, MAX_DOCUMENT_CHARS) }
}

function extractProposals(text: string): { reply: string; proposals: AssistantProposal[] } {
  const proposals: AssistantProposal[] = []
  const reply = text.replace(/```proposal\s*([\s\S]*?)```/g, (whole, json: string) => {
    try {
      const object = JSON.parse(json.trim())
      if (!object || !Array.isArray(object.postings) || object.postings.length === 0) return whole
      proposals.push({
        type: object.type === 'edit' ? 'edit' : 'create',
        entryId: object.entryId ?? null,
        entryDate: String(object.entryDate ?? ''),
        memo: String(object.memo ?? ''),
        sourceType: object.sourceType ?? 'manual',
        postings: object.postings.map((posting: any) => ({
          accountCode: String(posting.accountCode),
          amount: Number(posting.amount),
          lpEntity: posting.lpEntity ?? null,
        })),
        rationale: String(object.rationale ?? ''),
      })
      return ''
    } catch {
      return whole
    }
  })
  return { reply: reply.trim(), proposals }
}

function detectReferencedCompanies(
  messages: ChatMessage[],
  lookup: Map<string, string>,
  currentCompanyId: string | null,
): string[] {
  const userTexts: string[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') userTexts.push(String(messages[index].content))
  }
  const combined = userTexts.join(' ').toLowerCase()
  const matched = new Map<string, number>()
  lookup.forEach((companyId, name) => {
    if ((currentCompanyId && companyId === currentCompanyId) || matched.has(companyId)) return
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(combined)
    if (match) matched.set(companyId, match.index)
  })
  return Array.from(matched.entries())
    .sort((left, right) => left[1] - right[1])
    .slice(0, 2)
    .map(([id]) => id)
}
