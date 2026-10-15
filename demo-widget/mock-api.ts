import type { AppFetch } from '@/components/app-runtime'
import type { DemoAnswer, DemoAnswers, DemoApi, DemoScope, DemoSnapshot } from './types'

/**
 * The app's API, answered without a server.
 *
 * Three layers, in order:
 *   1. Recorded responses (data/api.json): what the real API returned to the demo fund's viewer
 *      for exactly this request, keyed by method, path and query. Exact match first, then the
 *      same path with any query.
 *   2. The structured snapshot (data/snapshot.json): the routes the command palette and the
 *      Analyst call, answered from the fund's records, plus the Analyst's stored replies.
 *   3. 404, reported through `onMiss` so scripts/demo-check.mjs can list what the recorder has
 *      not covered. Every caller already treats 404 as "empty".
 *
 * Writes are refused with READ_ONLY and reported through `onWrite`, except the Analyst POST.
 */
export interface DemoFetchOptions {
  snapshot: DemoSnapshot
  answers: DemoAnswers
  api?: DemoApi
  onMiss?: (key: string) => void
  /** A change was attempted and refused: the widget tells the visitor so. */
  onWrite?: (method: string, path: string) => void
}

export function createDemoFetch({ snapshot, answers, api, onMiss, onWrite }: DemoFetchOptions): AppFetch {
  const index = buildAnswerIndex(answers)
  const recorded = api?.responses ?? {}
  // The same path with a different query: the recorder walked the pages with their default
  // filters, and a visitor changing one still deserves rows rather than a blank table. The
  // recording that shares the most query parameters with the request stands in — so a period
  // change keeps the same LP's statement or the same account's register — then the plainest
  // (the page's default), so a bare period change on the ledger does not open some account.
  const byPath = new Map<string, string[]>()
  for (const key of Object.keys(recorded)) {
    const bare = key.split('?')[0]
    byPath.set(bare, [...(byPath.get(bare) ?? []), key])
  }
  const params = (key: string) => [...new URLSearchParams(key.split('?')[1] ?? '').entries()]
  const closest = (bare: string, wanted: string): string | undefined => {
    const want = new Set(params(wanted).map(([k, v]) => `${k}=${v}`))
    let best: string | undefined, bestShared = -1, bestCount = Infinity
    for (const key of byPath.get(bare) ?? []) {
      const own = params(key)
      const shared = own.filter(([k, v]) => want.has(`${k}=${v}`)).length
      // A recording that pins something the request does not ask for (another LP, another
      // account) is a worse stand-in than one that leaves it out.
      const extra = own.filter(([k]) => !params(wanted).some(([w]) => w === k)).length
      const score = shared - extra
      if (score > bestShared || (score === bestShared && own.length < bestCount)) { best = key; bestShared = score; bestCount = own.length }
    }
    return best
  }

  return async (input, init) => {
    const url = new URL(input, 'https://demo.invalid')
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname

    if (method === 'POST' && path === '/api/analyst') return analyst(await readBody(init), init?.signal, index, answers)
    if (method !== 'GET') {
      onWrite?.(method, path)
      return json({ error: READ_ONLY }, 403)
    }

    const key = requestKey(method, url)
    const hit = recorded[key] ?? recorded[closest(`${method} ${path}`, key) ?? '']
    if (hit) return json(expand(hit.body, recorded), hit.status)

    // Older recordings store one chart response per metric. Assemble the new batch endpoint from
    // those exact responses so a widget upgrade does not require re-recording synthetic data.
    const chartMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/metrics\/values$/)
    if (method === 'GET' && chartMatch) {
      const company = snapshot.companies.find(c => c.id === chartMatch[1])
      if (!company) return json({ error: 'Not found' }, 404)
      return json(Object.fromEntries(company.metrics.map(m => {
        const prior = recorded[`GET /api/companies/${company.id}/metrics/${m.id}/values`]
        return [m.id, prior ? expand(prior.body, recorded) : m.values.map((v, i) => ({
          id: `${m.id}-${i}`, metric_id: m.id, period_label: v.period_label,
          period_year: v.year, period_quarter: v.quarter, period_month: v.month,
          value_number: v.number, value_text: null, confidence: 'high', source_email_id: null,
          notes: null, is_manually_entered: false, created_at: snapshot.generatedAt,
          inbound_emails: null,
        }))]
      })))
    }

    const generic = fromSnapshot(path, snapshot)
    if (generic) return generic

    onMiss?.(key)
    return json({ error: 'Not found' }, 404)
  }
}

/**
 * The recorder stores a large top-level field once and points later copies at it —
 * `{ "$same": "<request key>#<field>" }` — because the ledger's per-account registers each
 * repeat the whole chart of accounts. Put the field back before the page sees it.
 */
export function expand(body: unknown, recorded: Record<string, { body: unknown }>): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  let out: Record<string, unknown> | null = null
  for (const [field, value] of Object.entries(body as Record<string, unknown>)) {
    const ref = value && typeof value === 'object' && !Array.isArray(value) ? (value as { $same?: unknown }).$same : undefined
    if (typeof ref !== 'string') continue
    const at = ref.lastIndexOf('#')
    const source = recorded[ref.slice(0, at)]?.body as Record<string, unknown> | undefined
    out ??= { ...(body as Record<string, unknown>) }
    out[field] = source?.[ref.slice(at + 1)]
  }
  return out ?? body
}

/** `GET /api/companies?limit=5&sort=name`: method, path, and the query with its keys sorted. */
export function requestKey(method: string, url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : ''
  return `${method.toUpperCase()} ${url.pathname}${query}`
}

/**
 * Route every `/api/*` request the page makes through `demoFetch`, whoever makes it. The seam
 * in components/app-runtime.tsx covers the components that take `fetch` from context; the rest
 * of the app calls the global, and on the marketing site nothing else asks for `/api/`, so the
 * prefix is the whole test. Returns the function that puts the original back.
 */
export function interceptApiFetch(demoFetch: AppFetch): () => void {
  const original = window.fetch
  window.fetch = function demoAwareFetch(input: RequestInfo | URL, init?: RequestInit) {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (/^(\/api\/|https?:\/\/[^/]+\/api\/)/.test(href)) {
      const merged: RequestInit = input instanceof Request && !init
        ? { method: input.method, headers: input.headers, signal: input.signal }
        : (init ?? {})
      return demoFetch(href, merged)
    }
    return original.call(window, input, init)
  } as typeof window.fetch
  return () => { window.fetch = original }
}

/** What every refused change says, inline wherever a component shows the error. */
export const READ_ONLY = 'This is a read-only demo, so changes are not saved.'

export const DEMO_MODEL = { id: 'demo-stored-replies', name: 'Stored replies (demo)', provider: 'anthropic' }

// ---------------------------------------------------------------------------
// Layer 2: the structured snapshot
// ---------------------------------------------------------------------------

function fromSnapshot(path: string, snapshot: DemoSnapshot): Response | null {
  switch (path) {
    case '/api/companies':
      return json(snapshot.companies.map(c => ({ id: c.id, name: c.name, aliases: c.aliases, stage: c.stage, status: c.status, industry: c.industry, portfolio_group: c.portfolio_group })))
    case '/api/lps/investors':
      return json(snapshot.lps.map(lp => ({ id: lp.id, name: lp.name, lp_entities: [] })))
    case '/api/deals': {
      // The list the deals page refetches on mount: every field the snapshot has, dated at the
      // snapshot so the table has a date to show, and the columns the snapshot lacks left empty.
      const created_at = new Date(Number.isNaN(Date.parse(snapshot.generatedAt)) ? Date.now() : Date.parse(snapshot.generatedAt)).toISOString()
      return json(snapshot.deals.map(d => ({
        ...d, email_id: null, company_url: null, company_domain: null, founder_email: null, referrer_name: null, prior_deal_id: null, created_at,
      })))
    }
    case '/api/accounting/vehicle-index':
      return json(snapshot.vehicles.map(v => ({ name: v.name, id: v.id, kind: v.kind })))
    case '/api/claude-models':
      // One entry so the picker has something to show; the "model" is the stored reply set.
      return json({ models: [{ id: DEMO_MODEL.id, name: DEMO_MODEL.name }] })
    case '/api/openai-models':
      return json({ models: [] })
    case '/api/analyst/conversations':
      return json({ conversations: [] })
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The Analyst
// ---------------------------------------------------------------------------

interface AnalystBody {
  messages?: { role: string; content: string }[]
  companyId?: string
  conversationId?: string
}

async function analyst(
  body: AnalystBody,
  signal: AbortSignal | null | undefined,
  index: IndexedAnswer[],
  answers: DemoAnswers,
): Promise<Response> {
  const last = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')
  if (!last) return json({ error: 'messages array is required' }, 400)

  const scope: DemoScope = body.companyId ? `company:${body.companyId}` : 'portfolio'
  const hit = matchAnswer(last.content, scope, index)
  const reply = hit?.answer.reply ?? answers.fallback

  // A real answer takes a moment; an instant one reads as canned even when it is right.
  await wait(Math.min(1800, 500 + reply.length * 2), signal)

  return json({
    reply,
    model: hit?.answer.model ?? { id: DEMO_MODEL.id, provider: DEMO_MODEL.provider },
    conversationId: body.conversationId ?? `demo-${Date.now().toString(36)}`,
    proposals: [],
    vehicle: null,
    scope: body.companyId ? { companyId: body.companyId } : { portfolio: true },
    toolCalls: [],
    stagedActions: [],
    blocks: [],
  })
}

interface IndexedAnswer { answer: DemoAnswer; phrasings: Set<string>[] }

function buildAnswerIndex(answers: DemoAnswers): IndexedAnswer[] {
  return answers.answers.map(answer => ({
    answer,
    phrasings: [answer.question, ...(answer.aliases ?? [])].map(tokens),
  }))
}

/**
 * The closest stored question to what was typed: token overlap (Jaccard) over the question and
 * its aliases, in the current scope first and the portfolio as a fallback from a company. Below
 * the threshold the caller gets the fallback text, which says what the product would do.
 */
export function matchAnswer(question: string, scope: DemoScope, index: IndexedAnswer[]): { answer: DemoAnswer; score: number } | null {
  const q = tokens(question)
  if (q.size === 0) return null
  let best: { answer: DemoAnswer; score: number } | null = null
  for (const entry of index) {
    const inScope = entry.answer.scope === scope
    const fallbackScope = scope !== 'portfolio' && entry.answer.scope === 'portfolio'
    if (!inScope && !fallbackScope) continue
    for (const p of entry.phrasings) {
      let score = jaccard(q, p)
      if (!inScope) score *= 0.85
      if (!best || score > best.score) best = { answer: entry.answer, score }
    }
  }
  return best && best.score >= 0.2 ? best : null
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'our', 'we', 'i', 'my', 'me', 'do', 'does', 'did', 'what', 'whats', 'which', 'who', 'how', 'this', 'that', 'it', 'its', 'be', 'at', 'as', 'by', 'from', 'have', 'has', 'should', 'can', 'could', 'would', 'please', 'tell', 'about', 'give', 'show', 'any', 'across', 'last', 'year', 'company', 'companies'])

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue
    // Light stemming: plural and past-tense endings, so "grew" ≠ "grow" is left alone but
    // "gains"/"gain" and "runways"/"runway" meet.
    out.add(raw.replace(/(ies)$/, 'y').replace(/(s|ed|ing)$/, ''))
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function readBody(init?: RequestInit): Promise<AnalystBody> {
  if (!init?.body || typeof init.body !== 'string') return {}
  try {
    return JSON.parse(init.body) as AnalystBody
  } catch {
    return {}
  }
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
}
