'use client'

import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppFetch } from '@/components/app-runtime'
import { useVehicleGroups } from '@/components/vehicle-groups'
import { groupBySection, isGrouped } from '@/lib/vehicle-groups'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/** One selectable vehicle: its name (the portfolio_group the ledger keys on) and its
 *  stable registry id. `id` is null for legacy vehicles that exist only as a name. */
export interface VehicleOption { name: string; id: string | null; kind?: string | null }

interface VehicleCtx {
  vehicles: VehicleOption[]
  /** The selected vehicle's name (portfolio_group). */
  group: string | null
  /** The selected vehicle's registry id (UUID), or null for a legacy name-only vehicle. */
  vehicleId: string | null
  /** The selected vehicle's kind (fund, spv, individual, …), or null until known / for a legacy
   *  vehicle. Read from the vehicle index; the nav hides pages a kind has no use for. */
  kind: string | null
  /** Set both name and id — used by the URL-scoped fund pages and the switcher. */
  setVehicle: (name: string, id: string | null) => void
  /** Set the name only, leaving the id untouched — back-compat for name-only callers. */
  setGroup: (name: string) => void
}
const VehicleContext = createContext<VehicleCtx>({
  vehicles: [], group: null, vehicleId: null, kind: null, setVehicle: () => {}, setGroup: () => {},
})

const NAME_KEY = 'acct_vehicle'
const ID_KEY = 'acct_vehicle_id'

// FUND_SUBPAGE_SLUGS lives in a plain module (see ./fund-subpages) so the server-side fund
// detail page can call `.has()` on it — a Set exported from this 'use client' module becomes a
// client-reference proxy on the server. Re-exported here for existing client-side importers.
export { FUND_SUBPAGE_SLUGS } from './fund-subpages'

/**
 * Holds the selected vehicle for the whole app (name + id), persisted to localStorage so
 * it survives navigation and reloads. Lives in AppShell — above the sidebar as well as the
 * page — so the Funds subnav can build fund-first hrefs from the current vehicle's id.
 */
export function VehicleProvider({ children }: { children: React.ReactNode }) {
  const [group, setGroupState] = useState<string | null>(null)
  const [vehicleId, setVehicleIdState] = useState<string | null>(null)
  // The fund's vehicles with their kinds, loaded once; the current kind is looked up from it.
  const [index, setIndex] = useState<VehicleOption[]>([])
  const appFetch = useAppFetch()
  const selectionVersion = useRef(0)

  const setVehicle = useCallback((name: string, id: string | null) => {
    selectionVersion.current++
    setGroupState(name)
    setVehicleIdState(id)
    try {
      localStorage.setItem(NAME_KEY, name)
      if (id) localStorage.setItem(ID_KEY, id)
      else localStorage.removeItem(ID_KEY)
    } catch { /* ignore */ }
  }, [])

  // Back-compat: set the name, leave the id as-is.
  const setGroup = useCallback((name: string) => {
    selectionVersion.current++
    setGroupState(name)
    try { localStorage.setItem(NAME_KEY, name) } catch { /* ignore */ }
  }, [])

  // Hydrate from localStorage; if nothing is saved, default to the fund's first vehicle so
  // the sidebar always has an id to build Funds links from.
  useEffect(() => {
    let name: string | null = null
    let id: string | null = null
    try {
      name = localStorage.getItem(NAME_KEY)
      id = localStorage.getItem(ID_KEY)
    } catch { /* ignore */ }
    if (name && selectionVersion.current === 0) { setGroupState(name); setVehicleIdState(id) }
    const version = selectionVersion.current
    // Always fetched, even when a vehicle is saved: the kind of the saved one comes from here.
    appFetch('/api/accounting/vehicle-index')
      .then(r => (r.ok ? r.json() : []))
      .then((vs: VehicleOption[]) => {
        if (!Array.isArray(vs)) return
        setIndex(vs)
        const first = vs[0]
        if (!name && first && version === 0 && selectionVersion.current === version) setVehicle(first.name, first.id ?? null)
      })
      .catch(() => { /* non-accounting user or no vehicles — leave unset */ })
  }, [setVehicle, appFetch])

  const kind = index.find(v => (vehicleId && v.id === vehicleId) || (!vehicleId && v.name === group))?.kind ?? null

  return (
    <VehicleContext.Provider value={{ group, vehicleId, kind, setVehicle, setGroup, vehicles: index }}>
      {children}
    </VehicleContext.Provider>
  )
}

export function useVehicle() {
  return useContext(VehicleContext)
}

/** The URL's server-authorised scope is available on the very first render. Shared sidebar
 * selection still updates through FundScopeSync, but cannot temporarily scope page requests. */
export function VehiclePageScope({ name, id, children }: { name: string; id: string | null; children: React.ReactNode }) {
  const parent = useVehicle()
  const kind = parent.vehicles.find(v => id ? v.id === id : v.name === name)?.kind ?? null
  return <VehicleContext.Provider value={{ ...parent, group: name, vehicleId: id, kind }}>{children}</VehicleContext.Provider>
}

/**
 * The current fund's URL segment for building fund-first links — its registry id, or its
 * URL-encoded name for a legacy vehicle (the `/funds/[id]` route resolves either). Null
 * when no vehicle is selected yet.
 */
export function useFundSeg(): string | null {
  const { vehicleId, group } = useVehicle()
  return vehicleId ?? (group ? encodeURIComponent(group) : null)
}

/**
 * The base path of the current entity's ledger pages, so a shared view can link to a sibling page
 * (the register, the journal) and land on the entity it is already showing.
 *
 * It used to branch: `/manco/<id>` for a management company, `/funds/<seg>` for everything else,
 * because the manco had a parallel set of pages. There is one set now — a management company is
 * an entity in the Entities section like any other — so there is one shape of URL.
 */
export function useVehicleBase(): string | null {
  const seg = useFundSeg()
  return seg ? `/funds/${seg}` : null
}

/**
 * A fetch wrapper that scopes every ledger request to the selected vehicle:
 * appends `?group=` to the URL and injects `group` into JSON POST bodies.
 */
export function useLedgerFetch() {
  const { group } = useVehicle()
  return useCallback(
    (path: string, opts?: RequestInit) => {
      let url = path
      if (group) url += (path.includes('?') ? '&' : '?') + 'group=' + encodeURIComponent(group)
      let init = opts
      if (opts?.body && typeof opts.body === 'string' && group) {
        try {
          const b = JSON.parse(opts.body)
          if (b && typeof b === 'object' && b.group === undefined) init = { ...opts, body: JSON.stringify({ ...b, group }) }
        } catch { /* leave non-JSON bodies alone */ }
      }
      return fetch(url, init)
    },
    [group]
  )
}

/**
 * The fund switcher — a compact select that JUMPS to the same page of another fund by
 * swapping the `[id]` segment of the current path. Styled to sit beside the Analyst button.
 * Hidden when there's nothing to switch to (one vehicle or none).
 */
export function FundSwitcher() {
  const pathname = usePathname()
  const router = useRouter()
  const { group, setVehicle, vehicles } = useVehicle()
  const [open, setOpen] = useState(false)
  const vehicleGroups = useVehicleGroups()

  if (vehicles.length <= 1) return null

  // Sectioned by the admin's entity groups, like the lists; flat when there are none.
  const sections = groupBySection(vehicles, vehicleGroups, v => ({ id: v.id, name: v.name }))
  const grouped = isGrouped(sections, vehicleGroups)

  const chooseVehicle = (opt: VehicleOption) => {
    setOpen(false)
    setVehicle(opt.name, opt.id ?? null)
    const target = opt.id ?? encodeURIComponent(opt.name)
    // Keep only the section (first subpage segment) — a deeper param like an LP id belongs
    // to the fund we're leaving, so jumping funds lands on that section's root.
    const section = pathname.split('/').filter(Boolean)[2]
    router.push(`/funds/${target}${section ? '/' + section : ''}`)
  }

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const opt = vehicles.find(v => v.name === e.target.value)
    if (opt) chooseVehicle(opt)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="min-w-0 flex-1 justify-between text-muted-foreground sm:hidden">
            <span className="truncate">{group ?? 'Switch entity'}</span>
            <ChevronsUpDown data-icon="inline-end" />
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>Switch entity</DialogTitle>
            <DialogDescription>Choose the entity you want to view.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 overflow-y-auto">
            {sections.map(sec => (
              <Fragment key={sec.group?.id ?? 'other'}>
                {grouped && <p className="pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{sec.label}</p>}
                {sec.items.map(vehicle => {
                  const selected = vehicle.name === group
                  return (
                    <Button
                      key={vehicle.id ?? vehicle.name}
                      type="button"
                      variant={selected ? 'secondary' : 'outline'}
                      className="h-auto min-h-10 justify-between whitespace-normal px-3 py-2 text-left"
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => chooseVehicle(vehicle)}
                    >
                      <span>{vehicle.name}</span>
                      {selected && <Check data-icon="inline-end" />}
                    </Button>
                  )
                })}
              </Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <div className="relative hidden sm:inline-flex">
        <select
          value={group ?? ''}
          onChange={onChange}
          aria-label="Jump to fund"
          className="h-8 max-w-[16rem] appearance-none truncate rounded-md border bg-transparent pl-3 pr-8 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {grouped
            ? sections.map(sec => (
                <optgroup key={sec.group?.id ?? 'other'} label={sec.label}>
                  {sec.items.map(v => <option key={v.id ?? v.name} value={v.name}>{v.name}</option>)}
                </optgroup>
              ))
            : vehicles.map(v => <option key={v.id ?? v.name} value={v.name}>{v.name}</option>)}
        </select>
        <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
    </>
  )
}
