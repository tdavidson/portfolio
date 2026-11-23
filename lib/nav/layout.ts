/**
 * How the app's navigation is laid out, chosen per user in Settings → Layout and stored on their
 * membership row (`fund_members.nav_layout`). It changes where the nav sits, never what it offers:
 * every layout lists the same entries, filtered by the same `canSee` / `navSectionsFor` rules.
 *
 *   - `sidebar` — the original: a column beside the page under the header, collapsible to icons.
 *   - `fixed`   — a full-height column pinned to the left edge of the window, with the fund at the
 *                 top and the account at the bottom; it stays put while the page scrolls.
 *   - `top`     — a bar of sections across the top, with the open section's pages in a row below.
 *
 * Phones keep the bottom tab bar in every layout; this only moves the desktop nav.
 */
export const NAV_LAYOUTS = ['sidebar', 'fixed', 'top'] as const
export type NavLayout = typeof NAV_LAYOUTS[number]

export const DEFAULT_NAV_LAYOUT: NavLayout = 'sidebar'

export const NAV_LAYOUT_OPTIONS: { value: NavLayout; label: string; description: string }[] = [
  { value: 'sidebar', label: 'Sidebar', description: 'Navigation beside the page, under the header. Collapses to icons.' },
  { value: 'fixed', label: 'Fixed sidebar', description: 'A full-height sidebar pinned to the left edge that stays put as you scroll.' },
  { value: 'top', label: 'Top bar', description: 'Sections across the top, with the open section’s pages in a row below.' },
]

export function isNavLayout(value: unknown): value is NavLayout {
  return typeof value === 'string' && (NAV_LAYOUTS as readonly string[]).includes(value)
}

/** Anything unrecognised (a missing column, an old value) reads as the default. */
export function parseNavLayout(value: unknown): NavLayout {
  return isNavLayout(value) ? value : DEFAULT_NAV_LAYOUT
}
