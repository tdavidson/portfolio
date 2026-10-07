/**
 * The Analyst's window onto Company Updates: one composable `get_updates` retrieval and the
 * token-budgeted recent-history block that goes straight into a company-scoped system prompt.
 *
 * Understanding happens at request time against evidence. Every result carries the update id,
 * artifact ids, source email id and structural locators so the answer can be inspected; every
 * text field says whether it is complete or excerpted; extraction warnings ride along so the
 * model can say "the system could not read that part" instead of "the update did not mention it".
 */
import {
  SearchParamsError,
  encodeCursor,
  getCompanyUpdate,
  getCompanyUpdateArtifact,
  parseSearchParams,
  searchCompanyUpdates,
  type SearchExcerpt,
  type SearchResponse,
  type TimelineArtifact,
} from './search'

type Admin = { from: (table: any) => any; rpc: (...args: any[]) => any }

/** Total characters of update text a single tool result may carry. */
export const DEFAULT_TOOL_CHARS = 12_000
export const MAX_TOOL_CHARS = 60_000
/** Characters of recent history placed directly into a company-scoped prompt. */
export const DEFAULT_CONTEXT_CHARS = 14_000
const RECENT_HISTORY_UPDATES = 6
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface GetUpdatesInput {
  company?: string
  query?: string
  since?: string
  until?: string
  mode?: 'list' | 'search' | 'latest_per_company'
  order?: 'relevance' | 'newest'
  match?: 'auto' | 'lexical' | 'exact'
  limit?: number
  cursor?: string
  /** Full retrieval of specific updates (body + artifact text) under the budget. */
  ids?: string[]
  /** Full retrieval of one artifact's text, windowed by `offset` for very long documents. */
  artifact?: { id: string; offset?: number }
  max_chars?: number
}

export interface TextWindow {
  text: string
  complete: boolean
  total_chars: number
  /** Characters not returned; fetch the update or artifact by id to read them. */
  omitted_chars: number
  /** For artifact windows: where the next window starts. */
  next_offset?: number
}

export interface UpdateEvidence {
  update_id: string
  company_id: string
  company_name?: string | null
  source_email_id: string
  received_at: string
  period_label: string | null
  period_source: string | null
  subject: string | null
  sender: string | null
  forwarded_sender: string | null
  extraction_status: 'complete' | 'partial' | 'failed'
  warnings: string[]
  artifacts: Array<{
    id: string
    ordinal: number
    filename: string
    extraction_status: string
    ocr_status: string
    warnings?: string[]
    has_text?: boolean
  }>
  /** Search/list mode: matched passages with locators. */
  excerpts?: Array<{ artifact_id: string | null; filename: string | null; kind: SearchExcerpt['chunk_kind']; locator: Record<string, unknown>; text: string }>
  /** Full-retrieval mode. */
  body?: TextWindow
  artifact_text?: Array<{ artifact_id: string; filename: string; window: TextWindow }>
}

export interface GetUpdatesResult {
  mode: 'list' | 'search' | 'latest_per_company' | 'by_id' | 'artifact'
  match_mode?: SearchResponse['match_mode']
  fallback?: 'exact'
  order?: SearchResponse['order']
  /** Exact number of matching updates in the corpus, not the number returned. */
  exact_total?: number
  returned: number
  has_more: boolean
  next_cursor: string | null
  /** True when the character budget shortened or dropped material; the affected items are marked. */
  budget_truncated: boolean
  notes: string[]
  results: UpdateEvidence[]
  artifact?: { id: string; update_id: string; filename: string; extraction_status: string; warnings: string[]; window: TextWindow; chunks: Array<{ ordinal: number; locator: Record<string, unknown>; chars: number }> }
}

export interface GetUpdatesDeps {
  admin: Admin
  fundId: string
  /** Resolve a company id or name to an id (throws a helpful error); the portfolio handler's resolver. */
  resolveCompanyId?: (ref: string) => Promise<string>
  /**
   * The companies the caller may see (null = every company). Required: browsing and searching cover
   * only these, and an update or attachment by id on any other company is "not found".
   */
  visibleCompanyIds: string[] | null
}

const visible = (deps: GetUpdatesDeps, companyId: string | null | undefined) =>
  deps.visibleCompanyIds === null || (!!companyId && deps.visibleCompanyIds.includes(companyId))

const NOTE_PARTIAL = 'Some source material could not be fully read (see extraction_status/warnings). Absence in returned text is not evidence of absence in the update.'

/** The composable retrieval behind the Analyst tool and MCP surface. */
export async function getUpdates(deps: GetUpdatesDeps, input: GetUpdatesInput): Promise<GetUpdatesResult> {
  const budget = clampBudget(input.max_chars)

  if (input.artifact?.id) return getArtifactWindow(deps, input.artifact.id, input.artifact.offset ?? 0, budget)
  if (input.ids?.length) return getByIds(deps, input.ids, budget)

  const mode = input.mode ?? (input.query ? 'search' : 'list')
  let companyIds: string[] | null = null
  if (input.company) {
    const id = UUID.test(input.company) && !deps.resolveCompanyId ? input.company : await (deps.resolveCompanyId ?? passthrough)(input.company)
    companyIds = [id]
  } else if (deps.visibleCompanyIds !== null) {
    // No company named: only the caller's. None at all: nothing to search.
    if (deps.visibleCompanyIds.length === 0) {
      return { mode, exact_total: 0, returned: 0, has_more: false, next_cursor: null, budget_truncated: false, notes: [], results: [] }
    }
    companyIds = deps.visibleCompanyIds
  }
  const params = parseSearchParams(deps.fundId, {
    query: mode === 'list' ? null : input.query ?? null,
    company_ids: companyIds,
    since: input.since,
    until: input.until,
    latest_per_company: mode === 'latest_per_company',
    order: input.order ?? null,
    match: input.match ?? 'auto',
    limit: input.limit ?? (mode === 'latest_per_company' ? 50 : 10),
    cursor: input.cursor ?? null,
    excerpts: mode === 'list' ? 1 : 3,
  })
  if (mode === 'search' && !params.query) throw new SearchParamsError('search mode needs a query; use mode: "list" to browse without one')

  const response = await searchCompanyUpdates(deps.admin, params)
  const notes: string[] = []
  let remaining = budget
  let truncated = false
  const results: UpdateEvidence[] = response.results.map(result => {
    const excerpts = result.excerpts.map(excerpt => {
      let text = excerpt.text
      if (text.length > remaining) {
        truncated = true
        text = remaining > 80 ? `${text.slice(0, remaining - 1)}…` : ''
      }
      remaining -= text.length
      return { artifact_id: excerpt.artifact_id, filename: excerpt.filename, kind: excerpt.chunk_kind, locator: excerpt.locator, text }
    }).filter(excerpt => excerpt.text)
    return {
      update_id: result.update_id,
      company_id: result.company_id,
      company_name: result.company_name,
      source_email_id: result.source_email_id,
      received_at: result.received_at,
      period_label: result.period_label,
      period_source: result.period_source,
      subject: result.subject,
      sender: attribution(result.sender_name, result.sender_email),
      forwarded_sender: attribution(result.forwarded_sender_name, result.forwarded_sender_email),
      extraction_status: result.extraction_status,
      warnings: result.warnings,
      artifacts: result.artifacts,
      excerpts,
    }
  })
  if (truncated) notes.push(`Excerpts were shortened to fit ${budget} characters; fetch full updates with ids: [...] to read more.`)
  if (results.some(r => r.extraction_status !== 'complete')) notes.push(NOTE_PARTIAL)
  if (response.fallback) notes.push('No lexical matches; results come from an exact substring match instead.')
  if (mode === 'latest_per_company') notes.push('Each company contributes only its most recent update; older matches are deliberately excluded.')
  notes.push('Excerpts are matched passages, not complete text. Use ids: [update_id] for the full body and attachment text.')

  return {
    mode,
    match_mode: response.match_mode,
    ...(response.fallback ? { fallback: response.fallback } : {}),
    order: response.order,
    exact_total: response.total,
    returned: results.length,
    has_more: response.next_cursor !== null,
    next_cursor: response.next_cursor,
    budget_truncated: truncated,
    notes,
    results,
  }
}

async function getByIds(deps: GetUpdatesDeps, ids: string[], budget: number): Promise<GetUpdatesResult> {
  if (ids.length > 10) throw new SearchParamsError('at most 10 ids per call')
  if (!ids.every(id => UUID.test(id))) throw new SearchParamsError('ids must be update UUIDs')
  let remaining = budget
  let truncated = false
  const results: UpdateEvidence[] = []
  const notes: string[] = []
  for (const id of ids) {
    const found = await getCompanyUpdate(deps.admin, { fundId: deps.fundId, updateId: id })
    const update = found && visible(deps, found.company_id) ? found : null
    if (!update) {
      notes.push(`Update ${id} was not found in this fund.`)
      continue
    }
    const body = window(update.body_current ?? update.body_original ?? '', 0, remaining)
    remaining -= body.text.length
    if (!body.complete) truncated = true

    const artifactText: UpdateEvidence['artifact_text'] = []
    for (const artifact of update.artifacts) {
      if (!artifact.has_text) continue
      if (remaining <= 200) {
        truncated = true
        artifactText.push({ artifact_id: artifact.id, filename: artifact.filename, window: { text: '', complete: false, total_chars: -1, omitted_chars: -1 } })
        continue
      }
      const full = await getCompanyUpdateArtifact(deps.admin, { fundId: deps.fundId, artifactId: artifact.id })
      if (!full) continue
      const w = window(full.extracted_text, 0, remaining)
      remaining -= w.text.length
      if (!w.complete) truncated = true
      artifactText.push({ artifact_id: artifact.id, filename: artifact.filename, window: w })
    }
    results.push({
      update_id: update.id,
      company_id: update.company_id,
      company_name: update.company_name,
      source_email_id: update.source_email_id,
      received_at: update.received_at,
      period_label: update.period_label,
      period_source: update.period_source,
      subject: update.subject,
      sender: attribution(update.sender_name, update.sender_email),
      forwarded_sender: attribution(update.forwarded_sender_name, update.forwarded_sender_email),
      extraction_status: update.extraction_status,
      warnings: update.warnings,
      artifacts: update.artifacts.map(artifactSummary),
      body,
      artifact_text: artifactText,
    })
  }
  if (truncated) notes.push(`Text was cut to fit ${budget} characters. Read a long attachment with artifact: { id, offset } to page through it; total_chars -1 means it was not fetched at all.`)
  if (results.some(r => r.extraction_status !== 'complete')) notes.push(NOTE_PARTIAL)
  return { mode: 'by_id', returned: results.length, has_more: false, next_cursor: null, budget_truncated: truncated, notes, results }
}

async function getArtifactWindow(deps: GetUpdatesDeps, artifactId: string, offset: number, budget: number): Promise<GetUpdatesResult> {
  if (!UUID.test(artifactId)) throw new SearchParamsError('artifact.id must be a UUID')
  if (!Number.isInteger(offset) || offset < 0) throw new SearchParamsError('artifact.offset must be a non-negative integer')
  const found = await getCompanyUpdateArtifact(deps.admin, { fundId: deps.fundId, artifactId })
  // An attachment is its update's: visible only when the update's company is.
  const parent = found && deps.visibleCompanyIds !== null
    ? await getCompanyUpdate(deps.admin, { fundId: deps.fundId, updateId: found.update_id })
    : null
  const artifact = found && (deps.visibleCompanyIds === null || visible(deps, parent?.company_id)) ? found : null
  if (!artifact) throw new SearchParamsError(`Artifact ${artifactId} was not found in this fund.`)
  const w = window(artifact.extracted_text, offset, budget)
  const more = w.next_offset !== undefined
  const notes: string[] = []
  if (artifact.extraction_status !== 'complete') notes.push(NOTE_PARTIAL)
  if (more) notes.push(`Continue with artifact: { id: "${artifactId}", offset: ${w.next_offset} }.`)
  return {
    mode: 'artifact',
    returned: 1,
    has_more: more,
    next_cursor: more ? encodeCursor({ artifact_id: artifactId, offset: w.next_offset }) : null,
    budget_truncated: more,
    notes,
    results: [],
    artifact: {
      id: artifact.id,
      update_id: artifact.update_id,
      filename: artifact.filename,
      extraction_status: artifact.extraction_status,
      warnings: artifact.warnings,
      window: w,
      chunks: artifact.chunks,
    },
  }
}

// ─── Recent history for the company-scoped system prompt ─────────────────────────────────────

/**
 * A bounded, explicitly-marked slice of a company's recent updates for direct inclusion in the
 * prompt. Returns '' when the company has no captured updates so the caller can fall back to the
 * legacy path during rollout. Nothing here is summarised: it is the source text, cut with markers.
 */
export async function buildRecentUpdatesBlock(
  admin: Admin,
  params: { fundId: string; companyId: string; maxChars?: number; updates?: number },
): Promise<string> {
  const budget = Math.min(Math.max(params.maxChars ?? DEFAULT_CONTEXT_CHARS, 1_000), MAX_TOOL_CHARS)
  const response = await searchCompanyUpdates(admin, {
    fundId: params.fundId,
    companyIds: [params.companyId],
    limit: params.updates ?? RECENT_HISTORY_UPDATES,
    excerpts: 0,
    order: 'newest',
  })
  if (response.results.length === 0) return ''

  const lines: string[] = [
    `Most recent ${response.results.length} of ${response.total} captured update(s), newest first. Text is the current message ` +
      'and extracted attachment text; anything cut is marked and can be fetched with get_updates ids: [update_id].',
  ]
  let remaining = budget
  for (const result of response.results) {
    const header =
      `--- UPDATE ${result.update_id} | ${result.received_at.slice(0, 10)}` +
      `${result.period_label ? ` | period ${result.period_label}` : ''}` +
      `${result.subject ? ` | "${result.subject}"` : ''} | extraction ${result.extraction_status} ---`
    if (remaining < header.length + 200) {
      lines.push(`[… ${response.results.length - lines.length + 1} older update(s) omitted for budget; ids available via get_updates mode: "list" …]`)
      break
    }
    lines.push(header)
    remaining -= header.length
    if (result.warnings.length) {
      const warn = `Warnings: ${result.warnings.join(' | ')}`.slice(0, 600)
      lines.push(warn)
      remaining -= warn.length
    }
    const update = await getCompanyUpdate(admin, { fundId: params.fundId, updateId: result.update_id })
    if (!update) continue
    const body = window(update.body_current ?? update.body_original ?? '', 0, Math.max(Math.floor(remaining * 0.5), 400))
    lines.push(body.text || '(no body text)')
    if (!body.complete) lines.push(`[… ${body.omitted_chars} more characters of the message omitted …]`)
    remaining -= body.text.length
    for (const artifact of update.artifacts) {
      const label = `[Attachment ${artifact.ordinal}: ${artifact.filename} | ${artifact.extraction_status}${artifact.ocr_status !== 'not_needed' ? ` | OCR ${artifact.ocr_status}` : ''} | artifact_id ${artifact.id}]`
      lines.push(label)
      remaining -= label.length
      if (!artifact.has_text) {
        if (artifact.warnings.length) lines.push(`  ${artifact.warnings[0]}`)
        continue
      }
      if (remaining < 300) {
        lines.push('  [… attachment text omitted for budget; fetch with get_updates artifact: { id } …]')
        continue
      }
      const full = await getCompanyUpdateArtifact(admin, { fundId: params.fundId, artifactId: artifact.id })
      if (!full) continue
      const w = window(full.extracted_text, 0, Math.min(remaining, Math.max(Math.floor(budget / 4), 1_000)))
      lines.push(w.text)
      if (!w.complete) lines.push(`  [… ${w.omitted_chars} more characters omitted; fetch with get_updates artifact: { id: "${artifact.id}", offset: ${w.next_offset} } …]`)
      remaining -= w.text.length
    }
  }
  return lines.join('\n')
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function clampBudget(value: number | undefined): number {
  if (value === undefined || value === null) return DEFAULT_TOOL_CHARS
  if (!Number.isFinite(value)) throw new SearchParamsError('max_chars must be a number')
  return Math.min(Math.max(Math.floor(value), 500), MAX_TOOL_CHARS)
}

export function window(text: string, offset: number, maxChars: number): TextWindow {
  const total = text.length
  const start = Math.min(Math.max(offset, 0), total)
  let end = Math.min(total, start + Math.max(maxChars, 0))
  if (end < total) {
    // Cut on a line or sentence boundary when one is near, so the last visible thought is whole.
    const newline = text.lastIndexOf('\n', end)
    const sentence = text.lastIndexOf('. ', end)
    const boundary = Math.max(newline >= 0 ? newline + 1 : -1, sentence >= 0 ? sentence + 2 : -1)
    if (boundary > start + Math.floor((end - start) * 0.7)) end = boundary
  }
  const slice = text.slice(start, end)
  const complete = start === 0 && end >= total
  return {
    text: slice,
    complete,
    total_chars: total,
    omitted_chars: total - slice.length,
    ...(end < total ? { next_offset: end } : {}),
  }
}

function attribution(name: string | null, email: string | null): string | null {
  if (!name && !email) return null
  if (name && email) return `${name} <${email}>`
  return name ?? email
}

function artifactSummary(artifact: TimelineArtifact) {
  return {
    id: artifact.id,
    ordinal: artifact.ordinal,
    filename: artifact.filename,
    extraction_status: artifact.extraction_status,
    ocr_status: artifact.ocr_status,
    warnings: artifact.warnings,
    has_text: artifact.has_text,
  }
}

async function passthrough(ref: string): Promise<string> {
  if (!UUID.test(ref)) throw new SearchParamsError('company must be an id when no resolver is configured')
  return ref
}
