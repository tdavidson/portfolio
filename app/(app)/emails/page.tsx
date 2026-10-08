'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle, RefreshCw, ChevronLeft, ChevronRight, Loader2, Trash2, Copy, Check } from 'lucide-react'
import { FiltersSheet } from '@/components/filters-sheet'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { EmailReviewModal } from '@/components/email-review-modal'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailRow {
  id: string
  from_address: string
  subject: string | null
  received_at: string
  processing_status: string
  metrics_extracted: number
  company: { id: string; name: string } | null
  company_metrics_count: number
}

interface EmailsData {
  total: number
  page: number
  page_size: number
  items: EmailRow[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_VARIANTS: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-muted text-muted-foreground border-border' },
  processing: { label: 'Processing', className: 'bg-info-subtle text-info border-info' },
  success: { label: 'Success', className: 'bg-success-subtle text-success border-success' },
  not_processed: { label: 'Skipped', className: 'bg-muted text-muted-foreground border-border' },
  failed: { label: 'Failed', className: 'bg-destructive-subtle text-destructive border-destructive' },
  needs_review: {
    label: 'Review',
    className: 'bg-warning-subtle text-warning border-warning',
  },
}

function StatusBadge({ status }: { status: string }) {
  const v = STATUS_VARIANTS[status] ?? { label: status, className: '' }
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${v.className}`}
    >
      {v.label}
    </span>
  )
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | '...')[] = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) pages.push('...')
  for (let i = start; i <= end; i++) pages.push(i)
  if (end < total - 1) pages.push('...')
  pages.push(total)
  return pages
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EmailsPage() {
  const router = useRouter()
  const [data, setData] = useState<EmailsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Inbound address from settings
  const [inboundAddress, setInboundAddress] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(s => {
      if (s?.postmarkInboundAddress) setInboundAddress(s.postmarkInboundAddress)
    }).catch(() => {})
  }, [])

  // Companies for filter
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    fetch('/api/companies').then(r => r.ok ? r.json() : []).then(data => {
      const list = (Array.isArray(data) ? data : data?.items ?? data?.companies ?? []) as { id: string; name: string }[]
      setCompanies(list.sort((a, b) => a.name.localeCompare(b.name)))
    }).catch(() => {})
  }, [])

  // Filters
  const [status, setStatus] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [dateRange, setDateRange] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // Review modal
  const [reviewModalEmailId, setReviewModalEmailId] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState<Record<string, boolean>>({})
  const [bulkNotice, setBulkNotice] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (p = page) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setLoading(true)
      setError(null)

      const params = new URLSearchParams({ page: String(p), page_size: String(pageSize) })
      if (status) params.set('status', status)
      if (companyFilter) params.set('company_id', companyFilter)
      if (dateRange) {
        const now = new Date()
        if (dateRange === 'this_year') {
          params.set('date_from', `${now.getFullYear()}-01-01`)
        } else if (dateRange === 'last_year') {
          params.set('date_from', `${now.getFullYear() - 1}-01-01`)
          params.set('date_to', `${now.getFullYear() - 1}-12-31`)
        } else {
          const from = new Date(now)
          if (dateRange === '7d') from.setDate(now.getDate() - 7)
          else if (dateRange === '30d') from.setDate(now.getDate() - 30)
          else if (dateRange === '90d') from.setDate(now.getDate() - 90)
          else if (dateRange === '6m') from.setMonth(now.getMonth() - 6)
          else if (dateRange === '12m') from.setFullYear(now.getFullYear() - 1)
          params.set('date_from', from.toISOString().slice(0, 10))
        }
      }

      try {
        const res = await fetch(`/api/emails?${params}`, { signal: controller.signal })
        if (!res.ok) throw new Error('Failed to load emails')
        setData(await res.json())
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Error loading data')
        }
      } finally {
        setLoading(false)
      }
    },
    [status, companyFilter, dateRange, page, pageSize]
  )

  useEffect(() => {
    load(page)
  }, [load, page])

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0

  async function dismissReviews(emailId: string) {
    setDismissing(prev => ({ ...prev, [emailId]: true }))
    try {
      const res = await fetch(`/api/emails/${emailId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss_all' }),
      })
      if (res.ok) {
        // Reviews this action could not resolve (api/emails/[id]/reviews) stay open; say so.
        const json = await res.json().catch(() => ({}))
        const n = Number(json?.leftOpen ?? 0)
        setBulkNotice(n > 0 ? `${n === 1 ? 'A fund review is' : `${n} fund reviews are`} still open. Approve ${n === 1 ? 'it' : 'each'} on its own, so the NAV or notice is saved with its entity.` : null)
        load(page)
      }
    } catch {
      // ignore
    } finally {
      setDismissing(prev => ({ ...prev, [emailId]: false }))
    }
  }

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4 w-full">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Inbound</h1>
          <div className="flex items-center gap-2">
            <div className="lg:hidden">
              <FiltersSheet activeCount={[status, companyFilter, dateRange].filter(Boolean).length}>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Status</label>
                  <Select value={status || 'all'} onValueChange={v => { setStatus(v === 'all' ? '' : v); setPage(1) }}>
                    <SelectTrigger className="h-8 w-full text-sm">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="needs_review">Review</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                      <SelectItem value="processing">Processing</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="not_processed">Skipped</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Company</label>
                  <Select value={companyFilter || 'all'} onValueChange={v => { setCompanyFilter(v === 'all' ? '' : v); setPage(1) }}>
                    <SelectTrigger className="h-8 w-full text-sm">
                      <SelectValue placeholder="All companies" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All companies</SelectItem>
                      {companies.map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Date range</label>
                  <Select value={dateRange || 'all'} onValueChange={v => { setDateRange(v === 'all' ? '' : v); setPage(1) }}>
                    <SelectTrigger className="h-8 w-full text-sm">
                      <SelectValue placeholder="All time" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All time</SelectItem>
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                      <SelectItem value="90d">Last 90 days</SelectItem>
                      <SelectItem value="6m">Last 6 months</SelectItem>
                      <SelectItem value="12m">Last 12 months</SelectItem>
              <SelectItem value="this_year">This year</SelectItem>
              <SelectItem value="last_year">Last year</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(status || companyFilter || dateRange) && (
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setStatus(''); setCompanyFilter(''); setDateRange(''); setPage(1) }}>
                    Clear filters
                  </Button>
                )}
              </FiltersSheet>
            </div>
            <Button variant="outline" size="sm" onClick={() => load(page)} disabled={loading} className="text-muted-foreground">
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <AnalystToggleButton />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Emails with metrics and updates on portfolio companies</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">
      {/* Desktop inline filters + inbound address */}
      <div className="hidden lg:flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Status</label>
          <Select value={status || 'all'} onValueChange={v => { setStatus(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="h-8 w-40 text-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="needs_review">Review</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="not_processed">Skipped</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Company</label>
          <Select value={companyFilter || 'all'} onValueChange={v => { setCompanyFilter(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="h-8 w-48 text-sm">
              <SelectValue placeholder="All companies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All companies</SelectItem>
              {companies.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Date range</label>
          <Select value={dateRange || 'all'} onValueChange={v => { setDateRange(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="h-8 w-36 text-sm">
              <SelectValue placeholder="All time" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
              <SelectItem value="6m">Last 6 months</SelectItem>
              <SelectItem value="12m">Last 12 months</SelectItem>
              <SelectItem value="this_year">This year</SelectItem>
              <SelectItem value="last_year">Last year</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(status || companyFilter || dateRange) && (
          <Button size="sm" variant="ghost" className="h-8" onClick={() => { setStatus(''); setCompanyFilter(''); setDateRange(''); setPage(1) }}>
            Clear
          </Button>
        )}
        {inboundAddress && (
          <div className="ml-auto flex items-end gap-1.5">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Send emails to</label>
              <Input
                type="text"
                readOnly
                value={inboundAddress}
                className="h-8 w-64 text-sm bg-muted text-muted-foreground cursor-default"
                tabIndex={-1}
              />
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(inboundAddress)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="h-8 px-2 text-muted-foreground hover:text-foreground transition-colors"
              title="Copy to clipboard"
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>
      {/* Mobile inbound address */}
      {inboundAddress && (
        <div className="flex items-end gap-1.5 mb-5 lg:hidden">
          <Input
            type="text"
            readOnly
            value={inboundAddress}
            className="h-8 w-full text-sm bg-muted text-muted-foreground cursor-default"
            tabIndex={-1}
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(inboundAddress)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
            className="h-8 px-2 text-muted-foreground hover:text-foreground transition-colors"
            title="Copy to clipboard"
          >
            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {bulkNotice && (
        <p role="status" className="mb-4 text-sm text-warning">{bulkNotice}</p>
      )}

      {/* Table */}
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell w-40">
                Received
              </th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">From</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Subject</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground w-36">
                Company
              </th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground w-32">
                Status
              </th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell w-20">
                Metrics
              </th>
              <th className="px-4 py-3 w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && !data && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && data?.items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  No emails found.
                </td>
              </tr>
            )}
            {data?.items.map(email => (
              <tr
                key={email.id}
                className="hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => router.push(`/emails/${email.id}`)}
              >
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap hidden sm:table-cell">
                  {fmt(email.received_at)}
                </td>
                <td className="px-4 py-3 max-w-[180px] truncate">{email.from_address}</td>
                <td className="px-4 py-3 max-w-[240px] truncate text-muted-foreground hidden md:table-cell">
                  {email.subject ?? <span className="italic">(no subject)</span>}
                </td>
                <td className="px-4 py-3">
                  {(() => {
                    const needsSetup = email.processing_status === 'needs_review' &&
                      (!email.company || email.company_metrics_count === 0)
                    if (needsSetup) {
                      return (
                        <button
                          className="text-warning hover:text-warning font-medium text-sm underline underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setReviewModalEmailId(email.id)
                          }}
                        >
                          {email.company ? `${email.company.name} · Setup` : 'Unknown'}
                        </button>
                      )
                    }
                    if (!email.company) {
                      return (
                        <button
                          className="text-muted-foreground hover:text-foreground italic text-sm underline underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setReviewModalEmailId(email.id)
                          }}
                        >
                          Unknown
                        </button>
                      )
                    }
                    return <span>{email.company.name}</span>
                  })()}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={email.processing_status} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell">
                  {email.metrics_extracted}
                </td>
                <td className="px-4 py-3 text-center">
                  {email.processing_status === 'needs_review' && (
                    <button
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50 p-1"
                      disabled={!!dismissing[email.id]}
                      onClick={(e) => {
                        e.stopPropagation()
                        dismissReviews(email.id)
                      }}
                    >
                      {dismissing[email.id] ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && (data.total > 0) && (
        <div className="flex items-center justify-between mt-4 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground whitespace-nowrap">
              {data.total} email{data.total !== 1 ? 's' : ''}
            </p>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Show</label>
              <Select
                value={String(pageSize)}
                onValueChange={v => { setPageSize(Number(v)); setPage(1) }}
              >
                <SelectTrigger className="h-7 w-[70px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {getPageNumbers(page, totalPages).map((p, i) =>
                p === '...' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-sm text-muted-foreground">…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 w-8 p-0 text-xs"
                    onClick={() => setPage(p as number)}
                  >
                    {p}
                  </Button>
                )
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      <EmailReviewModal
        emailId={reviewModalEmailId}
        open={!!reviewModalEmailId}
        onOpenChange={(open) => { if (!open) { setReviewModalEmailId(null); load(page) } }}
      />
    </div>
    <AnalystPanel />
    </div>
    </div>
  )
}
