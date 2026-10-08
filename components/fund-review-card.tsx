// components/fund-review-card.tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { holdingHref } from '@/lib/portfolio/holding-href'
import { Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCurrency, formatCurrency } from '@/components/currency-context'
import { CAPS, FUND_REVIEW_LABELS, isFundReviewType, type FundProposal } from '@/lib/portfolio/fof-review-types'

export interface FundReviewItem {
  id: string
  issue_type: string
  payload: FundProposal
  context_snippet: string | null
  company: { id: string; name: string } | null
  vehicle: { id: string; name: string } | null
}

export interface FundReviewDecision {
  resolution: 'accepted' | 'rejected'
  vehicleId?: string
  edits?: Record<string, string | number>
}

/** What resolving a fund review did, said back: the message, every later NAV re-booking, any warning. */
export function resolveSummary(json: any): string | null {
  const later: string[] = (Array.isArray(json?.later) ? json.later : []).map((b: any) => b?.message).filter(Boolean)
  const parts = [json?.message, ...later.map(m => `Newer statement: ${m}`), json?.warning].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/**
 * What a manager's email proposes for a fund holding — a NAV, a call, a distribution — for a person
 * to approve, correct or dismiss. Approving writes the register (api/review/[id]/resolve); nothing
 * from the email is on the books until then.
 */
export function FundReviewCard({ item, entities, busy, showHolding = true, readOnly = false, onResolve }: {
  item: FundReviewItem
  /** Entities the approver may choose, when the review names none. */
  entities: { id: string; name: string }[]
  busy: boolean
  /** False inside the holding's own panel, where the holding is already the context. */
  showHolding?: boolean
  /** Members who cannot write see the proposal but not approve or dismiss. */
  readOnly?: boolean
  onResolve: (d: FundReviewDecision) => void
}) {
  const currency = useCurrency()
  const p = item.payload
  const [editing, setEditing] = useState(false)
  const [vehicleId, setVehicleId] = useState('')
  const [date, setDate] = useState(p.kind === 'nav' ? p.asOfDate : p.eventDate)
  const [amount, setAmount] = useState(String(p.kind === 'nav' ? p.reportedNav : p.amount))
  const [noticeNumber, setNoticeNumber] = useState(p.kind === 'nav' ? '' : p.noticeNumber ?? '')
  const [purpose, setPurpose] = useState(p.kind === 'nav' ? '' : p.purpose ?? '')
  const label = isFundReviewType(item.issue_type) ? FUND_REVIEW_LABELS[item.issue_type] : item.issue_type
  const needsEntity = !item.vehicle

  const approve = () => {
    const edits: Record<string, string | number> | undefined = editing
      ? (p.kind === 'nav'
        ? { asOfDate: date, reportedNav: Number(amount) }
        : { eventDate: date, amount: Number(amount), noticeNumber, purpose })
      : undefined
    onResolve({ resolution: 'accepted', ...(needsEntity ? { vehicleId } : {}), ...(edits ? { edits } : {}) })
  }

  return (
    <div className="rounded-card border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-info-subtle text-info border-info">{label}</span>
        {showHolding && item.company && (
          <Link href={holdingHref(item.company.id, item.vehicle?.id)} className="text-sm font-medium hover:underline">{item.company.name}</Link>
        )}
        {item.vehicle && <span className="text-sm text-muted-foreground">· {item.vehicle.name}</span>}
        {p.confidence === 'low' && <span className="text-sm text-warning">Low confidence</span>}
      </div>

      {!editing ? (
        <p className="text-sm">
          {p.kind === 'nav' ? (
            <>NAV <span className="tabular-nums">{formatCurrency(p.reportedNav, currency)}</span> as of <span className="tabular-nums">{p.asOfDate}</span></>
          ) : (
            <>
              <span className="tabular-nums">{formatCurrency(p.amount, currency)}</span> on <span className="tabular-nums">{p.eventDate}</span>
              {p.dueDate && <> · due <span className="tabular-nums">{p.dueDate}</span></>}
              {p.noticeNumber && <> · {p.noticeNumber}</>}
              {p.purpose && <> · {p.purpose}</>}
            </>
          )}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`date-${item.id}`}>{p.kind === 'nav' ? 'As of' : 'Date'}</Label>
            <Input id={`date-${item.id}`} type="date" value={date} onChange={e => setDate(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`amount-${item.id}`}>{p.kind === 'nav' ? 'Reported NAV' : 'Amount'}</Label>
            <Input id={`amount-${item.id}`} type="number" value={amount} onChange={e => setAmount(e.target.value)} className="h-8 w-40 tabular-nums" />
          </div>
          {p.kind !== 'nav' && (
            <>
              <div className="space-y-1">
                <Label htmlFor={`notice-${item.id}`}>Notice number</Label>
                <Input id={`notice-${item.id}`} value={noticeNumber} maxLength={CAPS.noticeNumber} onChange={e => setNoticeNumber(e.target.value)} className="h-8 w-40" />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`purpose-${item.id}`}>Purpose</Label>
                <Input id={`purpose-${item.id}`} value={purpose} maxLength={CAPS.purpose} onChange={e => setPurpose(e.target.value)} className="h-8 w-56" />
              </div>
            </>
          )}
        </div>
      )}

      {p.kind !== 'nav' && p.dateAssumed && !editing && (
        <p className="text-sm text-warning">The document gives no date for this {p.kind}; the date shown is assumed. Check it before approving.</p>
      )}

      {item.context_snippet && (
        <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground italic leading-relaxed">{item.context_snippet}</blockquote>
      )}

      {needsEntity && !readOnly && (
        <div className="space-y-1">
          <Label htmlFor={`entity-${item.id}`}>Which entity holds this fund?</Label>
          <select
            id={`entity-${item.id}`}
            value={vehicleId}
            onChange={e => setVehicleId(e.target.value)}
            className="border rounded-lg px-2 py-1 text-sm h-9 w-full max-w-xs bg-background"
          >
            <option value="">Choose an entity…</option>
            {entities.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" onClick={approve} disabled={busy || (needsEntity && !vehicleId)} className="gap-1.5">
            <Check className="h-3.5 w-3.5" />Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(e => !e)} disabled={busy} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" />{editing ? 'Keep as read' : 'Correct'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve({ resolution: 'rejected' })} disabled={busy} className="gap-1.5">
            <X className="h-3.5 w-3.5" />Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}
