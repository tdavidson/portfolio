'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'

/**
 * Shown in the GP app header only for dual users (a GP who is also an active
 * LP), giving them a way into their LP portal. LP-only users never see the GP
 * app — middleware routes them straight to /portal.
 */
export function LpPortalSwitchLink({ variant = 'header', collapsed }: {
  /** `sidebar`: a nav row at the foot of the fixed sidebar (lib/nav/layout.ts). */
  variant?: 'header' | 'sidebar'
  collapsed?: boolean
} = {}) {
  const [isLp, setIsLp] = useState(false)

  useEffect(() => {
    fetch('/api/portal/me')
      .then(r => (r.ok ? r.json() : { isLp: false }))
      .then(b => setIsLp(!!b.isLp))
      .catch(() => {})
  }, [])

  if (!isLp) return null
  if (variant === 'sidebar') {
    return (
      <Link
        href="/portal/snapshots"
        title={collapsed ? 'LP Portal' : 'Switch to your LP portal'}
        className={`flex w-full items-center gap-3 px-3 py-2 rounded-md text-xs transition-colors text-muted-foreground hover:text-foreground hover:bg-accent ${collapsed ? 'justify-center px-0' : ''}`}
      >
        <ExternalLink className="h-5 w-5 shrink-0" />
        {!collapsed && <span className="flex-1 text-left">LP Portal</span>}
      </Link>
    )
  }
  return (
    <Link
      href="/portal/snapshots"
      className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 whitespace-nowrap"
      title="Switch to your LP portal"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">LP Portal</span>
    </Link>
  )
}
