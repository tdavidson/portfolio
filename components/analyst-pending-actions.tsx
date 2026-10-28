'use client'

// Writes the Analyst DRAFTED, rendered as reviewable cards. Nothing here has taken effect: each is
// a staged pending_action. Approve runs the real write (the same path the direct API uses); Reject
// discards it. Both endpoints re-check the caller's WRITE access for the action's domain.

import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleSlash, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { announceApplied } from '@/lib/pending-actions/applied-event'
import { isRunResult, RunPreview, RunResultView, type RunResult } from '@/components/agent-run-card'

export interface PreviewResult {
  summary: string
  details: Record<string, unknown>
}
export interface StagedAction {
  id: string
  actionType: string
  preview: PreviewResult
}

type CardState = 'idle' | 'busy' | 'applied' | 'rejected' | 'error'

export function AnalystPendingActions({ actions, title = 'Proposed changes — approve to apply', withdrawn }: {
  actions: StagedAction[]
  title?: string
  /** Drafts the Analyst took back (replaced by a revision, or the person moved on): no longer approvable. */
  withdrawn?: ReadonlySet<string>
}) {
  const [state, setState] = useState<Record<string, CardState>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // A run's outcome (lib/agent/run-action.ts): each step's result and the checks, shown once applied.
  const [runs, setRuns] = useState<Record<string, RunResult>>({})

  // Publishing to LPs asks twice: the first click only opens the confirmation (CONFIRM_IN_APP).
  const [confirming, setConfirming] = useState<Record<string, boolean>>({})

  async function act(a: StagedAction, kind: 'approve' | 'reject', confirmed = false) {
    setState(s => ({ ...s, [a.id]: 'busy' }))
    setErrors(e => ({ ...e, [a.id]: '' }))
    setConfirming(c => ({ ...c, [a.id]: false }))
    try {
      const res = await fetch(`/api/pending-actions/${a.id}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed ? { confirmed: true } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        setState(s => ({ ...s, [a.id]: 'error' }))
        setErrors(e => ({ ...e, [a.id]: data.error ?? `Could not ${kind}` }))
        return
      }
      setState(s => ({ ...s, [a.id]: kind === 'approve' ? 'applied' : 'rejected' }))
      if (kind === 'approve' && isRunResult(data.result)) setRuns(r => ({ ...r, [a.id]: data.result }))
      if (kind === 'approve') announceApplied({ actionType: a.actionType, result: data.result })
    } catch {
      setState(s => ({ ...s, [a.id]: 'error' }))
      setErrors(e => ({ ...e, [a.id]: 'Network error.' }))
    }
  }

  // A rejected draft is gone: nothing more to do with it, so it leaves the panel.
  const shown = actions.filter(a => state[a.id] !== 'rejected')
  if (shown.length === 0) return null

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {shown.map(a => {
        const st = state[a.id] ?? 'idle'
        if (withdrawn?.has(a.id) && st !== 'applied') {
          return (
            <div key={a.id} className="border rounded-card px-3 py-2 text-xs text-muted-foreground flex items-start gap-1.5">
              <Undo2 className="h-3.5 w-3.5 mt-px shrink-0" />
              <span><span className="line-through">{a.preview.summary}</span> Withdrawn: the Analyst replaced or dropped this proposal.</span>
            </div>
          )
        }
        return (
          <div key={a.id} className="border rounded-card p-3 space-y-2">
            <p className="text-xs font-medium">{a.preview.summary}</p>
            {a.actionType === 'agent_run' ? (
              runs[a.id]
                ? <RunResultView id={a.id} result={runs[a.id]} onChange={next => setRuns(r => ({ ...r, [a.id]: next }))} />
                : <RunPreview details={a.preview.details} />
            ) : a.actionType === CONFIRM_TWICE ? (
              <CallNoticesPreview details={a.preview.details} />
            ) : (
              <PreviewDetails details={a.preview.details} />
            )}
            {st === 'applied' ? (
              <span className="text-xs text-success flex items-center gap-1">
                <Check className="h-3.5 w-3.5" />Applied.
              </span>
            ) : st === 'rejected' ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <X className="h-3.5 w-3.5" />Rejected.
              </span>
            ) : a.actionType === CONFIRM_TWICE && confirming[a.id] ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning bg-warning-subtle p-2">
                <span className="text-xs">{confirmLine(a.preview.details)}</span>
                <Button size="sm" onClick={() => act(a, 'approve', true)}>Yes, publish</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(c => ({ ...c, [a.id]: false }))}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  size="sm" variant="outline"
                  onClick={() => a.actionType === CONFIRM_TWICE ? setConfirming(c => ({ ...c, [a.id]: true })) : act(a, 'approve')}
                  disabled={st === 'busy' || (a.actionType === CONFIRM_TWICE && hasBlocker(a.preview.details))}
                >
                  {st === 'busy' ? 'Working…' : a.actionType === CONFIRM_TWICE ? 'Approve publishing…' : 'Approve'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act(a, 'reject')} disabled={st === 'busy'}>
                  Reject
                </Button>
              </div>
            )}
            {st === 'error' && errors[a.id] && <p className="text-sm text-destructive">{errors[a.id]}</p>}
          </div>
        )
      })}
    </div>
  )
}

/** Actions that publish to LPs: previewed per partner, and approved with a second confirmation. */
const CONFIRM_TWICE = 'publish_call_notices'

interface NoticeFlag { code: string; severity: 'blocker' | 'warning'; message: string }
interface NoticeMissing { field: string; label: string; why: string }
interface NoticePartner { lpEntityId: string; name: string; amount: number; share: number; alreadyPublished: boolean; portalAccount: string | null }

function hasBlocker(details: Record<string, unknown>): boolean {
  return ((details.flags as NoticeFlag[] | undefined) ?? []).some(f => f.severity === 'blocker')
}

function confirmLine(details: Record<string, unknown>): string {
  const n = Number(details.newNotices ?? 0)
  return `Publish ${n} notice${n === 1 ? '' : 's'} to partners' LP portals now? Partners can open ${n === 1 ? 'it' : 'them'} as soon as ${n === 1 ? 'it is' : 'they are'} published.`
}

/** A call's notices before they go out: each partner's figure, a DRAFT PDF of their notice, and the checks. */
function CallNoticesPreview({ details }: { details: Record<string, unknown> }) {
  const call = details.call as { id: string; noticeDate: string; dueDate: string | null; total: number } | undefined
  const partners = (details.partners as NoticePartner[] | undefined) ?? []
  const missing = (details.missing as NoticeMissing[] | undefined) ?? []
  const flags = (details.flags as NoticeFlag[] | undefined) ?? []
  const vehicle = String(details.vehicle ?? '')
  const pdf = (lp: string) =>
    `/api/accounting/notices/preview?group=${encodeURIComponent(vehicle)}&id=${encodeURIComponent(call?.id ?? '')}&lp=${encodeURIComponent(lp)}`
  return (
    <div className="space-y-2">
      {call && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {vehicle} · dated {call.noticeDate} · due {call.dueDate ?? 'not stated'} · total {formatVal(call.total)}
        </p>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium py-0.5">Partner</th>
            <th className="text-right font-medium py-0.5">Amount</th>
            <th className="text-right font-medium py-0.5">Share</th>
            <th className="text-left font-medium py-0.5 pl-3">Portal</th>
            <th className="py-0.5" />
          </tr>
        </thead>
        <tbody>
          {partners.map(p => (
            <tr key={p.lpEntityId} className="border-t">
              <td className="py-0.5">{p.name}</td>
              <td className="py-0.5 text-right tabular-nums">{formatVal(p.amount)}</td>
              <td className="py-0.5 text-right tabular-nums">{(p.share * 100).toFixed(2)}%</td>
              <td className="py-0.5 pl-3 text-muted-foreground">{p.alreadyPublished ? 'already published' : (p.portalAccount ?? 'no account yet')}</td>
              <td className="py-0.5 text-right">
                <a href={pdf(p.lpEntityId)} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">Preview</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(missing.length > 0 || flags.length > 0) && (
        <div className="space-y-1 text-xs">
          {missing.map(m => (
            <p key={m.field} className="flex items-start gap-1.5">
              <CircleSlash className="h-3.5 w-3.5 mt-px shrink-0 text-muted-foreground" />
              <span><span className="font-medium">Missing: {m.label}.</span> <span className="text-muted-foreground">{m.why}</span></span>
            </p>
          ))}
          {flags.map((f, i) => (
            <p key={`${f.code}-${i}`} className="flex items-start gap-1.5">
              <AlertTriangle className={`h-3.5 w-3.5 mt-px shrink-0 ${f.severity === 'blocker' ? 'text-destructive' : 'text-warning'}`} />
              <span>{f.message}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** Longer than this, a text value goes behind "Show details" rather than into the card. */
const INLINE_TEXT_MAX = 400
/** More per-LP rows than this and the table goes behind "Show details" too. */
const INLINE_LP_ROWS = 8

function isEmpty(v: unknown): boolean {
  if (v == null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  return typeof v === 'object' && Object.keys(v as object).length === 0
}

/** Short values read inline; lists, objects and long text are what makes a card a wall. */
function isBulky(v: unknown): boolean {
  if (typeof v === 'string') return v.length > INLINE_TEXT_MAX
  return typeof v === 'object' && v !== null
}

function bulkLabel(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`
  if (typeof v === 'object' && v !== null) {
    const n = Object.keys(v).length
    return `${n} field${n === 1 ? '' : 's'}`
  }
  return `${String(v).length.toLocaleString()} characters`
}

/**
 * Render a preview's structured details. Short values show inline; lists, objects and long text
 * (a forecast's every account rule, say) wait behind "Show details", so the card stays readable.
 * Empty values are left out.
 */
function PreviewDetails({ details }: { details: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const perLp = details.perLp as Array<{ lp: string; commitment?: number; amount: number }> | undefined
  const entries = Object.entries(details).filter(([k, v]) => k !== 'perLp' && !isEmpty(v))
  const inline = entries.filter(([, v]) => !isBulky(v))
  const bulky = entries.filter(([, v]) => isBulky(v))
  const lpInline = !!perLp && perLp.length > 0 && perLp.length <= INLINE_LP_ROWS
  const lpBulky = !!perLp && perLp.length > INLINE_LP_ROWS
  const hidden = [
    ...bulky.map(([k, v]) => `${k} (${bulkLabel(v)})`),
    ...(lpBulky ? [`perLp (${perLp!.length} LPs)`] : []),
  ]

  return (
    <div className="space-y-1.5">
      {inline.length > 0 && <DetailList entries={inline} />}
      {lpInline && <PerLpTable rows={perLp!} />}
      {hidden.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {open ? 'Hide details' : `Show details: ${hidden.join(', ')}`}
          </button>
          {open && (
            <div className="space-y-2">
              {bulky.map(([k, v]) => (
                <div key={k} className="space-y-0.5">
                  <p className="text-[11px] text-muted-foreground">{k}</p>
                  {typeof v === 'string'
                    ? <p className="text-[11px] whitespace-pre-wrap">{v}</p>
                    : (
                      <pre className="max-h-80 overflow-auto rounded-md border bg-muted p-2 text-[11px] whitespace-pre-wrap break-words">
                        {JSON.stringify(v, null, 2)}
                      </pre>
                    )}
                </div>
              ))}
              {lpBulky && <PerLpTable rows={perLp!} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DetailList({ entries }: { entries: Array<[string, unknown]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular-nums break-words">{formatVal(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function PerLpTable({ rows }: { rows: Array<{ lp: string; commitment?: number; amount: number }> }) {
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left font-medium py-0.5">LP</th>
          <th className="text-right font-medium py-0.5">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t">
            <td className="py-0.5">{r.lp}</td>
            <td className="py-0.5 text-right tabular-nums">{formatVal(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function formatVal(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
