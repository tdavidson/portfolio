'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowDownCircle, ChevronDown, LayoutGrid, Lock } from 'lucide-react'
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

/** The far-right column of the Menu. */
const UTILITY_HREFS = new Set(['/settings', '/support'])

const under = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/')

/** Which section the page is in: its own path, or one of its (visible) children's. */
function sectionMatches(item: NavItem, children: NavChild[], pathname: string): boolean {
  return under(pathname, item.href) || children.some(c => under(pathname, c.href))
}

/**
 * The "Top menu" layout's navigation (lib/nav/layout.ts): one "Menu" button in the header, beside
 * Jump to, that opens a large panel, centred on the page, of every section the user can see. Each
 * section is a block headed by its name, with its pages (if any) listed under it; Settings and
 * Support sit in their own column at the far right. Same entries and rules as the sidebar (useNavModel). Desktop only: phones
 * keep the tab bar.
 */
export function TopMenu({ reviewBadge, approvalsBadge, settingsBadge, notesBadge, isAdmin, updateAvailable, featureVisibility, fofActive }: TopMenuProps) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const sections = useNavModel({ isAdmin, reviewBadge, approvalsBadge, fofActive })
  const badges = { review: reviewBadge, approvals: approvalsBadge, settings: settingsBadge, notes: notesBadge }
  const active = sections.find(s => sectionMatches(s.item, s.children, pathname))
  // Settings and Support get a column of their own at the far right; every other section is a
  // block headed the same way whether or not it has pages under it.
  const main = sections.filter(s => !UTILITY_HREFS.has(s.item.href))
  const utility = sections.filter(s => UTILITY_HREFS.has(s.item.href))
  // Anything waiting (Review, Approvals, Settings) shows on the closed button too.
  const waiting = sections.some(s => navRowDecor(s.item, badges, featureVisibility).badgeCount > 0)
  const close = () => setOpen(false)
  const panelId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Closes on Escape (focus back to the button) and on a press outside the panel and the button.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus() }
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  // Every section is a heading row, with or without pages under it.
  const sectionLink = (item: NavItem) => {
    const Icon = item.icon
    const { badgeCount, showLock } = navRowDecor(item, badges, featureVisibility)
    const isActive = pathname === item.href
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={close}
        aria-current={isActive ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${isActive || active?.item.href === item.href ? 'bg-accent text-foreground font-medium' : 'text-foreground font-medium hover:bg-accent'}`}
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

  const childLinks = (children: NavChild[]) => children.length > 0 && (
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
  )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(o => !o)}
        data-state={open ? 'open' : 'closed'}
        className="relative hidden md:inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        <span>Menu</span>
        <ChevronDown className="h-3.5 w-3.5" />
        {waiting && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-warning" />}
      </button>
      {/* The panel hangs from the whole header rather than from the button, so it opens centred on
          the page: the header is its nearest positioned ancestor (AppHeader's `relative`). */}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="absolute left-1/2 top-full z-50 -translate-x-1/2 w-[min(64rem,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
        >
        <nav aria-label="Menu" className="flex gap-4">
          {/* Blocks flow into balanced columns, so one long section (Financials) doesn't leave a
              hole beside it. */}
          <div className="flex-1 min-w-0 columns-2 lg:columns-3 gap-x-4">
            {main.map(({ item, children }) => (
              <div key={item.href} className="space-y-0.5 break-inside-avoid mb-4">
                {sectionLink(item)}
                {childLinks(children)}
              </div>
            ))}
          </div>
          {(utility.length > 0 || (isAdmin && updateAvailable)) && (
            <div className="w-44 shrink-0 border-l pl-4 space-y-4">
              {utility.map(({ item, children }) => (
                <div key={item.href} className="space-y-0.5">
                  {sectionLink(item)}
                  {childLinks(children)}
                </div>
              ))}
              {isAdmin && updateAvailable && (
                <Link
                  href="/updates"
                  onClick={close}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${under(pathname, '/updates') ? 'bg-accent text-foreground' : 'text-warning hover:text-foreground hover:bg-accent'}`}
                >
                  <ArrowDownCircle className="h-4 w-4 shrink-0" />
                  <span>Updates</span>
                </Link>
              )}
            </div>
          )}
        </nav>
        </div>
      )}
    </>
  )
}
