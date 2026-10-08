'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Check, X, Pencil, Loader2, Mail } from 'lucide-react'
import { EmailReviewModal } from '@/components/email-review-modal'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { EmptyState } from '@/components/ui/empty-state'
import { FundReviewCard, resolveSummary, type FundReviewDecision } from '@/components/fund-review-card'
import { isFundReviewType, type FundProposal } from '@/lib/portfolio/fof-review-types'
import { investingEntities } from '@/lib/portfolio/investing-entities'
import { useCanWrite } from '@/components/access-context'

interface ReviewItem {
  id: string
  issue_type: string
  extracted_value: string | null
  context_snippet: string | null
  created_at: string
  company: { id: string; name: string } | null
  metric: { id: string; name: string; unit: string | null; value_type: string } | null
  email: { id: string; subject: string | null; received_at: string; from_address: string; diligence_deal_id?: string | null } | null
  payload?: FundProposal | null
  vehicle?: { id: string; name: string } | null
}

interface NeedsReviewEmail {
  id: string
  from_address: string
  subject: string | null
  received_at: string
  company: { id: string; name: string } | null
}

interface ReviewData {
  total: number
  counts: Record<string, number>
  items: ReviewItem[]
  needsReviewEmails: NeedsReviewEmail[]
}

const ISSUE_LABELS: Record<string, string> = {
  new_company_detected: 'New Company',
  low_confidence: 'Low Confidence',
  ambiguous_period: 'Ambiguous Period',
  metric_not_found: 'Metric Not Found',
  company_not_identified: 'Unidentified Company',
  duplicate_period: 'Duplicate Period',
  diligence_intake_pending: 'Diligence Match',
  fund_nav: 'Manager NAV',
  fund_capital_call: 'Capital call',
  fund_distribution: 'Distribution',
}

const STATUS_COLORS: Record<string, string> = {
  new_company_detected: 'bg-info-subtle text-info border-info',
  low_confidence: 'bg-warning-subtle text-warning border-warning',
  ambiguous_period: 'bg-warning-subtle text-warning border-warning',
  metric_not_found: 'bg-muted text-muted-foreground border-border',
  company_not_identified: 'bg-destructive-subtle text-destructive border-destructive',
  duplicate_period: 'bg-warning-subtle text-warning border-warning',
  diligence_intake_pending: 'bg-warning-subtle text-warning border-warning',
  fund_nav: 'bg-info-subtle text-info border-info',
  fund_capital_call: 'bg-info-subtle text-info border-info',
  fund_distribution: 'bg-info-subtle text-info border-info',
}

export default function ReviewPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ReviewData | null>(null)
  const [resolving, setResolving] = useState<Record<string, boolean>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [reviewModalEmailId, setReviewModalEmailId] = useState<string | null>(null)
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([])
  const [fundMessage, setFundMessage] = useState<{ text: string; error: boolean } | null>(null)
  const canWrite = useCanWrite('portfolio', 'investments')

  // `silent` refetches without the spinner: after resolving an item the list is already correct
  // optimistically, and blanking the page to a loader would be a worse answer than the one on
  // screen. What it's really for is the OTHER list — see resolve().
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const res = await fetch('/api/review')
      if (!res.ok) throw new Error('Failed to load')
      setData(await res.json())
    } catch {
      if (!opts?.silent) setData(null)
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // A fund review naming no entity asks the approver to choose one of theirs.
  const needsEntities = (data?.items ?? []).some(i => isFundReviewType(i.issue_type) && !i.vehicle)
  useEffect(() => {
    if (!needsEntities) return
    let cancelled = false
    fetch('/api/entities')
      .then(r => (r.ok ? r.json() : []))
      .then(rows => { if (!cancelled) setEntities(investingEntities(rows)) })
      .catch(() => { if (!cancelled) setEntities([]) })
    return () => { cancelled = true }
  }, [needsEntities])

  async function resolveFund(item: ReviewItem, decision: FundReviewDecision) {
    setResolving(prev => ({ ...prev, [item.id]: true }))
    setFundMessage(null)
    try {
      const res = await fetch(`/api/review/${item.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFundMessage({ text: json?.error ?? 'That could not be resolved.', error: true })
        // Already resolved elsewhere (409) or the approval threw: the list is stale either way.
        load({ silent: true })
        return
      }
      setFundMessage({ text: resolveSummary(json) ?? 'Done.', error: false })
      setData(prev => prev ? {
        ...prev,
        total: prev.total - 1,
        counts: { ...prev.counts, [item.issue_type]: (prev.counts[item.issue_type] ?? 1) - 1 },
        items: prev.items.filter(i => i.id !== item.id),
      } : prev)
      load({ silent: true })
    } catch {
      setFundMessage({ text: 'That could not be resolved. Check your connection and try again.', error: true })
    } finally {
      setResolving(prev => ({ ...prev, [item.id]: false }))
    }
  }

  async function resolve(
    item: ReviewItem,
    resolution: 'accepted' | 'rejected' | 'manually_corrected',
    resolvedValue?: string,
  ) {
    setResolving(prev => ({ ...prev, [item.id]: true }))
    try {
      const res = await fetch(`/api/review/${item.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution, resolved_value: resolvedValue }),
      })
      if (!res.ok) throw new Error('Failed to resolve')
      setData(prev =>
        prev
          ? {
              ...prev,
              total: prev.total - 1,
              counts: {
                ...prev.counts,
                [item.issue_type]: (prev.counts[item.issue_type] ?? 1) - 1,
              },
              items: prev.items.filter(i => i.id !== item.id),
            }
          : prev,
      )
      // Resolving the LAST open item on an email flips that email to 'success' server-side
      // (api/review/[id]/resolve), so the "Emails needing review" section below is now stale —
      // it went on listing emails the server had already cleared, which read as work left undone
      // while the sidebar's Review link (badge = items + emails) correctly vanished at zero.
      // The optimistic edit above can't know that, because the promotion depends on rows this
      // component never sees. Ask the server.
      load({ silent: true })
    } catch {
      // ignore
    } finally {
      setResolving(prev => ({ ...prev, [item.id]: false }))
      setEditingId(null)
    }
  }

  async function processDiligenceAsReporting(item: ReviewItem) {
    if (!item.email) return
    setResolving(prev => ({ ...prev, [item.id]: true }))
    try {
      const res = await fetch(`/api/emails/${item.email.id}/reroute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'reporting' }),
      })
      if (!res.ok) throw new Error('Failed to process email as reporting')
      load({ silent: true })
    } finally {
      setResolving(prev => ({ ...prev, [item.id]: false }))
    }
  }

  const items = data?.items ?? []

  return (
    <div className="p-4 md:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Items that need your attention, metrics AI wasn&apos;t sure about, unidentified companies, and more.
          </p>
        </div>
        <AnalystToggleButton />
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 max-w-4xl w-full">
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && items.length === 0 && (data?.needsReviewEmails ?? []).length === 0 && (
        <EmptyState>All clear, nothing to review.</EmptyState>
      )}

      {fundMessage && (
        <p role="status" className={`mb-3 text-sm ${fundMessage.error ? 'text-destructive' : ''}`}>{fundMessage.text}</p>
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-3">
          {items.map(item => {
            if (isFundReviewType(item.issue_type) && item.payload) {
              return (
                <FundReviewCard
                  key={item.id}
                  item={{ id: item.id, issue_type: item.issue_type, payload: item.payload, context_snippet: item.context_snippet, company: item.company, vehicle: item.vehicle ?? null }}
                  entities={entities}
                  busy={!!resolving[item.id]}
                  readOnly={!canWrite}
                  onResolve={d => resolveFund(item, d)}
                />
              )
            }
            const isEditing = editingId === item.id
            const isResolving = !!resolving[item.id]
            const hasValue = !!item.extracted_value

            return (
              <div key={item.id} className="rounded-card border bg-card p-4 space-y-3">
                {/* Header row */}
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.issue_type] ?? ''}`}
                  >
                    {ISSUE_LABELS[item.issue_type] ?? item.issue_type}
                  </span>
                  {item.company && (
                    <Link
                      href={`/companies/${item.company.id}`}
                      className="text-sm font-medium hover:underline"
                      onClick={e => e.stopPropagation()}
                    >
                      {item.company.name}
                    </Link>
                  )}
                  {item.metric && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-sm text-muted-foreground">{item.metric.name}</span>
                    </>
                  )}
                  {item.email && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {item.email.subject ?? '(no subject)'}, {new Date(item.email.received_at).toLocaleDateString()}
                    </span>
                  )}
                </div>

                {/* Extracted value */}
                {hasValue && !isEditing && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">Value</span>
                    <span className="font-mono text-sm bg-muted px-2 py-0.5 rounded">
                      {item.extracted_value}
                      {item.metric?.unit ? ` ${item.metric.unit}` : ''}
                    </span>
                  </div>
                )}

                {/* Inline edit */}
                {isEditing && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      className="h-8 w-40 font-mono text-sm"
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') resolve(item, 'manually_corrected', editValue)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => resolve(item, 'manually_corrected', editValue)}
                      disabled={isResolving || !editValue.trim()}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                )}

                {/* Context snippet */}
                {item.context_snippet && (
                  <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground italic leading-relaxed">
                    {item.context_snippet}
                  </blockquote>
                )}

                {/* Actions */}
                {!isEditing && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {item.issue_type === 'diligence_intake_pending' ? (
                      <>
                        {item.email?.diligence_deal_id && (
                          <Button size="sm" asChild className="gap-1.5">
                            <Link href={`/diligence/${item.email.diligence_deal_id}?tab=data-room`}>
                              <Check className="h-3.5 w-3.5" />
                              Review &amp; accept
                            </Link>
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => processDiligenceAsReporting(item)} disabled={isResolving} className="gap-1.5">
                          <X className="h-3.5 w-3.5" />
                          Not diligence — process as reporting
                        </Button>
                      </>
                    ) : item.issue_type === 'new_company_detected' || item.issue_type === 'company_not_identified' ? (
                      <Button size="sm" variant="outline" onClick={() => resolve(item, 'rejected')} disabled={isResolving} className="gap-1.5">
                        <X className="h-3.5 w-3.5" />
                        Dismiss
                      </Button>
                    ) : (
                      <>
                        {item.issue_type !== 'metric_not_found' && hasValue && (
                          <Button size="sm" onClick={() => resolve(item, 'accepted')} disabled={isResolving} className="gap-1.5">
                            <Check className="h-3.5 w-3.5" />
                            Accept
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => resolve(item, 'rejected')} disabled={isResolving} className="gap-1.5">
                          <X className="h-3.5 w-3.5" />
                          {item.issue_type === 'metric_not_found' ? 'Dismiss' : 'Reject'}
                        </Button>
                        {hasValue && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingId(item.id)
                              setEditValue(item.extracted_value ?? '')
                            }}
                            disabled={isResolving}
                            className="gap-1.5"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit &amp; Accept
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!loading && (data?.needsReviewEmails ?? []).length > 0 && (
        <div className="mt-6">
          <h2 className="text-base font-medium text-muted-foreground mb-3">
            Emails needing review ({data!.needsReviewEmails.length})
          </h2>
          <div className="space-y-2">
            {data!.needsReviewEmails.map(email => (
              <button
                key={email.id}
                onClick={() => setReviewModalEmailId(email.id)}
                className="w-full rounded-card border bg-card p-4 text-left hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Mail className="h-4 w-4 text-warning shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {email.subject || '(no subject)'}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      <span>{email.from_address}</span>
                      <span>{new Date(email.received_at).toLocaleDateString()}</span>
                      {email.company ? (
                        <span>{email.company.name}</span>
                      ) : (
                        <span className="text-warning">No company assigned</span>
                      )}
                    </div>
                  </div>
                  <Badge variant="outline" className="bg-warning-subtle text-warning border-warning shrink-0">
                    Needs Review
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <EmailReviewModal
        emailId={reviewModalEmailId}
        open={!!reviewModalEmailId}
        onOpenChange={(open) => {
          if (!open) {
            setReviewModalEmailId(null)
            load()
          }
        }}
      />
    </div>
    <AnalystPanel />
    </div>
    </div>
  )
}
