'use client'

// A run (lib/agent/run-action.ts) as the person reviews it: before approval, its title, why, every
// step with its own preview, and the checks that should hold afterwards; after, what each step did,
// where it stopped, how the checks came out, and Undo for what can be taken back.

import { useEffect, useState } from 'react'
import { Check, Clock, Minus, Play, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface RunStepPreview { step: number; tool: string; vehicle: string | null; summary: string }
interface StepOutcome {
  step: number
  tool: string
  status: 'applied' | 'failed' | 'skipped' | 'pending'
  summary?: string
  error?: string
  undo?: unknown[]
  notUndoable?: string
}
interface CheckOutcome {
  label: string
  expected: number | string
  actual: number | string | null
  passed: boolean
  error?: string
}
interface UndoOutcome { step: number; target: { kind: string; id: string }; status: string; message?: string }
export interface RunResult {
  run: {
    steps: StepOutcome[]; checks: CheckOutcome[]; checksFailed: number | null; stoppedAt: number | null; undoable: boolean
    resumeAt?: number | null; inFlight?: number | null; paused?: { at: string; message: string } | null
  }
  undo?: { status: 'running' | 'done' | 'partial'; at: string; outcomes?: UndoOutcome[] }
}

export function isRunResult(v: unknown): v is RunResult {
  return !!v && typeof v === 'object' && !!(v as RunResult).run && Array.isArray((v as RunResult).run.steps)
}

/** What the run will do: shown in place of the generic details while it waits for approval. */
export function RunPreview({ details }: { details: Record<string, unknown> }) {
  const steps = (details.steps ?? []) as RunStepPreview[]
  const expected = (details.expected ?? []) as string[]
  return (
    <div className="space-y-2 text-xs">
      {typeof details.rationale === 'string' && details.rationale && (
        <p className="text-muted-foreground">{details.rationale}</p>
      )}
      <ol className="space-y-1">
        {steps.map(s => (
          <li key={s.step} className="grid grid-cols-[1.5rem_1fr] gap-x-2">
            <span className="tabular-nums text-muted-foreground text-right">{s.step}.</span>
            <span>{s.summary}</span>
          </li>
        ))}
      </ol>
      {expected.length > 0 && (
        <div className="space-y-0.5">
          <p className="font-medium text-muted-foreground">Expected afterwards</p>
          <ul className="space-y-0.5">
            {expected.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

/** What the run did, how the checks came out, and Undo where it applies. */
export function RunResultView({ id, result, onChange }: { id: string; result: RunResult; onChange?: (next: RunResult) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run, undo } = result

  async function undoRun() {
    if (!window.confirm('Undo what this run created? Entries it posted are voided and investment transactions it recorded are deleted, where that is safe.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/pending-actions/${id}/undo`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) { setError(data.error ?? 'Could not undo.'); return }
      if (isRunResult(data.action?.appliedResult)) onChange?.(data.action.appliedResult)
    } catch {
      setError('Network error.')
    } finally {
      setBusy(false)
    }
  }

  async function continueRun() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/pending-actions/${id}/approve`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) { setError(data.error ?? 'Could not continue.'); return }
      if (isRunResult(data.result)) onChange?.(data.result)
    } catch {
      setError('Network error.')
    } finally {
      setBusy(false)
    }
  }

  const unfinished = run.resumeAt != null && run.stoppedAt == null
  const canUndo = run.undoable && undo?.status !== 'done' && undo?.status !== 'running'
  const notUndoable = run.steps.filter(s => s.status === 'applied' && s.notUndoable)

  return (
    <div className="space-y-2 text-xs">
      {run.stoppedAt != null && (
        <p className="rounded-card bg-destructive-subtle text-destructive px-2 py-1">
          Stopped at step {run.stoppedAt}. Steps before it stay applied; nothing after it ran.
        </p>
      )}
      {unfinished && (
        <p className="rounded-card bg-warning-subtle text-warning px-2 py-1">
          {run.paused
            ? run.paused.message
            : `Applying: step ${run.inFlight ?? run.resumeAt} of ${run.steps.length} is running.`}
        </p>
      )}
      <ol className="space-y-1">
        {run.steps.map(s => (
          <li key={s.step} className="grid grid-cols-[1.5rem_1rem_1fr] gap-x-2 items-start">
            <span className="tabular-nums text-muted-foreground text-right">{s.step}.</span>
            <StatusIcon status={s.status} />
            <span>
              <span className="font-mono">{s.tool}</span>
              {s.status === 'applied' && s.summary ? <span className="text-muted-foreground"> · {s.summary}</span> : null}
              {s.status === 'failed' && s.error ? <span className="text-destructive"> · {s.error}</span> : null}
              {s.status === 'skipped' ? <span className="text-muted-foreground"> · not run</span> : null}
              {s.status === 'pending' ? <span className="text-muted-foreground"> · {s.summary ?? 'not yet run'}</span> : null}
            </span>
          </li>
        ))}
      </ol>

      {run.checks.length > 0 && (
        <div className="space-y-0.5">
          <p className="font-medium text-muted-foreground">
            Checks {run.checksFailed ? <span className="text-destructive">({run.checksFailed} failed)</span> : <span className="text-success">(all passed)</span>}
          </p>
          <table className="w-full">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-medium py-0.5">Check</th>
                <th className="text-right font-medium py-0.5">Expected</th>
                <th className="text-right font-medium py-0.5">Actual</th>
                <th className="w-5" />
              </tr>
            </thead>
            <tbody>
              {run.checks.map((c, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="py-0.5 pr-2">{c.label}{c.error ? <span className="block text-destructive">{c.error}</span> : null}</td>
                  <td className="py-0.5 text-right tabular-nums">{fmt(c.expected)}</td>
                  <td className="py-0.5 text-right tabular-nums">{fmt(c.actual)}</td>
                  <td className="py-0.5 pl-1"><StatusIcon status={c.passed ? 'applied' : 'failed'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notUndoable.length > 0 && !undo && (
        <p className="text-muted-foreground">
          Not undoable from here: {notUndoable.map(s => `step ${s.step} (${s.tool})`).join(', ')}.
        </p>
      )}

      {undo && (
        <div className="space-y-0.5">
          <p className={undo.status === 'done' ? 'text-success' : 'text-warning'}>
            {undo.status === 'done' ? 'Undone.' : undo.status === 'running' ? 'Undo in progress.' : 'Partly undone.'}
          </p>
          {(undo.outcomes ?? []).filter(o => o.status === 'refused' || o.status === 'failed').map((o, i) => (
            <p key={i} className="text-muted-foreground">Step {o.step}: {o.message ?? o.status}</p>
          ))}
        </div>
      )}

      {unfinished && run.paused && !undo && (
        <Button size="sm" onClick={continueRun} disabled={busy} className="mr-2">
          <Play className="h-3.5 w-3.5 mr-1" />{busy ? 'Continuing…' : `Continue from step ${run.resumeAt}`}
        </Button>
      )}
      {canUndo && (
        <Button size="sm" variant="outline" onClick={undoRun} disabled={busy}>
          <Undo2 className="h-3.5 w-3.5 mr-1" />{busy ? 'Undoing…' : undo?.status === 'partial' ? 'Retry undo' : 'Undo'}
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

function StatusIcon({ status }: { status: 'applied' | 'failed' | 'skipped' | 'pending' }) {
  if (status === 'applied') return <Check className="h-3.5 w-3.5 text-success" aria-label="applied" />
  if (status === 'pending') return <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-label="not yet run" />
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-destructive" aria-label="failed" />
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-label="not run" />
}

function fmt(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return String(v)
}

interface DecidedRun {
  id: string
  status: string
  preview: { summary: string; details: Record<string, unknown> }
  appliedResult: unknown
  error: string | null
  approvedAt: string | null
  updatedAt: string
}

/** The latest runs that were applied or stopped partway, with their results and Undo. */
export function RecentRuns() {
  const [runs, setRuns] = useState<DecidedRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/pending-actions?view=runs')
      .then(async res => {
        const data = await res.json().catch(() => null)
        if (!res.ok || !Array.isArray(data?.runs)) throw new Error(data?.error ?? 'Runs could not be loaded.')
        if (!cancelled) setRuns(data.runs)
      })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!runs || runs.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Recent runs</p>
      {runs.map(r => (
        <div key={r.id} className="border rounded-card p-3 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium">{r.preview.summary}</p>
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
              {new Date(r.approvedAt ?? r.updatedAt).toLocaleDateString()}
            </span>
          </div>
          {typeof r.preview.details.rationale === 'string' && (
            <p className="text-xs text-muted-foreground">{r.preview.details.rationale}</p>
          )}
          {isRunResult(r.appliedResult) ? (
            <RunResultView
              id={r.id}
              result={r.appliedResult}
              onChange={next => setRuns(list => (list ?? []).map(x => (x.id === r.id ? { ...x, appliedResult: next } : x)))}
            />
          ) : (
            r.error && <p className="text-sm text-destructive">{r.error}</p>
          )}
        </div>
      ))}
    </div>
  )
}
