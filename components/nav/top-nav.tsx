'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowDownCircle, ChevronDown, ChevronRight, LayoutGrid, Lock } from 'lucide-react'
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

/** Listed last in the Menu, below a rule. */
const UTILITY_HREFS = new Set(['/settings', '/support'])

const under = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/')

/** Which section the page is in: its own path, or one of its (visible) children's. */
function sectionMatches(item: NavItem, children: NavChild[], pathname: string): boolean {
  return under(pathname, item.href) || children.some(c => under(pathname, c.href))
}

/**
 * The "Top menu" layout's navigation (lib/nav/layout.ts): one "Menu" button in the header, beside
 * Jump to, that opens a panel centred on the page. Every section the user can see is listed down
 * the left (Settings and Support last, below a rule); pointing at one shows its pages on the
 * right, starting from the section the page is in. Clicking a section opens it. Same entries and rules as the sidebar (useNavModel). Desktop only: phones
 * keep the tab bar.
 */
export function TopMenu({ reviewBadge, approvalsBadge, settingsBadge, notesBadge, isAdmin, updateAvailable, featureVisibility, fofActive }: TopMenuProps) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const sections = useNavModel({ isAdmin, reviewBadge, approvalsBadge, fofActive })
  const badges = { review: reviewBadge, approvals: approvalsBadge, settings: settingsBadge, notes: notesBadge }
  const active = sections.find(s => sectionMatches(s.item, s.children, pathname))
  // Settings and Support sit at the foot of the list, below a rule.
  const main = sections.filter(s => !UTILITY_HREFS.has(s.item.href))
  const utility = sections.filter(s => UTILITY_HREFS.has(s.item.href))
  // Anything waiting (Review, Approvals, Settings) shows on the closed button too.
  const waiting = sections.some(s => navRowDecor(s.item, badges, featureVisibility).badgeCount > 0)
  const close = () => setOpen(false)
  // The section whose pages the right-hand pane shows: whichever the pointer or focus is on,
  // starting from the section the page is in.
  const [preview, setPreview] = useState<string | null>(null)
  const shown = sections.find(s => s.item.href === preview) ?? active ?? sections.find(s => s.children.length > 0) ?? null
  const toggle = () => {
    setPreview(null)
    setOpen(o => !o)
  }
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

  // A section row in the left-hand list. Pointing at it (or tabbing to it) shows its pages on
  // the right; clicking it opens the section itself.
  const sectionRow = (item: NavItem, hasChildren: boolean) => {
    const Icon = item.icon
    const { badgeCount, showLock } = navRowDecor(item, badges, featureVisibility)
    const isShown = shown?.item.href === item.href
    const inSection = active?.item.href === item.href
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={close}
        onMouseEnter={() => setPreview(item.href)}
        onFocus={() => setPreview(item.href)}
        aria-current={pathname === item.href ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${isShown ? 'bg-accent text-foreground' : inSection ? 'text-foreground hover:bg-accent' : 'text-foreground/80 hover:text-foreground hover:bg-accent'}`}
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
        {hasChildren && <ChevronRight className={`ml-auto h-3.5 w-3.5 shrink-0 ${isShown ? 'text-foreground' : 'text-muted-foreground/60'}`} />}
      </Link>
    )
  }

  const childLinks = (children: NavChild[]) => children.length > 0 && (
    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
      {children.map(child => {
        const isActive = child.exact ? pathname === child.href : under(pathname, child.href)
        const { showLock } = navRowDecor({ adminOnly: child.adminOnly, featureKey: child.featureKey }, badges, featureVisibility)
        return (
          <Link
            key={child.href}
            href={child.href}
            onClick={close}
            aria-current={isActive ? 'page' : undefined}
            className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors ${isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
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
        onClick={toggle}
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
          className="absolute left-1/2 top-full z-50 -translate-x-1/2 w-[min(48rem,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
        >
        <nav aria-label="Menu" className="flex min-h-[22rem]">
          <div className="w-56 shrink-0 space-y-0.5 border-r pr-2">
            {main.map(({ item, children }) => sectionRow(item, children.length > 0))}
            {(utility.length > 0 || (isAdmin && updateAvailable)) && <div className="my-1.5 border-t" />}
            {utility.map(({ item, children }) => sectionRow(item, children.length > 0))}
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
          <div className="flex-1 min-w-0 pl-4 pr-2 py-1">
            {shown && (
              <>
                <Link
                  href={shown.item.href}
                  onClick={close}
                  className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors mb-2 px-2.5"
                >
                  {shown.item.label}
                </Link>
                {shown.children.length > 0
                  ? childLinks(shown.children)
                  : (
                    <Link
                      href={shown.item.href}
                      onClick={close}
                      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      Open {shown.item.label}
                    </Link>
                  )}
              </>
            )}
          </div>
        </nav>
        </div>
      )}
    </>
  )
}
