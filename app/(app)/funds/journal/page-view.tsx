'use client'

import { Suspense, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { JournalView } from './view'
import { TextLedgerView } from '../text/view'
import { RecurringEntriesView } from './recurring'

type Tab = 'entries' | 'text' | 'recurring'

/**
 * The journal page: the entries, and the plain-text editor that writes them, as two tabs of one
 * page.
 *
 * Plain text used to be a page of its own. It is not a different thing — it is the same journal
 * entries typed a different way, and the list is where you go the moment you have posted them —
 * so a separate page meant two places to look and a round trip between them. Here the editor is a
 * tab; "Post" lands you back on the list with the entries in it.
 *
 * A third tab lists the recurring entries (?tab=recurring): the same journal's entries that repeat
 * on a schedule, so they live here rather than on a page of their own.
 *
 * The tab is in the URL (`?tab=text`, `?tab=recurring`) so the docs, the reminder digest and the old
 * /text links can open it directly. That needs `useSearchParams`, hence the Suspense boundary around the inner component.
 */
export function JournalPageView() {
  return (
    <Suspense fallback={null}>
      <JournalTabs />
    </Suspense>
  )
}

function JournalTabs() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const asked = params.get('tab')
  const [tab, setTab] = useState<Tab>(asked === 'text' || asked === 'recurring' ? asked : 'entries')

  // Keep the URL in step with the tab, without a history entry per click.
  useEffect(() => {
    const qs = new URLSearchParams(params.toString())
    if (tab !== 'entries') qs.set('tab', tab); else qs.delete('tab')
    const next = qs.toString() ? `${pathname}?${qs}` : pathname
    if (typeof window !== 'undefined' && window.location.pathname + window.location.search !== next) {
      router.replace(next, { scroll: false })
    }
  }, [tab, pathname, params, router])

  const tabCls = (t: Tab, edge: 'l' | 'm' | 'r') =>
    `h-9 px-3 ${edge === 'l' ? 'rounded-l-md' : edge === 'r' ? 'rounded-r-md border-l border-input' : 'border-l border-input'} ${tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-input text-sm" role="tablist" aria-label="Entries, plain text or recurring entries">
        <button role="tab" aria-selected={tab === 'entries'} onClick={() => setTab('entries')} className={tabCls('entries', 'l')}>
          Entries
        </button>
        <button role="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')} className={tabCls('text', 'm')}>
          Plain text
        </button>
        <button role="tab" aria-selected={tab === 'recurring'} onClick={() => setTab('recurring')} className={tabCls('recurring', 'r')}>
          Recurring
        </button>
      </div>

      {tab === 'entries' && <JournalView onPlainText={() => setTab('text')} />}
      {tab === 'text' && <TextLedgerView onPosted={() => setTab('entries')} />}
      {tab === 'recurring' && <RecurringEntriesView />}
    </div>
  )
}
