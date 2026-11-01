'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Search, CornerDownLeft, Building2, Crown, Lightbulb, BookOpen, FileText } from 'lucide-react'
import { useAccess } from '@/components/access-context'
import { useAppFetch, useAppNavigate, type AppFetch } from '@/components/app-runtime'
import { useIsAdmin } from '@/components/feature-visibility-context'
import { useVehicle } from '@/components/accounting-vehicle'
import {
  pageEntries, matchEntries, groupEntries,
  type PaletteEntry, type PaletteGroup, type PaletteVehicle,
} from '@/lib/nav/palette'
import { cn } from '@/lib/utils'

/**
 * The command palette: ⌘K / Ctrl+K, type, Enter.
 *
 * A layer over the nav rather than a replacement for it. It lists every page the user can reach
 * (the same list the sidebar and the phone's tab bar are built from — lib/nav/palette.ts), each
 * entity's pages by name, and the fund's companies, LPs and deals, so "Journal for which entity"
 * and "the Acme page" are each one line of typing from anywhere in the app.
 *
 * What it is NOT is a boundary. Every entry leads to a page or an API that gates itself; the
 * record lists come from the same routes the pages use, so a member without the grant gets a 403
 * from the fetch and an empty group here, never a row they could not open.
 */

interface PaletteCtx { open: () => void }
const PaletteContext = createContext<PaletteCtx>({ open: () => {} })

/** Open the palette from anywhere inside AppShell — the header's button, a page's empty state. */
export function useCommandPalette() {
  return useContext(PaletteContext)
}

const noSubscribe = () => () => {}
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform) || /Mac/.test(navigator.userAgent)

/** The keyboard shortcut, as this platform writes it. The server can't know, so it says ⌘K. */
export function useShortcutLabel(): string {
  return useSyncExternalStore(noSubscribe, () => (isMac() ? '⌘K' : 'Ctrl K'), () => '⌘K')
}

interface CommandPaletteProviderProps {
  reviewBadge?: number
  approvalsBadge?: number
  fofActive?: boolean
  children: ReactNode
}

export function CommandPaletteProvider({ reviewBadge, approvalsBadge, fofActive, children }: CommandPaletteProviderProps) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])

  // ⌘K on a Mac, Ctrl+K elsewhere. Toggles, so the same chord closes it — the habit every
  // palette in every editor has taught.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setIsOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <PaletteContext.Provider value={{ open }}>
      {children}
      <CommandPaletteDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        reviewBadge={reviewBadge}
        approvalsBadge={approvalsBadge}
        fofActive={fofActive}
      />
    </PaletteContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Record lists — loaded on first open, from the routes the pages themselves use
// ---------------------------------------------------------------------------

interface Records {
  vehicles: PaletteVehicle[]
  companies: PaletteEntry[]
  lps: PaletteEntry[]
  deals: PaletteEntry[]
}
const EMPTY_RECORDS: Records = { vehicles: [], companies: [], lps: [], deals: [] }

async function getJson<T>(appFetch: AppFetch, url: string): Promise<T | null> {
  try {
    const r = await appFetch(url)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

const HOLDING_HINTS: Record<string, string> = { fund: 'fund holding', crypto: 'digital asset' }

function useRecords(open: boolean): Records {
  const access = useAccess()
  const appFetch = useAppFetch()
  const [records, setRecords] = useState<Records>(EMPTY_RECORDS)

  // Fetched on every open, not once per session: the shell outlives navigation, so a list loaded
  // once never showed a company added since, and one failed fetch left a group empty for good.
  // The last lists stay on screen while the new ones load.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    const canRead = (d: Parameters<typeof access>[0], f?: Parameters<typeof access>[1]) => {
      const level = access(d, f)
      return level !== 'none'
    }

    // Each list is fetched only where the nav would show the section it belongs to — not as a
    // gate (the route is the gate) but so a member without LPs doesn't pay for a 403 every open.
    const jobs: Promise<Partial<Records>>[] = []
    if (canRead('accounting')) {
      jobs.push(getJson<PaletteVehicle[]>(appFetch, '/api/accounting/vehicle-index')
        .then(v => (Array.isArray(v) ? { vehicles: v } : {})))
    }
    if (canRead('portfolio')) {
      // Every holding, fund holdings and digital assets included: each opens on /companies/[id].
      jobs.push(getJson<{ id: string; name: string; aliases: string[] | null; holdingType?: string }[]>(appFetch, '/api/companies?holdings=all')
        .then(rows => (!Array.isArray(rows) ? {} : {
          companies: rows.map(c => ({
            id: `company:${c.id}`, label: c.name, href: `/companies/${c.id}`, group: 'companies' as PaletteGroup,
            hint: c.holdingType ? HOLDING_HINTS[c.holdingType] : undefined,
            keywords: c.aliases ?? undefined,
          })),
        })))
    }
    if (canRead('lp_capital', 'lps')) {
      jobs.push(getJson<{ id: string; name: string; lp_entities?: { entity_name: string }[] }[]>(appFetch, '/api/lps/investors')
        .then(rows => (!Array.isArray(rows) ? {} : {
          lps: rows.map(inv => ({
            id: `lp:${inv.id}`, label: inv.name, href: `/lps/cards/${inv.id}`, group: 'lps' as PaletteGroup,
            keywords: (inv.lp_entities ?? []).map(e => e.entity_name),
          })),
        })))
    }
    if (canRead('dealflow', 'deals')) {
      jobs.push(getJson<{ id: string; company_name: string | null; founder_name: string | null; status: string }[]>(appFetch, '/api/deals?limit=200')
        .then(rows => (!Array.isArray(rows) ? {} : {
          deals: rows.map(d => ({
            id: `deal:${d.id}`, label: d.company_name ?? d.founder_name ?? 'Untitled deal', hint: d.status?.replace(/_/g, ' '),
            href: `/deals/${d.id}`, group: 'deals' as PaletteGroup,
            keywords: d.founder_name ? [d.founder_name] : undefined,
          })),
        })))
    }

    Promise.all(jobs).then(parts => {
      // A list whose fetch failed keeps what it had.
      if (!cancelled) setRecords(prev => parts.reduce<Records>((acc, p) => ({ ...acc, ...p }), prev))
    })
    return () => { cancelled = true }
  }, [open, access, appFetch])

  return records
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const GROUP_ICONS: Record<PaletteGroup, typeof FileText> = {
  pages: FileText,
  entities: BookOpen,
  companies: Building2,
  lps: Crown,
  deals: Lightbulb,
}

interface CommandPaletteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  reviewBadge?: number
  approvalsBadge?: number
  fofActive?: boolean
}

function CommandPaletteDialog({ open, onOpenChange, reviewBadge, approvalsBadge, fofActive }: CommandPaletteDialogProps) {
  const navigate = useAppNavigate()
  const access = useAccess()
  const isAdmin = useIsAdmin()
  const { setVehicle } = useVehicle()
  const records = useRecords(open)

  const entries = useMemo<PaletteEntry[]>(() => [
    ...pageEntries(isAdmin, access, {
      fofActive,
      vehicles: records.vehicles,
      badges: { review: reviewBadge, approvals: approvalsBadge },
    }),
    ...records.companies,
    ...records.lps,
    ...records.deals,
  ], [isAdmin, access, fofActive, records, reviewBadge, approvalsBadge])

  const go = useCallback((entry: PaletteEntry) => {
    onOpenChange(false)
    // An entity-scoped page pins the vehicle context the same way visiting it from the sidebar
    // would, so the Analyst and the fund pages agree about which entity is selected.
    const m = entry.href.match(/^\/funds\/([^/]+)/)
    if (m) {
      const seg = decodeURIComponent(m[1])
      const v = records.vehicles.find(x => x.id === m[1] || x.name === seg)
      if (v) setVehicle(v.name, v.id ?? null)
    }
    navigate(entry.href)
  }, [onOpenChange, records.vehicles, navigate, setVehicle])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-card border bg-popover text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">Jump to</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Type to find a page, entity, company, LP or deal, then press Enter to open it.</DialogPrimitive.Description>
          {/* The body mounts with the dialog (Radix unmounts closed content), so the query and
              the active row start fresh on every open without an effect to reset them. */}
          <PaletteBody entries={entries} onPick={go} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function PaletteBody({ entries, onPick }: { entries: PaletteEntry[]; onPick: (entry: PaletteEntry) => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => groupEntries(matchEntries(query, entries)), [query, entries])
  // The rows in render order, and each row's position in it, for the keyboard.
  const flat = useMemo(() => groups.flatMap(g => g.entries), [groups])
  const indexOf = useMemo(() => new Map(flat.map((e, i) => [e.id, i])), [flat])
  const current = flat[Math.min(active, flat.length - 1)]

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!current) return
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (current) onPick(current) }
  }

  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          id="command-palette-input"
          autoFocus
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0) }}
          placeholder="Jump to a page, entity, company, LP or deal…"
          aria-label="Jump to"
          aria-controls="command-palette-list"
          aria-activedescendant={current ? `palette-${current.id}` : undefined}
          role="combobox"
          aria-expanded="true"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden sm:inline rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">esc</kbd>
      </div>

      <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
        {groups.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            Nothing matches “{query}”.
          </div>
        )}
        {groups.map(g => {
          const Icon = GROUP_ICONS[g.group]
          return (
            <div key={g.group} className="mb-1">
              <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
              {g.entries.map(entry => {
                const isActive = entry === current
                return (
                  <button
                    key={entry.id}
                    id={`palette-${entry.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-id={entry.id}
                    onMouseMove={() => setActive(indexOf.get(entry.id) ?? 0)}
                    onClick={() => onPick(entry)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
                      isActive ? 'bg-accent text-foreground' : 'text-foreground/90',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{entry.label}</span>
                    {entry.hint && <span className="truncate text-xs text-muted-foreground">{entry.hint}</span>}
                    {isActive && <CornerDownLeft className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span><Kbd>↵</Kbd> open</span>
        <span className="ml-auto hidden sm:inline">Only what you can open is listed</span>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-1 rounded border px-1 py-px text-[10px] font-medium">{children}</kbd>
}

/** The header's way in: a search-shaped button carrying the shortcut. */
export function CommandPaletteTrigger({ className }: { className?: string }) {
  const { open } = useCommandPalette()
  const shortcut = useShortcutLabel()
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Jump to a page"
      className={cn(
        // Dressed as the Sign out button beside it (outline, sm) so the header reads as one row of
        // controls; the wider min-width is what says "search field" rather than "button".
        'inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground sm:min-w-44',
        className,
      )}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Jump to…</span>
      <kbd className="ml-auto hidden sm:inline rounded-sm bg-muted px-1.5 py-px font-sans text-[10px] font-medium text-muted-foreground">{shortcut}</kbd>
    </button>
  )
}
