'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowDownCircle, Lock } from 'lucide-react'
import { navRowDecor, useNavModel, type NavChild, type NavItem } from '@/components/app-sidebar'
import type { FeatureVisibilityMap } from '@/lib/types/features'

interface TopNavProps {
  reviewBadge: number
  approvalsBadge?: number
  settingsBadge?: number
  notesBadge?: number
  isAdmin?: boolean
  updateAvailable?: boolean
  featureVisibility?: FeatureVisibilityMap
  fofActive?: boolean
}

const under = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/')

/** Which section the page is in: its own path, or one of its (visible) children's. */
function sectionMatches(item: NavItem, children: NavChild[], pathname: string): boolean {
  return under(pathname, item.href) || children.some(c => under(pathname, c.href))
}

/**
 * The "Top bar" layout (lib/nav/layout.ts): every section the user can see across the top, and
 * the open section's pages in a second row beneath it. Same entries and rules as the sidebar
 * (useNavModel). The section row scrolls sideways when a fund runs more sections than fit.
 * Desktop only: phones keep the tab bar.
 */
export function TopNav({ reviewBadge, approvalsBadge, settingsBadge, notesBadge, isAdmin, updateAvailable, featureVisibility, fofActive }: TopNavProps) {
  const pathname = usePathname()
  const sections = useNavModel({ isAdmin, reviewBadge, approvalsBadge, fofActive })
  const badges = { review: reviewBadge, approvals: approvalsBadge, settings: settingsBadge, notes: notesBadge }
  const active = sections.find(s => sectionMatches(s.item, s.children, pathname))

  // The section's own page leads its row, unless the children already open with one (a fund's
  // "Overview"), so the row is the whole section and the parent is one click from any child.
  const subRow: NavChild[] = active && active.children.length > 0
    ? (active.children[0]?.exact ? active.children : [{ href: active.item.href, label: 'Overview', exact: true }, ...active.children])
    : []

  // A row wider than the window scrolls sideways; the fade at the right edge says there is more.
  const rowClass = 'flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]'

  return (
    <div className="hidden md:block">
      <nav aria-label="Sections" className={`${rowClass} px-2`}>
        {sections.map(({ item }) => {
          const Icon = item.icon
          const isActive = active?.item.href === item.href
          const { badgeCount, showLock } = navRowDecor(item, badges, featureVisibility)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={`relative flex items-center gap-2 px-3 h-10 text-sm whitespace-nowrap border-b-2 transition-colors ${isActive ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
              {badgeCount > 0 && (
                <span className="rounded-full bg-warning text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center tabular-nums">
                  {badgeCount > 99 ? '99+' : badgeCount}
                </span>
              )}
              {item.beta && (
                <span className="text-[9px] font-medium text-info bg-info/10 rounded px-1 py-0.5 leading-none uppercase tracking-wider">beta</span>
              )}
              {showLock && <Lock className="h-3 w-3 text-warning shrink-0" />}
            </Link>
          )
        })}
        {isAdmin && updateAvailable && (
          <Link
            href="/updates"
            className={`flex items-center gap-2 px-3 h-10 text-sm whitespace-nowrap border-b-2 transition-colors ${under(pathname, '/updates') ? 'border-foreground text-foreground font-medium' : 'border-transparent text-warning hover:text-foreground'}`}
          >
            <ArrowDownCircle className="h-4 w-4 shrink-0" />
            <span>Updates</span>
          </Link>
        )}
      </nav>

      {subRow.length > 0 && (
        <nav aria-label={`${active?.item.label} pages`} className={`${rowClass} border-t px-2 py-1.5`}>
          {subRow.map(child => {
            const isActive = child.exact ? pathname === child.href : under(pathname, child.href)
            const { showLock } = navRowDecor({ adminOnly: child.adminOnly, featureKey: child.featureKey }, badges, featureVisibility)
            return (
              <Link
                key={child.href}
                href={child.href}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors ${isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
              >
                <span>{child.label}</span>
                {showLock && <Lock className="h-3 w-3 text-warning shrink-0" />}
                {child.badgeKey === 'notes' && (notesBadge ?? 0) > 0 && (
                  <span className="text-[10px] font-medium rounded-full bg-muted-foreground/15 px-1.5 py-0.5 tabular-nums">{notesBadge}</span>
                )}
              </Link>
            )
          })}
        </nav>
      )}
    </div>
  )
}
