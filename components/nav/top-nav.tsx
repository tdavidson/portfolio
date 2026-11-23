'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowDownCircle, ChevronDown, LayoutGrid, Lock } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { navRowDecor, useNavModel, type NavChild, type NavItem } from '@/components/app-sidebar'
import type { FeatureVisibilityMap } from '@/lib/types/features'

interface TopMenuProps {
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
 * The "Top menu" layout's navigation (lib/nav/layout.ts): one "Menu" button in the header, beside
 * Jump to, that opens a large dropdown of every section the user can see. Sections with pages of
 * their own get a block each, headed by the section and listing its pages; the rest sit together
 * in the first block. Blocks flow into balanced columns, so one long section (Financials) doesn't
 * leave a hole beside it. Same entries and rules as the sidebar (useNavModel). Desktop only: phones
 * keep the tab bar.
 */
export function TopMenu({ reviewBadge, approvalsBadge, settingsBadge, notesBadge, isAdmin, updateAvailable, featureVisibility, fofActive }: TopMenuProps) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const sections = useNavModel({ isAdmin, reviewBadge, approvalsBadge, fofActive })
  const badges = { review: reviewBadge, approvals: approvalsBadge, settings: settingsBadge, notes: notesBadge }
  const active = sections.find(s => sectionMatches(s.item, s.children, pathname))
  const singles = sections.filter(s => s.children.length === 0)
  const groups = sections.filter(s => s.children.length > 0)
  // Anything waiting (Review, Approvals, Settings) shows on the closed button too.
  const waiting = sections.some(s => navRowDecor(s.item, badges, featureVisibility).badgeCount > 0)
  const close = () => setOpen(false)

  const sectionLink = (item: NavItem, heading: boolean) => {
    const Icon = item.icon
    const { badgeCount, showLock } = navRowDecor(item, badges, featureVisibility)
    const isActive = pathname === item.href
    const inSection = active?.item.href === item.href
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={close}
        aria-current={isActive ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${isActive ? 'bg-accent text-foreground font-medium' : heading || inSection ? 'text-foreground font-medium hover:bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.label}</span>
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
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative hidden md:inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          <span>Menu</span>
          <ChevronDown className="h-3.5 w-3.5" />
          {waiting && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-warning" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(60rem,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto p-3"
      >
        <nav aria-label="Menu" className="columns-2 lg:columns-4 gap-x-4">
          {(singles.length > 0 || (isAdmin && updateAvailable)) && (
            <div className="space-y-0.5 break-inside-avoid mb-5">
              {singles.map(s => sectionLink(s.item, false))}
              {isAdmin && updateAvailable && (
                <Link
                  href="/updates"
                  onClick={close}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${under(pathname, '/updates') ? 'bg-accent text-foreground font-medium' : 'text-warning hover:text-foreground hover:bg-accent'}`}
                >
                  <ArrowDownCircle className="h-4 w-4 shrink-0" />
                  <span>Updates</span>
                </Link>
              )}
            </div>
          )}
          {groups.map(({ item, children }) => (
            <div key={item.href} className="space-y-0.5 break-inside-avoid mb-5">
              {sectionLink(item, true)}
              <div className="ml-[18px] border-l pl-2 space-y-0.5">
                {children.map(child => {
                  const isActive = child.exact ? pathname === child.href : under(pathname, child.href)
                  const { showLock } = navRowDecor({ adminOnly: child.adminOnly, featureKey: child.featureKey }, badges, featureVisibility)
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      onClick={close}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex items-center gap-2 rounded-md px-2.5 py-1 text-sm transition-colors ${isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                    >
                      <span className="truncate">{child.label}</span>
                      {showLock && <Lock className="h-3 w-3 text-warning shrink-0" />}
                      {child.badgeKey === 'notes' && (notesBadge ?? 0) > 0 && (
                        <span className="ml-auto text-[10px] font-medium rounded-full bg-muted-foreground/15 px-1.5 py-0.5 tabular-nums">{notesBadge}</span>
                      )}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </PopoverContent>
    </Popover>
  )
}
