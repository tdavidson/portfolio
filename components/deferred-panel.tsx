'use client'

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'

/** Mount data-fetching panels only as they approach the viewport. Keep them mounted afterwards
 * so scrolling never discards edits or refetches data. The button also supports keyboard users,
 * and the anchor is present before the panel loads so incoming deep links still work.
 */
export function DeferredPanel({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (active) return
    const element = host.current
    if (!element) return
    const activate = () => setActive(true)
    const followAnchor = () => {
      if (window.location.hash === `#${id}`) activate()
    }
    followAnchor()
    window.addEventListener('hashchange', followAnchor)
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) activate()
    }, { rootMargin: '300px 0px' })
    if (observer) observer.observe(element)
    else activate()
    return () => {
      observer?.disconnect()
      window.removeEventListener('hashchange', followAnchor)
    }
  }, [active, id])

  const placeholder = (
    <div className="min-h-48 rounded-card border bg-card p-4 flex items-center justify-center">
      {active ? <p role="status" className="text-sm text-muted-foreground">Loading {label.toLowerCase()}…</p> : (
        <button type="button" onClick={() => setActive(true)} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          Load {label.toLowerCase()}
        </button>
      )}
    </div>
  )
  return (
    <div ref={host} id={id} className="mt-6 scroll-mt-4" data-deferred-panel={id}>
      {active ? <Suspense fallback={placeholder}>{children}</Suspense> : placeholder}
    </div>
  )
}
