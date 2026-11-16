'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, FileText, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import type { SearchExcerpt, SearchResponse, SearchResult } from '@/lib/company-updates/search'

interface Props {
  companies: Array<{ id: string; name: string }>
}

/**
 * Portfolio update search. Free text or "quoted phrases", narrowed by company and an inclusive
 * date range; ordered by relevance or newest; exact counts; cursor pagination; and every result
 * says which update, artifact and location a passage came from.
 */
export function UpdatesSearch({ companies }: Props) {
  const [query, setQuery] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [order, setOrder] = useState<'relevance' | 'newest'>('relevance')
  const [latestOnly, setLatestOnly] = useState(false)
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const run = useCallback(async (cursor: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (query.trim()) params.set('q', query.trim())
      if (companyId) params.set('company_ids', companyId)
      if (since) params.set('since', since)
      if (until) params.set('until', until)
      if (query.trim()) params.set('order', order)
      if (latestOnly) params.set('latest_per_company', 'true')
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(`/api/company-updates/search?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Search failed')
      setResponse(data)
      setResults(prev => (cursor ? [...prev, ...data.results] : data.results))
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [query, companyId, since, until, order, latestOnly])

  // Initial page: the newest updates across the portfolio, so the surface is never empty.
  useEffect(() => { run(null) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-page space-y-4">
      <form
        onSubmit={event => { event.preventDefault(); run(null) }}
        className="rounded-card border bg-card shadow-sm dark:shadow-none p-4 grid gap-3 md:grid-cols-[1fr_auto]"
      >
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder='Search updates — e.g. retention, "net revenue retention", runway -hiring'
            className="pl-8"
            aria-label="Search updates"
          />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}Search
        </Button>
        <div className="md:col-span-2 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Company
            <select value={companyId} onChange={event => setCompanyId(event.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
              <option value="">All companies</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            From
            <Input type="date" value={since} onChange={event => setSince(event.target.value)} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Through
            <Input type="date" value={until} onChange={event => setUntil(event.target.value)} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Order
            <select value={order} onChange={event => setOrder(event.target.value as 'relevance' | 'newest')} disabled={!query.trim()} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground disabled:opacity-50">
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
            </select>
          </label>
          <label className="flex items-center gap-2 h-9 text-sm">
            <input type="checkbox" checked={latestOnly} onChange={event => setLatestOnly(event.target.checked)} className="h-4 w-4" />
            Latest update per company only
          </label>
        </div>
      </form>

      {error && <div className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm text-destructive">{error}</div>}

      {response && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
          <span className="tabular-nums">{response.total.toLocaleString()} {response.total === 1 ? 'update' : 'updates'}</span>
          {response.match_mode === 'exact' && <Badge variant="outline">exact match</Badge>}
          {response.fallback && <span>— no word matches, showing exact substring matches</span>}
          {latestOnly && <span>— each company&apos;s latest update only</span>}
        </div>
      )}

      {submitted && results.length === 0 && !loading && !error && (
        <p className="text-sm text-muted-foreground">No updates match. Try fewer words, a quoted phrase, or a wider date range.</p>
      )}

      <div className="space-y-3">
        {results.map(result => <ResultCard key={result.update_id} result={result} />)}
      </div>

      {response?.next_cursor && (
        <Button variant="outline" size="sm" onClick={() => run(response.next_cursor)} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}Load more
        </Button>
      )}
    </div>
  )
}

function ResultCard({ result }: { result: SearchResult }) {
  return (
    <article className="rounded-card border bg-card shadow-sm dark:shadow-none p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={`/companies/${result.company_id}`} className="text-sm font-semibold text-foreground hover:underline">
          {result.company_name}
        </Link>
        <span className="text-sm text-foreground truncate">{result.subject || '(no subject)'}</span>
        {result.period_label && <Badge variant="outline">{result.period_label}</Badge>}
        {result.extraction_status !== 'complete' && (
          <Badge variant="outline" className="bg-warning-subtle text-warning border-transparent">
            <AlertTriangle className="h-3 w-3 mr-1" />extraction {result.extraction_status}
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(result.received_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">
        {result.forwarded_sender_email ? `${result.forwarded_sender_name ?? result.forwarded_sender_email} · forwarded by ` : ''}
        {result.sender_name ? `${result.sender_name} <${result.sender_email}>` : result.sender_email}
      </div>

      {result.excerpts.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {result.excerpts.map(excerpt => (
            <li key={excerpt.chunk_id} className="text-sm">
              <span className="text-xs text-muted-foreground mr-2 inline-flex items-center gap-1">
                {excerpt.artifact_id ? <FileText className="h-3 w-3" /> : null}
                {locatorLabel(excerpt)}
              </span>
              <Highlighted text={excerpt.text} />
            </li>
          ))}
        </ul>
      )}

      {result.warnings.length > 0 && (
        <p className="mt-2 text-sm text-warning">{result.warnings[0]}{result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : ''}</p>
      )}

      <div className="mt-2 flex items-center gap-3 text-xs">
        <Link href={`/companies/${result.company_id}#updates`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          Open in timeline
        </Link>
        <Link href={`/emails/${result.source_email_id}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ExternalLink className="h-3 w-3" />Source email
        </Link>
        {result.artifacts.map(artifact => (
          <a
            key={artifact.id}
            href={`/api/company-updates/${result.update_id}/artifacts/${artifact.id}?download=1`}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title={`Download ${artifact.filename} (${artifact.extraction_status}${artifact.ocr_status !== 'not_needed' ? `, OCR ${artifact.ocr_status}` : ''})`}
          >
            <FileText className="h-3 w-3" />{artifact.filename}
          </a>
        ))}
      </div>
    </article>
  )
}

/** Where a passage came from, in the reader's terms. */
export function locatorLabel(excerpt: Pick<SearchExcerpt, 'chunk_kind' | 'filename' | 'locator'>): string {
  const loc = excerpt.locator ?? {}
  if (excerpt.chunk_kind === 'subject') return 'Subject'
  if (excerpt.chunk_kind === 'body_current') return 'Message'
  if (excerpt.chunk_kind === 'body_original') return 'Message (quoted history)'
  if (excerpt.chunk_kind === 'artifact_title') return `${excerpt.filename ?? 'Attachment'} (filename)`
  const parts: string[] = [excerpt.filename ?? 'Attachment']
  if (typeof loc.page === 'number') parts.push(`page ${loc.page}${loc.ocr ? ' (OCR)' : ''}`)
  if (typeof loc.slide === 'number') parts.push(`slide ${loc.slide}${loc.section === 'notes' ? ' notes' : ''}`)
  if (typeof loc.sheet === 'string') {
    parts.push(`sheet ${loc.sheet}${typeof loc.rowStart === 'number' ? ` rows ${loc.rowStart}–${loc.rowEnd}` : ''}`)
  }
  if (typeof loc.heading === 'string' && loc.heading) parts.push(`§ ${loc.heading}`)
  if (loc.image) parts.push('image (OCR)')
  return parts.join(' · ')
}

/** ts_headline marks matches as [[term]]; render them emphasised without dangerouslySetInnerHTML. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]*\]\])/g)
  return (
    <span>
      {parts.map((part, index) =>
        part.startsWith('[[') && part.endsWith(']]')
          ? <mark key={index} className="bg-warning-subtle text-foreground rounded-sm px-0.5">{part.slice(2, -2)}</mark>
          : <span key={index}>{part}</span>,
      )}
    </span>
  )
}
