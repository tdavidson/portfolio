'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { Section } from '@/components/settings/section'
import { useSidebar } from '@/components/sidebar-context'
import { NAV_LAYOUT_OPTIONS, type NavLayout } from '@/lib/nav/layout'

/**
 * Where the app's navigation sits for this user (lib/nav/layout.ts). Applies at once and is saved
 * on the member's own row, so it follows them to any browser. Every layout lists the same pages;
 * phones keep the bottom tab bar whichever is chosen.
 */
export function LayoutSection() {
  const { layout, setLayout } = useSidebar()
  const [state, setState] = useState<'idle' | 'saved' | 'failed'>('idle')

  const choose = async (next: NavLayout) => {
    if (next === layout) return
    const ok = await setLayout(next)
    setState(ok ? 'saved' : 'failed')
    if (ok) setTimeout(() => setState('idle'), 2000)
  }

  return (
    <Section title="Layout">
      <p className="text-xs text-muted-foreground mb-3">
        Choose where navigation sits on a computer. Only you see this. On a phone, the tab bar stays at the bottom.
      </p>
      <div role="radiogroup" aria-label="Navigation layout" className="grid gap-3 sm:grid-cols-3">
        {NAV_LAYOUT_OPTIONS.map(opt => {
          const selected = layout === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => choose(opt.value)}
              className={`flex flex-col text-left rounded-card border p-3 transition-colors ${selected ? 'border-foreground/40 bg-accent/50' : 'hover:bg-accent/30'}`}
            >
              <LayoutPreview layout={opt.value} />
              <div className="mt-2 flex items-center gap-1.5 text-sm font-medium">
                {opt.label}
                {selected && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
            </button>
          )
        })}
      </div>
      {state === 'saved' && <p className="text-xs text-muted-foreground mt-2">Saved.</p>}
      {state === 'failed' && <p className="text-sm text-destructive mt-2">Couldn&apos;t save your layout. Try again.</p>}
    </Section>
  )
}

/** A small wireframe of each layout, drawn with the theme's own tokens so it reads in dark mode. */
function LayoutPreview({ layout }: { layout: NavLayout }) {
  const bar = 'rounded-sm bg-muted-foreground/25'
  return (
    <div aria-hidden className="h-16 rounded-md border bg-background overflow-hidden flex flex-col">
      {layout === 'sidebar' && (
        <>
          <div className="h-3 flex items-center gap-1 px-1.5"><div className={`h-1.5 w-1.5 ${bar}`} /><div className={`h-1 w-6 ${bar}`} /></div>
          <div className="flex flex-1 gap-1.5 p-1.5 pt-1">
            <div className="w-5 space-y-1">{[0, 1, 2, 3].map(i => <div key={i} className={`h-1 ${bar}`} />)}</div>
            <div className="flex-1 rounded-sm bg-muted" />
          </div>
        </>
      )}
      {layout === 'fixed' && (
        <div className="flex flex-1">
          <div className="w-7 border-r bg-muted/60 p-1 space-y-1">
            <div className={`h-1.5 w-1.5 ${bar}`} />
            {[0, 1, 2, 3].map(i => <div key={i} className={`h-1 ${bar}`} />)}
          </div>
          <div className="flex-1 p-1.5"><div className="h-full rounded-sm bg-muted" /></div>
        </div>
      )}
      {layout === 'top' && (
        <>
          <div className="h-3 flex items-center gap-1 px-1.5"><div className={`h-1.5 w-1.5 ${bar}`} /><div className={`h-1 w-6 ${bar}`} /></div>
          <div className="h-2.5 border-b flex items-center gap-1 px-1.5">{[0, 1, 2, 3, 4].map(i => <div key={i} className={`h-1 w-3 ${bar}`} />)}</div>
          <div className="flex-1 p-1.5"><div className="h-full rounded-sm bg-muted" /></div>
        </>
      )}
    </div>
  )
}
