'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Circle, Lock, MinusCircle, Download, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GETTING_STARTED_CHANGED } from '@/components/getting-started-banner'
import type { SetupProgress, SetupStep, StepKey } from '@/lib/onboarding/progress'

const TEMPLATES = [
  { href: '/templates/lp-import.csv', label: 'LP import', hint: 'Partners and their commitments, for the LP Import box.' },
  { href: '/templates/investments-import.csv', label: 'Investments import', hint: 'Rounds, dates and amounts, for Paste Investment Data.' },
  { href: '/templates/capital-call-register.csv', label: 'Capital call register', hint: 'Calls per partner, for opening the books on a new fund.' },
]

export function GettingStartedView({
  progress,
  vehicles,
  isAdmin,
}: {
  progress: SetupProgress
  vehicles: { id: string; name: string; kind: string | null }[]
  isAdmin: boolean
}) {
  // Skips are fund-wide and saved on the server (an admin's call, like the rest of setup), so
  // every admin sees the same checklist and the sidebar can hide the page once it is finished.
  const router = useRouter()
  const [pendingKey, setPendingKey] = useState<StepKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  async function toggleSkip(step: SetupStep) {
    setPendingKey(step.key)
    setError(null)
    try {
      const res = await fetch('/api/onboarding/progress', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(step.skipped ? { unskip: [step.key] } : { skip: [step.key] }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? 'Could not save that skip.')
        return
      }
      window.dispatchEvent(new Event(GETTING_STARTED_CHANGED))
      startTransition(() => router.refresh())
    } catch {
      setError('Could not save that skip.')
    } finally {
      setPendingKey(null)
    }
  }

  const counts = progress
  const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 100
  const current = progress.vehicle

  return (
    <div className="w-full px-4 pb-12 pt-4 md:pl-8 md:pr-4 md:pt-8">
      <div className="max-w-readable space-y-6">
        <header className="space-y-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Get your fund set up</h1>
            <p className="text-sm text-muted-foreground">
              Each step checks your data, so it ticks itself off when the work is done.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm">
              <span className="font-medium tabular-nums">{counts.done}</span> of{' '}
              <span className="tabular-nums">{counts.total}</span> done
              {counts.skipped > 0 && (
                <span className="text-muted-foreground">
                  {' '}· <span className="tabular-nums">{counts.skipped}</span> skipped
                </span>
              )}
            </p>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={counts.total}
              aria-valuenow={counts.done}
              aria-label="Setup progress"
            >
              <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out-soft" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </header>

        {vehicles.length > 1 && current && (
          <nav aria-label="Entity" className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Entity steps are for:</p>
            <div className="flex flex-wrap gap-1.5">
              {vehicles.map(v => {
                const active = v.id === current.id
                return (
                  <Link
                    key={v.id}
                    href={`/getting-started?entity=${encodeURIComponent(v.id)}`}
                    aria-current={active ? 'page' : undefined}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'
                    }`}
                  >
                    {v.name}
                  </Link>
                )
              })}
            </div>
          </nav>
        )}

        {counts.complete && (
          <div className="rounded-card border border-success/30 bg-success-subtle p-4 text-sm text-success">
            {isAdmin
              ? 'Everything here is done or skipped, so Getting started has left the sidebar. You can come back to it any time from Settings.'
              : 'Everything here is done or skipped.'}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-card border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {progress.sections.map(section => (
          <section key={section.key} className="space-y-2" aria-labelledby={`gs-${section.key}`}>
            <h2 id={`gs-${section.key}`} className="text-base font-medium">{section.title}</h2>
            <ol className="divide-y rounded-card border bg-card shadow-sm dark:border dark:shadow-none">
              {section.steps.map(step => (
                <StepRow
                  key={step.key}
                  step={step}
                  canSkip={isAdmin}
                  busy={pendingKey === step.key}
                  onToggleSkip={() => toggleSkip(step)}
                />
              ))}
            </ol>
          </section>
        ))}

        {progress.sections.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing to set up from your account. {isAdmin ? '' : 'An admin of your fund handles setup.'}
          </p>
        )}

        <section className="space-y-2" aria-labelledby="gs-templates">
          <h2 id="gs-templates" className="text-base font-medium">Downloadable templates</h2>
          <div className="rounded-card border bg-card p-4 shadow-sm dark:shadow-none">
            <p className="mb-3 text-xs text-muted-foreground">
              Fill one in, then paste it into the matching import. Column names are what the importers expect.
            </p>
            <ul className="space-y-2">
              {TEMPLATES.map(t => (
                <li key={t.href} className="flex items-start gap-2">
                  <Download className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <a href={t.href} download className="text-sm font-medium text-foreground hover:underline">
                      {t.label}
                    </a>
                    <p className="text-xs text-muted-foreground">{t.hint}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  )
}

function StatusIcon({ status, skipped }: { status: SetupStep['status']; skipped: boolean }) {
  if (status === 'done') return <CheckCircle2 className="h-5 w-5 text-success" aria-label="Done" />
  if (status === 'not_applicable' || skipped) return <MinusCircle className="h-5 w-5 text-muted-foreground" aria-label={skipped ? 'Skipped' : 'Not applicable'} />
  if (status === 'blocked') return <Lock className="h-5 w-5 text-muted-foreground" aria-label="Waiting on an earlier step" />
  return <Circle className="h-5 w-5 text-muted-foreground" aria-label="To do" />
}

function StepRow({ step, canSkip, busy, onToggleSkip }: { step: SetupStep; canSkip: boolean; busy: boolean; onToggleSkip: () => void }) {
  const skipped = !!step.skipped
  const done = step.status === 'done'
  const na = step.status === 'not_applicable'
  const blocked = step.status === 'blocked'
  const muted = done || na || skipped

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="shrink-0 pt-0.5">
          <StatusIcon status={step.status} skipped={skipped} />
        </div>
        <div className="min-w-0 space-y-1">
          <p className={`text-sm font-medium ${muted ? 'text-muted-foreground' : ''}`}>
            {step.title}
            {skipped && <span className="ml-2 text-xs font-normal">Skipped</span>}
            {na && <span className="ml-2 text-xs font-normal">Not needed for this entity</span>}
          </p>
          <p className="text-sm text-muted-foreground">{step.why}</p>
          {step.detail && <p className="text-xs tabular-nums text-muted-foreground">{step.detail}</p>}
          {blocked && step.blockedBy && (
            <p className="text-xs text-muted-foreground">
              <Lock className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />
              Needs: {step.blockedBy}
            </p>
          )}
          {step.options && !done && !na && !blocked && !skipped && (
            <ul className="mt-2 grid gap-2 sm:grid-cols-3">
              {step.options.map(o => (
                <li key={o.href}>
                  <Link href={o.href} className="block h-full rounded-lg border p-2.5 transition-colors hover:bg-accent">
                    <span className="flex items-center gap-1 text-sm font-medium">
                      {o.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {!na && (
        <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
          {step.options && !done && !blocked ? null : blocked ? (
            <Button size="sm" variant="outline" disabled title={step.blockedBy ? `Needs ${step.blockedBy}` : undefined}>
              <Lock /> {step.cta}
            </Button>
          ) : (
            <Button asChild size="sm" variant={done || skipped ? 'outline' : 'default'}>
              <Link href={step.href}>{done ? 'Review' : step.cta}</Link>
            </Button>
          )}
          {!done && canSkip && (
            <Button size="sm" variant="outline" onClick={onToggleSkip} disabled={busy} className="text-muted-foreground">
              {skipped ? 'Undo skip' : 'Skip'}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
