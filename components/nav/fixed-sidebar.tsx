'use client'

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { AppSidebar, useThemeCycle } from '@/components/app-sidebar'
import { AccountControls, FundMark } from '@/components/app-header'
import { useSidebar } from '@/components/sidebar-context'
import type { FeatureVisibilityMap } from '@/lib/types/features'

interface FixedSidebarProps {
  fundName: string
  fundLogo: string | null
  userEmail: string
  reviewBadge: number
  approvalsBadge?: number
  settingsBadge?: number
  notesBadge?: number
  isAdmin?: boolean
  updateAvailable?: boolean
  featureVisibility?: FeatureVisibilityMap
  fofActive?: boolean
}

/**
 * The "Fixed sidebar" layout (lib/nav/layout.ts): a full-height column pinned to the left edge
 * of the window, the way a chat app's history rail is. The fund sits at the top with the
 * collapse control, the nav scrolls on its own between them, and the theme switch and the
 * account sit at the foot, so the page beside it can scroll without the nav moving.
 *
 * The rows themselves are AppSidebar's, so the entries and every visibility rule are the same
 * as the original sidebar's. Desktop only: phones keep the tab bar.
 */
export function FixedSidebar({ fundName, fundLogo, userEmail, ...nav }: FixedSidebarProps) {
  const { collapsed, toggle } = useSidebar()
  const theme = useThemeCycle()
  const ThemeIcon = theme.icon

  return (
    <aside
      className={`hidden md:flex sticky top-0 self-start h-dvh shrink-0 flex-col border-r bg-muted/40 transition-[width] duration-200 ${collapsed ? 'w-16' : 'w-64'}`}
    >
      <div className={`flex items-center gap-2 h-[60px] shrink-0 ${collapsed ? 'justify-center px-1' : 'pl-4 pr-2'}`}>
        {!collapsed && (
          <>
            <FundMark fundLogo={fundLogo} />
            <span className="flex-1 min-w-0 font-medium text-sm text-muted-foreground tracking-tight truncate">{fundName}</span>
          </>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <AppSidebar {...nav} hideUtilities />
      </div>

      <div className={`shrink-0 border-t p-2 space-y-1 ${collapsed ? 'px-1' : ''}`}>
        <button
          type="button"
          onClick={theme.cycle}
          title={collapsed ? `Theme: ${theme.label}` : undefined}
          className={`flex w-full items-center gap-3 px-3 py-2 rounded-md text-xs transition-colors text-muted-foreground hover:text-foreground hover:bg-accent ${collapsed ? 'justify-center px-0' : ''}`}
        >
          <ThemeIcon className="h-5 w-5 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">{theme.label}</span>}
        </button>
        <div className={`flex items-center gap-2 px-1 ${collapsed ? 'flex-col' : ''}`}>
          {!collapsed && (
            <span className="flex-1 min-w-0 truncate px-2 text-xs text-muted-foreground" title={userEmail}>{userEmail}</span>
          )}
          <AccountControls fundName={fundName} userEmail={userEmail} compact />
        </div>
      </div>
    </aside>
  )
}
