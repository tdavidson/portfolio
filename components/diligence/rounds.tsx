'use client'

// Diligence rounds on the deal page: the round bar under the deal header (which round you are
// looking at, start the next round, close the current one), what changed in a round's evidence,
// the follow-up request list a round leaves, and the round switch the Scoring and Memo tabs use to
// show one round's scoring table or memo at a time.

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, Copy, Loader2, Lock, Plus, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  CHANGE_KIND_LABEL, CHANGE_KINDS, defaultRoundLabel, requestListText, ROUND_OUTCOME_LABEL, ROUND_OUTCOMES,
  type ChangeStatus, type RequestItem, type RoundChanges, type RoundItemChange, type RoundOutcome,
} from '@/lib/diligence/rounds'

export interface RoundSummary {
  id: string
  round_number: number
  label: string
  status: 'open' | 'closed'
  outcome: RoundOutcome | null
  summary: string | null
  request_list: RequestItem[]
  opened_at: string
  closed_at: string | null
  draft: { id: string; draft_version: string; is_draft: boolean; finalized_at: string | null; created_at: string; has_memo: boolean; has_scores: boolean } | null
  documents: number
  notes: number
}

interface RoundDetail {
  round: RoundSummary
  previous: RoundSummary | null
  changes: RoundChanges
  requested: RequestItem[]
  request_list: RequestItem[]
  draft_id: string | null
  documents: Array<{ id: string; file_name: string; detected_type: string | null; uploaded_at: string }>
}

/** The deal's rounds and which one the page is showing (the current round unless one is picked). */
export function useRounds(dealId: string) {
  const [rounds, setRounds] = useState<RoundSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/diligence/${dealId}/rounds`)
      const rows = res.ok ? await res.json() : []
      setRounds(Array.isArray(rows) ? rows : [])
    } catch {
      setRounds([])
    } finally {
      setLoaded(true)
    }
  }, [dealId])

  useEffect(() => { refresh() }, [refresh])

  const current = rounds[rounds.length - 1] ?? null
  const selected = rounds.find(r => r.id === selectedId) ?? current
  return {
    rounds, loaded, current, selected,
    /** Show a round; null (or the current round) follows the current round. */
    select: (id: string | null) => setSelectedId(id && id !== current?.id ? id : null),
    refresh,
  }
}

export type RoundsState = ReturnType<typeof useRounds>

const OUTCOME_SHORT: Record<RoundOutcome, string> = { advance: 'Advanced', hold: 'On hold', pass: 'Passed', invest: 'Invest' }

function roundName(r: Pick<RoundSummary, 'round_number' | 'label'>): string {
  return `Round ${r.round_number}${r.label ? ` · ${r.label}` : ''}`
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : ''
}

/**
 * The round bar: which round the page shows, and the round actions. Sits under the deal header;
 * a deal with one open round shows a single line with "Start next round".
 */
export function RoundBar({ dealId, state, onChanged }: { dealId: string; state: RoundsState; onChanged?: () => void }) {
  const { rounds, current, selected, select, refresh } = state
  const [startOpen, setStartOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [showChanges, setShowChanges] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!current || !selected) return null
  const viewingPast = selected.id !== current.id

  async function reopen() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/rounds/${current!.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'open' }),
      })
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Could not reopen the round.')
      await refresh(); onChanged?.()
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-card border bg-card mb-4">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="text-xs text-muted-foreground">Diligence</span>
        <RoundSwitch rounds={rounds} selectedId={selected.id} onSelect={select} />
        <span className="text-xs text-muted-foreground">
          {selected.status === 'closed'
            ? <><Lock className="h-3 w-3 inline -mt-0.5 mr-0.5" />Closed {fmtDate(selected.closed_at)}{selected.outcome ? ` · ${OUTCOME_SHORT[selected.outcome]}` : ''}</>
            : <>Open since {fmtDate(selected.opened_at)}</>}
          {` · ${selected.documents} document${selected.documents === 1 ? '' : 's'} added`}
        </span>
        <button
          type="button"
          onClick={() => setShowChanges(s => !s)}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
        >
          {selected.round_number > 1 ? 'What changed' : 'Request list'}
          <ChevronDown className={`h-3 w-3 transition-transform ${showChanges ? 'rotate-180' : ''}`} />
        </button>
        <span className="ml-auto flex items-center gap-2">
          {viewingPast && (
            <Button variant="ghost" size="sm" className="h-7" onClick={() => select(null)}>Back to round {current.round_number}</Button>
          )}
          {!viewingPast && current.status === 'open' && (
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setCloseOpen(true)}>Close round</Button>
          )}
          {!viewingPast && current.status === 'closed' && (
            <Button variant="ghost" size="sm" className="h-7" onClick={reopen} disabled={busy}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reopen
            </Button>
          )}
          {!viewingPast && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => setStartOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Start round {current.round_number + 1}
            </Button>
          )}
        </span>
      </div>
      {error && <div className="px-3 pb-2 text-sm text-destructive">{error}</div>}
      {viewingPast && (
        <div className="px-3 pb-2 text-xs text-muted-foreground">
          You are looking at round {selected.round_number} as it was when it closed. Its memo and scoring are read only; work continues in round {current.round_number}.
        </div>
      )}
      {showChanges && (
        <div className="border-t px-3 py-3">
          <RoundChangesPanel dealId={dealId} roundId={selected.id} refreshKey={`${selected.id}:${selected.status}:${selected.draft?.id ?? ''}`} />
        </div>
      )}

      {startOpen && <StartRoundDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        dealId={dealId}
        current={current}
        onDone={async () => { await refresh(); select(null); onChanged?.() }}
      />}
      {closeOpen && <CloseRoundDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        dealId={dealId}
        current={current}
        onDone={async () => { await refresh(); onChanged?.() }}
      />}
    </div>
  )
}

/** Round 1 · Round 2 · …: picks which round a tab shows. */
export function RoundSwitch({ rounds, selectedId, onSelect, compact }: {
  rounds: RoundSummary[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  compact?: boolean
}) {
  if (rounds.length === 0) return null
  if (rounds.length === 1) {
    return <span className="text-sm font-medium">{compact ? `Round ${rounds[0].round_number}` : roundName(rounds[0])}</span>
  }
  return (
    <div className="inline-flex flex-wrap rounded-lg border p-0.5" role="tablist" aria-label="Diligence round">
      {rounds.map(r => {
        const active = r.id === selectedId
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(r.id)}
            title={roundName(r)}
            className={`px-2 py-0.5 rounded-md text-xs inline-flex items-center gap-1 ${active ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {r.status === 'closed' && <Lock className="h-3 w-3" />}
            {compact ? `Round ${r.round_number}` : roundName(r)}
          </button>
        )
      })}
    </div>
  )
}

/** A small "R2" mark for something that arrived in a later round. */
export function RoundTag({ roundNumber }: { roundNumber: number | null | undefined }) {
  if (!roundNumber) return null
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground tabular-nums" title={`Arrived in diligence round ${roundNumber}`}>
      R{roundNumber}
    </span>
  )
}

const STATUS_LABEL: Record<ChangeStatus, string> = { new: 'New', changed: 'Changed', resolved: 'Resolved', confirmed: 'Unchanged' }
const STATUS_CLASS: Record<ChangeStatus, string> = {
  new: 'bg-muted text-foreground',
  changed: 'bg-warning-subtle dark:bg-warning-subtle/30 text-warning',
  resolved: 'bg-success-subtle dark:bg-success-subtle/30 text-success',
  confirmed: 'bg-muted text-muted-foreground',
}

/**
 * One round's findings, separated from the rest: what is new, changed or resolved since the
 * previous round, what the previous round asked for, and the request list this round leaves.
 */
export function RoundChangesPanel({ dealId, roundId, refreshKey }: { dealId: string; roundId: string; refreshKey?: string }) {
  const [detail, setDetail] = useState<RoundDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'notable' | 'all'>('notable')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/diligence/${dealId}/rounds/${roundId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(body => { if (!cancelled) setDetail(body) })
      .catch(() => { if (!cancelled) setDetail(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dealId, roundId, refreshKey])

  if (loading) return <div className="text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 inline animate-spin mr-1" />Loading round…</div>
  if (!detail) return <div className="text-xs text-muted-foreground">Could not load this round.</div>

  const { round, previous, changes } = detail
  const items = changes.items.filter(i => filter === 'all' || i.status !== 'confirmed')
  const totals = { new: 0, changed: 0, resolved: 0, confirmed: 0 } as Record<ChangeStatus, number>
  for (const i of changes.items) totals[i.status] += 1

  return (
    <div className="space-y-4 text-sm">
      {round.summary && <p className="text-xs whitespace-pre-wrap">{round.summary}</p>}

      {previous && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="text-xs font-medium">Since round {previous.round_number}</div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {totals.new} new · {totals.changed} changed · {totals.resolved} resolved · {totals.confirmed} unchanged
            </span>
            <span className="ml-auto inline-flex rounded-lg border p-0.5">
              {(['notable', 'all'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`px-2 py-0.5 rounded-md text-[11px] ${filter === f ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {f === 'notable' ? 'Changed this round' : 'Everything'}
                </button>
              ))}
            </span>
          </div>
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {round.draft ? 'Nothing in the evidence has changed yet. Analyze the new documents and re-run research to fold them in.' : 'This round has no evidence yet.'}
            </p>
          ) : (
            <div className="space-y-3">
              {CHANGE_KINDS.map(kind => {
                const rows = items.filter(i => i.kind === kind)
                if (rows.length === 0) return null
                return (
                  <div key={kind}>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{CHANGE_KIND_LABEL[kind]}</div>
                    <ul className="space-y-1">
                      {rows.map(r => <ChangeRow key={`${r.kind}:${r.key}:${r.status}`} item={r} />)}
                    </ul>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {detail.requested.length > 0 && (
        <RequestList title={`Asked for at the end of round ${previous?.round_number}`} items={detail.requested} />
      )}

      <RequestList
        title={round.status === 'closed' ? `Request list round ${round.round_number} left` : 'Still to ask for'}
        items={detail.request_list}
        empty={round.status === 'closed' ? 'Nothing was outstanding when this round closed.' : 'Nothing outstanding: every checklist item is covered and no gaps or open issues remain.'}
        copyable
      />

      {detail.documents.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Documents added in round {round.round_number}</div>
          <ul className="text-xs space-y-0.5">
            {detail.documents.map(d => (
              <li key={d.id} className="truncate">{d.file_name}<span className="text-muted-foreground"> · {fmtDate(d.uploaded_at)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ChangeRow({ item }: { item: RoundItemChange }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CLASS[item.status]}`}>{STATUS_LABEL[item.status]}</span>
      <span className="min-w-0">
        <span className="font-medium">{item.label}</span>
        <span className="text-muted-foreground">: {item.status === 'changed' && item.prior_detail ? <><s>{item.prior_detail}</s> → {item.detail}</> : item.detail}</span>
      </span>
    </li>
  )
}

function RequestList({ title, items, empty, copyable }: { title: string; items: RequestItem[]; empty?: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(requestListText(items))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard refused; the list is on screen */ }
  }
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>
        {copyable && items.length > 0 && (
          <button type="button" onClick={copy} className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5">
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy as text'}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        empty ? <p className="text-xs text-muted-foreground">{empty}</p> : null
      ) : (
        <ul className="text-xs space-y-0.5">
          {items.map((r, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={`shrink-0 w-14 text-[10px] ${r.priority === 'high' ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                {r.priority === 'high' ? 'Needed' : r.priority === 'medium' ? 'Helpful' : 'If any'}
              </span>
              <span className="min-w-0">{r.label}{r.detail && r.source !== 'attention' && <span className="text-muted-foreground"> · {r.detail}</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function OutcomePicker({ value, onChange }: { value: RoundOutcome | ''; onChange: (v: RoundOutcome | '') => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as RoundOutcome | '')}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      aria-label="Outcome of the round"
    >
      <option value="">No decision recorded</option>
      {ROUND_OUTCOMES.map(o => <option key={o} value={o}>{ROUND_OUTCOME_LABEL[o]}</option>)}
    </select>
  )
}

function StartRoundDialog({ open, onOpenChange, dealId, current, onDone }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  dealId: string
  current: RoundSummary
  onDone: () => void | Promise<void>
}) {
  // Mounted each time it opens, so its fields start fresh.
  const next = current.round_number + 1
  const [label, setLabel] = useState(defaultRoundLabel(next))
  const [outcome, setOutcome] = useState<RoundOutcome | ''>('advance')
  const [summary, setSummary] = useState(current.summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/rounds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, ...(current.status === 'open' ? { outcome: outcome || null, summary } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Could not start the round.'); return }
      onOpenChange(false)
      await onDone()
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start round {next}</DialogTitle>
          <DialogDescription>
            {current.status === 'open'
              ? `Round ${current.round_number} closes and keeps its memo, findings and scoring table as they are now. Round ${next} starts from everything known so far; new documents are added to it.`
              : `Round ${next} starts from everything known at the end of round ${current.round_number}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-muted-foreground">Name of round {next}</span>
            <Input value={label} onChange={e => setLabel(e.target.value)} className="mt-1" />
          </label>
          {current.status === 'open' && (
            <>
              <label className="block">
                <span className="text-xs text-muted-foreground">Decision at the end of round {current.round_number}</span>
                <div className="mt-1"><OutcomePicker value={outcome} onChange={setOutcome} /></div>
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">Notes on round {current.round_number} (optional)</span>
                <textarea
                  value={summary}
                  onChange={e => setSummary(e.target.value)}
                  rows={3}
                  className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </label>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !label.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Start round {next}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CloseRoundDialog({ open, onOpenChange, dealId, current, onDone }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  dealId: string
  current: RoundSummary
  onDone: () => void | Promise<void>
}) {
  // Mounted each time it opens, so its fields start fresh.
  const [outcome, setOutcome] = useState<RoundOutcome | ''>(current.outcome ?? '')
  const [summary, setSummary] = useState(current.summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/diligence/${dealId}/rounds/${current.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed', outcome: outcome || null, summary }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Could not close the round.'); return }
      onOpenChange(false)
      await onDone()
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close round {current.round_number}</DialogTitle>
          <DialogDescription>
            The round&apos;s memo, findings and scoring table are kept as they are now and become read only. Its memo can still be marked final. Use this for the last round; to keep going, start the next round instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-muted-foreground">Decision</span>
            <div className="mt-1"><OutcomePicker value={outcome} onChange={setOutcome} /></div>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Notes (optional)</span>
            <textarea
              value={summary}
              onChange={e => setSummary(e.target.value)}
              rows={3}
              className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Close round
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
