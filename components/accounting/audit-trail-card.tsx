'use client'

import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'

interface AuditEvent {
  id: string; createdAt: string; action: string; subjectType: string; subjectId: string | null
  actorName: string | null; actorId: string | null; reason: string | null; details: Record<string, unknown>
}

// Plain words for each recorded action — an auditor reads this, not a developer.
const ACTION_LABELS: Record<string, string> = {
  'entry.post': 'Posted an entry', 'entry.unpost': 'Unposted an entry', 'entry.void': 'Voided an entry', 'entry.reverse': 'Reversed an entry',
  'entries.bulk_post': 'Posted entries in bulk', 'entries.bulk_void': 'Discarded drafts in bulk',
  'period.close': 'Closed a period', 'period.reopen': 'Reopened periods', 'close.approve': 'Approved a close',
  'commitment.create': 'Recorded a commitment change', 'commitment.edit': 'Edited a commitment', 'commitment.delete': 'Deleted a commitment',
  'lp_position.edit': 'Edited an LP position', 'lp_position.delete': 'Deleted an LP position',
  'snapshot.share': 'Shared an LP report', 'snapshot.unshare': 'Unshared an LP report',
  'lp_statement.force_publish': 'Published an interim LP statement',
  'capital_call.issue': 'Issued a capital call', 'distribution.declare': 'Declared a distribution',
  'k1.generate': 'Generated K-1s', 'k1.finalize': 'Issued K-1s', 'k1.amend': 'Amended K-1s', 'tax.adjustments': 'Posted book-to-tax adjustments',
  'pending_action.approve': 'Approved an Analyst proposal', 'pending_action.reject': 'Rejected an Analyst proposal',
}

/** One line of what the event touched: a date, an amount, a period — whatever it carries. */
function summary(e: AuditEvent): string | null {
  const d = e.details as Record<string, any>
  if (d.periodEnd) return `Through ${d.periodEnd}${d.selfApproved ? ' · self-approved (only member who can do the books)' : ''}`
  if (d.reopenedPeriods?.length) return (d.reopenedPeriods as string[]).join(', ')
  if (d.entryDate || d.memo) return [d.entryDate, d.memo, d.reference && `#${d.reference}`].filter(Boolean).join(' · ')
  if (d.count) return `${d.count} entries`
  if (d.before?.amount != null && d.after?.amount != null && d.before.amount !== d.after.amount) return `${d.before.amount} → ${d.after.amount}`
  if (d.deleted?.amount != null) return `${d.deleted.amount} on ${d.deleted.effectiveDate}`
  if (d.callDate || d.date) return `${d.callDate ?? d.date} · ${d.partners ?? ''} partners`
  if (d.taxYear) return `${d.taxYear}`
  return null
}

/**
 * The entity's audit trail, on its Admin page: the last changes to its books — who, when, and the
 * reason they gave — with the whole trail as a CSV for an auditor. Reads /api/accounting/audit-log.
 */
export function AuditTrailCard() {
  const lf = useLedgerFetch()
  const { group } = useVehicle()
  const [events, setEvents] = useState<AuditEvent[] | null>(null)

  useEffect(() => {
    let cancelled = false
    lf('/api/accounting/audit-log?limit=50')
      .then(r => (r.ok ? r.json() : { events: [] }))
      .then(d => { if (!cancelled) setEvents(d.events ?? []) })
      .catch(() => { if (!cancelled) setEvents([]) })
    return () => { cancelled = true }
  }, [lf])

  if (!events) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <div className="space-y-3">
      {events.length === 0
        ? <p className="text-sm text-muted-foreground">Nothing recorded yet. Voids, reopens, approvals, commitment changes and shared reports appear here as they happen.</p>
        : (
          <ul className="divide-y rounded-lg border text-sm">
            {events.map(e => (
              <li key={e.id} className="px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{new Date(e.createdAt).toLocaleString()} · {e.actorName ?? 'Unknown user'}</span>
                </div>
                {summary(e) && <p className="text-xs text-muted-foreground">{summary(e)}</p>}
                {e.reason && <p className="text-xs">Reason: {e.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      <Button size="sm" variant="outline" asChild className="gap-1.5">
        <a href={`/api/accounting/audit-log?format=csv${group ? `&group=${encodeURIComponent(group)}` : ''}`}><Download className="h-3.5 w-3.5" />Download the full trail (.csv)</a>
      </Button>
    </div>
  )
}
