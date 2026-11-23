'use client'

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { DEFAULT_NAV_LAYOUT, type NavLayout } from '@/lib/nav/layout'

interface SidebarContextValue {
  collapsed: boolean
  toggle: () => void
  /** Where the desktop nav sits (lib/nav/layout.ts). Per user, saved on their membership. */
  layout: NavLayout
  /** Switches the layout at once and saves it; reverts if the save is refused. */
  setLayout: (next: NavLayout) => Promise<boolean>
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

const STORAGE_KEY = 'sidebar-collapsed'

export function SidebarProvider({ children, initialLayout = DEFAULT_NAV_LAYOUT, persistLayout = true }: {
  children: ReactNode
  initialLayout?: NavLayout
  /** False where there is no session to save to (the public demo): the switch is local only. */
  persistLayout?: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [layout, setLayoutState] = useState<NavLayout>(initialLayout)

  // Hydrate from localStorage after mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'true') setCollapsed(true)
    } catch {
      // SSR or storage unavailable
    }
  }, [])

  // A server render with a different saved layout (another tab changed it) wins. Adjusted
  // during render rather than in an effect, so there is no frame drawn in the old layout.
  const [seenInitial, setSeenInitial] = useState(initialLayout)
  if (seenInitial !== initialLayout) {
    setSeenInitial(initialLayout)
    setLayoutState(initialLayout)
  }

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY, String(next)) } catch {}
      return next
    })
  }, [])

  const setLayout = useCallback(async (next: NavLayout) => {
    const prev = layout
    setLayoutState(next)
    if (!persistLayout) return true
    try {
      const res = await fetch('/api/settings/nav-layout', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: next }),
      })
      if (res.ok) return true
    } catch {}
    setLayoutState(prev)
    return false
  }, [layout, persistLayout])

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, layout, setLayout }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}
