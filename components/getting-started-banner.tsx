'use client'

import Link from 'next/link'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowRight, ListChecks, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Skips are fund-wide and stored on the server (fund_settings.onboarding.checklist_skipped), so the
// counts from GET /api/onboarding/progress already leave them out. Only the banner's own "dismiss"
// is per browser — a convenience, so every read and write is wrapped: storage can throw (private
// windows, blocked site data) and the page has to render the same without it.
// ---------------------------------------------------------------------------

const dismissKey = (userId: string) => `getting-started:banner-dismissed:${userId}`

/** Fired after a skip is saved, so the sidebar and banner re-read the progress. */
export const GETTING_STARTED_CHANGED = 'getting-started:changed'

export interface ProgressPayload {
  userId: string
  done: number
  total: number
  complete: boolean
  steps: { key: string; status: 'done' | 'todo' | 'blocked' | 'not_applicable'; skipped?: boolean }[]
}

/** GET /api/onboarding/progress, or null when it fails or the caller is not an admin. */
export async function fetchSetupProgress(): Promise<ProgressPayload | null> {
  try {
    const res = await fetch('/api/onboarding/progress')
    if (!res.ok) return null
    const data = (await res.json()) as ProgressPayload
    return data?.userId && Array.isArray(data.steps) ? data : null
  } catch {
    return null
  }
}

// The sidebar's last answer, per browser, so a fund that finished setting up long ago never sees
// the entry flash in and out on load. Only a hint for the first paint: the fetch decides.
const NAV_HIDDEN_KEY = 'getting-started:nav-hidden'
const NAV_EVENT = 'getting-started:nav-hidden-changed'

function readNavHidden(): boolean {
  try { return window.localStorage.getItem(NAV_HIDDEN_KEY) === '1' } catch { return false }
}

function writeNavHidden(hidden: boolean): void {
  try {
    if (readNavHidden() === hidden) return
    if (hidden) window.localStorage.setItem(NAV_HIDDEN_KEY, '1')
    else window.localStorage.removeItem(NAV_HIDDEN_KEY)
  } catch {
    // Storage unavailable: the entry just shows until the fetch answers.
  }
  window.dispatchEvent(new Event(NAV_EVENT))
}

function subscribeNavHidden(onChange: () => void): () => void {
  window.addEventListener(NAV_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(NAV_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * Is every Getting started step done or skipped? Drives hiding the sidebar entry. Admins only
 * (the entry is admin-only and so is the progress route); re-checked when a skip is saved.
 * The server render says "not complete", so the entry is in the HTML and drops out on the client.
 */
export function useSetupComplete(isAdmin: boolean): boolean {
  const hidden = useSyncExternalStore(subscribeNavHidden, readNavHidden, () => false)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    const check = () => {
      fetchSetupProgress().then(data => {
        if (!cancelled && data) writeNavHidden(data.complete)
      })
    }
    check()
    window.addEventListener(GETTING_STARTED_CHANGED, check)
    return () => {
      cancelled = true
      window.removeEventListener(GETTING_STARTED_CHANGED, check)
    }
  }, [isAdmin])

  return isAdmin && hidden
}

function readDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(userId)) === '1'
  } catch {
    return false
  }
}

function writeDismissed(userId: string): void {
  try {
    window.localStorage.setItem(dismissKey(userId), '1')
  } catch {
    // ignore
  }
}

/**
 * "Finish setting up — N of M done → Continue", at the top of /start and /dashboard.
 *
 * Admins only, and only while the checklist is unfinished. Both host pages are client components,
 * so the count comes from GET /api/onboarding/progress (admin-gated) rather than server props.
 * Renders nothing until it knows there is something to say — no skeleton, no layout shift for
 * the common case of a fund that finished setting up long ago.
 */
export function GettingStartedBanner({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  const [state, setState] = useState<{ userId: string; done: number; total: number } | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetchSetupProgress().then(data => {
      if (cancelled || !data) return
      if (readDismissed(data.userId)) return
      if (data.complete || data.total === 0) return
      setState({ userId: data.userId, done: data.done, total: data.total })
    })
    return () => { cancelled = true }
  }, [isAdmin])

  if (!isAdmin || !state) return null
  const pct = Math.round((state.done / state.total) * 100)

  return (
    <div className={`rounded-card border border-brand-200 bg-brand-50 p-3 dark:border-brand-800 dark:bg-brand-950 ${className ?? ''}`}>
      <div className="flex items-center gap-3">
        <ListChecks className="h-4 w-4 shrink-0 text-brand-700 dark:text-brand-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Finish setting up{' '}
            <span className="font-normal text-muted-foreground">
              — <span className="tabular-nums">{state.done}</span> of <span className="tabular-nums">{state.total}</span> done
            </span>
          </p>
          <div
            className="mt-1.5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-background"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.done}
            aria-label="Setup progress"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link href="/getting-started">
            Continue <ArrowRight />
          </Link>
        </Button>
        <button
          type="button"
          onClick={() => { writeDismissed(state.userId); setState(null) }}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
