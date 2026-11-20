'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { ArrowDownCircle, Lock, Monitor, Moon, Sun } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import {
  moreSectionsFor,
  navItemMatches,
  navSectionsFor,
  useFundSeg,
  visibleChildrenFor,
  type NavItem,
} from '@/components/app-sidebar'
import { useSetupComplete } from '@/components/getting-started-banner'
import { useAccess } from '@/components/access-context'
import type { FeatureVisibilityMap } from '@/lib/types/features'

/**
 * What "More" opens on a phone.
 *
 * It used to open the desktop sidebar in a left-hand drawer, and that was wrong in
 * three separate ways. It came in from the LEFT, from a button in the bottom-RIGHT
 * corner — the panel appears as far from the finger that summoned it as the screen
 * allows. It was a 288px column of ~20 stacked rows plus every expanded child, close
 * to a metre of scrolling on a handset, in a shape chosen for a 224px aside next to a
 * page rather than for a screen with nothing else on it. And it was undifferentiated:
 * the four destinations already in the tab bar were repeated at the top of it, so the
 * first thing the menu showed was the thing you had just chosen not to tap.
 *
 * So this is not the sidebar. It is a bottom sheet — it rises from the edge the button
 * is on — carrying three things, in the order a thumb reaches them:
 *
 *   1. The sections NOT already in the tab bar, as a two-column grid. A grid fits ten
 *      destinations in the height a stacked list gives four, which is the difference
 *      between a menu you read and a menu you scroll.
 *   2. The current section's sub-pages, in the same two-column grid of tiles, shorter
 *      because they carry no icon. This is the part the tab bar cannot do at all: the bar
 *      gets you to Portfolio, and this is how you get from there to Investments or Notes
 *      without a second trip through the menu. They were wrapped chips once, and a fund's
 *      thirteen sections of uneven length wrapped into a ragged five-row cloud with no
 *      column to run a thumb down; a grid reads top to bottom like the group above it.
 *   3. Appearance, at the bottom, because it is the one row nobody is aiming for.
 *
 * The desktop sidebar still exists and is still the desktop nav — it is simply no
 * longer asked to be a phone menu as well. Both are built from the same NAV_ITEMS
 * through the same `canSee` resolver (navSectionsFor / visibleChildrenFor), so the
 * two surfaces cannot drift into offering different pages.
 */

const THEME_CYCLE = ['system', 'light', 'dark'] as const
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon }
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' }

interface MobileMoreSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Hrefs already on the tab bar. Repeating them here would be the first thing the menu showed. */
  tabHrefs: string[]
  reviewBadge: number
  approvalsBadge?: number
  settingsBadge?: number
  notesBadge?: number
  isAdmin?: boolean
  updateAvailable?: boolean
  featureVisibility?: FeatureVisibilityMap
  fofActive?: boolean
}

export function MobileMoreSheet({
  open,
  onOpenChange,
  tabHrefs,
  reviewBadge,
  approvalsBadge,
  settingsBadge,
  notesBadge,
  isAdmin,
  updateAvailable,
  featureVisibility,
  fofActive,
}: MobileMoreSheetProps) {
  const pathname = usePathname()
  const access = useAccess()
  const fundSeg = useFundSeg()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const setupComplete = useSetupComplete(!!isAdmin)
  const sections = navSectionsFor(!!isAdmin, access, { review: reviewBadge, approvals: approvalsBadge, setupComplete })

  const badgeFor = (key: NavItem['badgeKey']) =>
    key === 'review' ? reviewBadge
      : key === 'approvals' ? (approvalsBadge ?? 0)
      : key === 'settings' ? (settingsBadge ?? 0)
      : key === 'notes' ? (notesBadge ?? 0)
      : 0

  const grid = moreSectionsFor(!!isAdmin, access, tabHrefs, { review: reviewBadge, approvals: approvalsBadge })

  // The section you are IN, whether or not it is a tab — its sub-pages are the reason
  // most people open this menu, and the tab bar has no way to reach them.
  const current = sections.find(item => navItemMatches(item, pathname))
  const currentChildren = current
    ? visibleChildrenFor(current, !!isAdmin, access, { fofActive, fundSeg })
    : []

  const currentTheme = (mounted && THEME_CYCLE.includes(theme as (typeof THEME_CYCLE)[number]) ? theme : 'system') as (typeof THEME_CYCLE)[number]
  const ThemeIcon = THEME_ICONS[currentTheme]

  const close = () => onOpenChange(false)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // No description to point at, and Radix warns rather than falling silent.
        aria-describedby={undefined}
        // p-0 over the sheet's default padding: the grabber and the scroll area own
        // their own spacing, and the list has to be able to run to the sheet's edge
        // when it scrolls. pb pays back the home-indicator inset — the last row of a
        // bottom sheet is exactly where that matters.
        className="p-0 pb-[env(safe-area-inset-bottom)]"
      >
        {/* Grabber. Not draggable — it is what tells a thumb this panel belongs to the
            bottom edge, which is the whole point of moving it there. */}
        <SheetTitle className="sr-only">More navigation</SheetTitle>

        <div className="flex justify-center pt-3 pb-1">
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>

        <div className="max-h-[calc(85svh-2rem)] overflow-y-auto overscroll-contain px-4 pb-6">
          {grid.length > 0 && (
            <>
              <h2 className="text-base font-medium pt-1 pb-2">Go to</h2>
              <div className="grid grid-cols-2 gap-2">
                {grid.map(item => {
                  const Icon = item.icon
                  const active = navItemMatches(item, pathname)
                  const count = badgeFor(item.badgeKey)
                  const locked = item.adminOnly || (item.featureKey && featureVisibility?.[item.featureKey] === 'admin')
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={close}
                      aria-current={active ? 'page' : undefined}
                      // min-h-[3.25rem] is the tap target, and it is a MINIMUM: the
                      // label wraps rather than truncating, because half a phone's
                      // width is not enough for the longer section names on one line,
                      // and a truncated one is not a destination anyone recognises.
                      className={`flex min-h-[3.25rem] items-center gap-3 rounded-card border px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'border-transparent bg-accent text-foreground font-medium'
                          : 'border-border text-muted-foreground'
                      }`}
                    >
                      <Icon className="h-5 w-5 shrink-0" />
                      <span className="min-w-0 leading-tight">{item.label}</span>
                      {count > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-warning text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center tabular-nums">
                          {count > 99 ? '99+' : count}
                        </span>
                      )}
                      {locked && count === 0 && <Lock className="ml-auto h-3 w-3 shrink-0 text-warning" />}
                    </Link>
                  )
                })}

                {/* Admin-only, and only when there is something to update. It is not in
                    NAV_ITEMS — the sidebar renders it the same way, separately. */}
                {isAdmin && updateAvailable && (
                  <Link
                    href="/updates"
                    onClick={close}
                    className="flex min-h-[3.25rem] items-center gap-3 rounded-card border border-border px-3 py-2 text-sm text-warning"
                  >
                    <ArrowDownCircle className="h-5 w-5 shrink-0" />
                    <span className="min-w-0 leading-tight">Updates</span>
                    <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-warning" />
                  </Link>
                )}
              </div>
            </>
          )}

          {currentChildren.length > 0 && current && (
            <>
              <h2 className="text-base font-medium pt-5 pb-2">
                In {current.label}
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {currentChildren.map(child => {
                  const childActive = child.exact
                    ? pathname === child.href
                    : pathname === child.href || pathname.startsWith(child.href + '/')
                  const childLocked = child.adminOnly || (child.featureKey && featureVisibility?.[child.featureKey] === 'admin')
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      onClick={close}
                      aria-current={childActive ? 'page' : undefined}
                      // Same tile as "Go to", without the icon: the label wraps rather
                      // than truncating ("Schedule of investments" is two lines at half a
                      // phone's width), and the badge or lock keeps to the right edge.
                      className={`flex min-h-[2.75rem] items-center gap-2 rounded-card border px-3 py-2 text-sm transition-colors ${
                        childActive
                          ? 'border-transparent bg-accent text-foreground font-medium'
                          : 'border-border text-muted-foreground'
                      }`}
                    >
                      <span className="min-w-0 leading-tight">{child.label}</span>
                      {child.badgeKey === 'notes' && (notesBadge ?? 0) > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-warning text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center tabular-nums">
                          {(notesBadge ?? 0) > 99 ? '99+' : notesBadge}
                        </span>
                      )}
                      {childLocked && <Lock className="ml-auto h-3 w-3 shrink-0 text-warning" />}
                    </Link>
                  )
                })}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={() => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(currentTheme) + 1) % THEME_CYCLE.length])}
            aria-label={`Appearance: ${THEME_LABELS[currentTheme]}`}
            className="mt-5 flex min-h-[2.75rem] w-full items-center gap-3 rounded-card border border-border px-3 py-2 text-sm text-muted-foreground"
          >
            <ThemeIcon className="h-5 w-5 shrink-0" />
            <span>Appearance</span>
            <span className="ml-auto text-xs">{THEME_LABELS[currentTheme]}</span>
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
