'use client'

// Who on the team can read or change each content area.
//
// The two rows above the members ("Default for new members") are load-bearing: without them an
// admin has to remember to configure every new joiner, and the failure mode of forgetting is
// either a locked-out colleague or an over-shared one. The default is set once, and a member's
// own grant overrides it.
//
// See plans/plan-access-control.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Shield, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { VEHICLE_KIND_LABELS, isVehicleKind } from '@/lib/vehicle-kinds'
import { DOMAIN_META, domainFundLevel, domainGrantableToMembers, type Domain } from '@/lib/access/domains'
import { FEATURE_META } from '@/lib/types/feature-meta'
import type { FeatureVisibilityMap } from '@/lib/types/features'

type Level = 'none' | 'read' | 'write'

interface DomainInfo { key: Domain; label: string; description: string }
interface MemberAccess { userId: string; email: string; role: string; grants: Record<string, Level>; entities?: string[]; allEntities?: boolean }
interface EntityInfo { id: string; name: string; kind: string; active: boolean }

/**
 * The fund-level switches (as named in Feature visibility) that govern a domain.
 *
 * Printed for every column, including where it echoes the column name ("Diligence ← Diligence").
 * The repetition is the point: a reader scanning down should find the same shape everywhere, and a
 * column with no line under it would read as "this one has no switch" — which is a different and
 * wrong claim.
 */
function switchesFor(domain: Domain): string {
  return DOMAIN_META[domain].features.map(k => FEATURE_META[k].label).join(' · ')
}

/** A cell that shows a fixed answer rather than a control — matched to the picker's height so the
 *  two line up when a row has both. */
const STATIC_CELL = 'inline-flex h-7 items-center text-[10px] text-muted-foreground'

const LEVELS: { value: Level; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read & write' },
]

/**
 * `featureVisibility` is passed in rather than fetched: an admin can change a switch in the section
 * above without this grid remounting, and a "grantable" answer computed at mount would then be a
 * lie — the grid would go on offering a dropdown that effectiveAccess ignores. Deriving it from
 * live props means changing Compliance to "Admins only" updates this instantly, no refresh.
 */
export function AccessGrid({ featureVisibility }: { featureVisibility: FeatureVisibilityMap }) {
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [members, setMembers] = useState<MemberAccess[]>([])
  const [defaults, setDefaults] = useState<Record<string, Level>>({})
  const [entities, setEntities] = useState<EntityInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // THE GRID IS WIDER THAN THE CARD, and a horizontal scrollbar alone does not say so (macOS hides
  // it until you scroll). So the right edge fades while columns are hidden, and a button says
  // there are more and scrolls to them.
  const scroller = useRef<HTMLDivElement>(null)
  const [moreRight, setMoreRight] = useState(false)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = () => setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
    el.addEventListener('scroll', update, { passive: true })
    // Fires once on observe, which is the initial measurement.
    const resize = new ResizeObserver(update)
    resize.observe(el)
    return () => { el.removeEventListener('scroll', update); resize.disconnect() }
  }, [loading, domains.length])

  const load = useCallback(async () => {
    const res = await fetch('/api/settings/access')
    if (res.ok) {
      const data = await res.json()
      setDomains(data.domains)
      setMembers(data.members)
      setDefaults(data.defaults ?? {})
      setEntities(data.entities ?? [])
    } else {
      setError('Could not load access settings.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function save(payload: Record<string, unknown>, busyKey: string) {
    setSaving(busyKey)
    setError(null)
    // Optimistic: the grid is a lot of small edits, and a round-trip per click makes it feel
    // broken. A failure re-loads the truth.
    const res = await fetch('/api/settings/access', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setSaving(null)
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not save.')
      load()
      return
    }
    setSavedAt(Date.now())
  }

  function setGrant(userId: string, domain: string, level: Level) {
    setMembers(prev => prev.map(m => (m.userId === userId ? { ...m, grants: { ...m.grants, [domain]: level } } : m)))
    save({ userId, domain, level }, `${userId}:${domain}`)
  }

  function setDefault(domain: string, level: Level) {
    setDefaults(prev => ({ ...prev, [domain]: level }))
    save({ domain, level }, `default:${domain}`)
  }

  // Entities: which of the fund's funds, SPVs and management companies this member sees at all.
  // Domains above say what kind of data; this says whose.
  function setEntity(userId: string, vehicleId: string, granted: boolean) {
    setMembers(prev => prev.map(m => (m.userId === userId
      ? { ...m, entities: granted ? [...(m.entities ?? []), vehicleId] : (m.entities ?? []).filter(id => id !== vehicleId) }
      : m)))
    save({ userId, vehicleId, granted }, `${userId}:entity:${vehicleId}`)
  }

  function setAllEntities(userId: string, allEntities: boolean) {
    setMembers(prev => prev.map(m => (m.userId === userId ? { ...m, allEntities } : m)))
    save({ userId, allEntities }, `${userId}:all-entities`)
  }

  function setRole(userId: string, role: string) {
    setMembers(prev => prev.map(m => (m.userId === userId ? { ...m, role } : m)))
    save({ userId, role }, `${userId}:role`)
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground max-w-3xl">
        What each person can reach. This applies everywhere their account can read data — the app,
        the Analyst, agents over MCP, and API keys they create. A grant can only narrow what the
        fund allows: an area set to <span className="font-medium">Admins only</span> above stays
        admin-only however it is granted here.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {moreRight && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => scroller.current?.scrollBy({ left: 360, behavior: 'smooth' })}
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            More areas <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="relative">
      <div ref={scroller} className="overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="text-left font-medium py-2 pr-3 sticky left-0 z-10 bg-card align-top">Person</th>
              {/* Entities come first: whose data a member sees decides everything to the right of
                  it, and it is the one column that must never be scrolled out of sight. */}
              <th className="px-2 py-2 text-left font-medium align-top">
                <span className="whitespace-nowrap">Entities</span>
                <span className="mt-0.5 block max-w-[150px] text-[9px] font-normal leading-tight text-muted-foreground">
                  Whose data they see
                </span>
              </th>
              {domains.map(d => (
                <th key={d.key} className="px-2 py-2 text-left font-medium align-top">
                  <span title={d.description} className="whitespace-nowrap">{d.label}</span>
                  {/* The bridge between the two vocabularies on this page: 17 switches above, 9
                      columns here, and nothing else saying which feeds which. Without it you have
                      to already know that "LP capital" answers to the "LPs" and "LP capital
                      tracking" switches, or that "Notes" also covers Interactions. */}
                  <span className="mt-0.5 block max-w-[150px] text-[9px] font-normal leading-tight text-muted-foreground">
                    {switchesFor(d.key)}
                  </span>
                  {!domainGrantableToMembers(d.key, featureVisibility) && (
                    // The fund switch above already decided this one. Saying so beats offering a
                    // dropdown whose value effectiveAccess never reads.
                    <span className="mt-0.5 block whitespace-nowrap text-[9px] font-normal text-muted-foreground">
                      {domainFundLevel(d.key, featureVisibility) === 'admin' ? 'Admins only' : 'Off'} — set above
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* The baseline a new member inherits. */}
            <tr className="border-t">
              <td className="py-2 pr-3 sticky left-0 z-10 bg-card align-top">
                <p className="text-xs font-medium">Default for new members</p>
                <p className="text-[10px] text-muted-foreground">Applied when someone joins</p>
              </td>
              {/* No default here on purpose: a new member sees no entity until granted one. */}
              <td className="px-2 py-2 align-top"><span className={STATIC_CELL}>None</span></td>
              {domains.map(d => (
                <td key={d.key} className="px-2 py-2 align-top">
                  {domainGrantableToMembers(d.key, featureVisibility) ? (
                    <LevelPicker
                      value={defaults[d.key] ?? 'none'}
                      onChange={level => setDefault(d.key, level)}
                      busy={saving === `default:${d.key}`}
                    />
                  ) : (
                    <span className={STATIC_CELL}>—</span>
                  )}
                </td>
              ))}
            </tr>

            {members.map(m => (
              <tr key={m.userId} className="border-t">
                <td className="py-2 pr-3 sticky left-0 z-10 bg-card align-top">
                  <p className="text-xs truncate max-w-[220px]" title={m.email}>{m.email}</p>
                  {m.role === 'viewer' ? (
                    // The demo account. Not a role you can assign, so not one you can leave either.
                    <span className="text-[10px] text-muted-foreground">Demo account</span>
                  ) : (
                    <RolePicker role={m.role} onChange={role => setRole(m.userId, role)} busy={saving === `${m.userId}:role`} />
                  )}
                </td>
                <td className="px-2 py-2 align-top">
                  {m.role === 'admin' || m.role === 'viewer' ? (
                    <span className={`${STATIC_CELL} gap-1`}><Shield className="h-2.5 w-2.5" />All</span>
                  ) : (
                    <EntityPicker
                      member={m}
                      entities={entities}
                      saving={saving}
                      onAll={all => setAllEntities(m.userId, all)}
                      onToggle={(id, on) => setEntity(m.userId, id, on)}
                    />
                  )}
                </td>
                {domains.map(d => (
                  <td key={d.key} className="px-2 py-2 align-top">
                    {m.role === 'admin' ? (
                      // Admins hold everything switched on; a grant row would be decorative.
                      <span className={`${STATIC_CELL} gap-1`}>
                        <Shield className="h-2.5 w-2.5" />All
                      </span>
                    ) : m.role === 'viewer' ? (
                      // The demo reads whatever the fund has switched on; grants don't apply to it.
                      <span className={STATIC_CELL}>Read</span>
                    ) : !domainGrantableToMembers(d.key, featureVisibility) ? (
                      // A grant here is inert: effectiveAccess returns none for a member the
                      // moment the fund switch says Admins only / Off, without ever reading it.
                      // Showing "Read" would be a promise the resolver doesn't keep.
                      <span className={STATIC_CELL}>—</span>
                    ) : (
                      <LevelPicker
                        // No explicit grant → they follow the default, and the picker says so.
                        value={m.grants[d.key] ?? defaults[d.key] ?? 'none'}
                        inherited={m.grants[d.key] === undefined}
                        onChange={level => setGrant(m.userId, d.key, level)}
                        busy={saving === `${m.userId}:${d.key}`}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {moreRight && (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-card to-transparent" />
      )}
      </div>

      {savedAt && !saving && (
        <p className="text-[11px] text-success inline-flex items-center gap-1"><Check className="h-3 w-3" />Saved</p>
      )}
    </div>
  )
}

/**
 * Which entities a member sees, as one compact control: the summary in the cell, the list in a
 * popover. A firm with a dozen funds, SPVs and management companies made the old inline checklist
 * the tallest thing on the page, repeated for every member.
 */
function EntityPicker({
  member, entities, saving, onAll, onToggle,
}: {
  member: MemberAccess
  entities: EntityInfo[]
  saving: string | null
  onAll: (all: boolean) => void
  onToggle: (vehicleId: string, granted: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const granted = new Set(member.entities ?? [])
  const busy = saving?.startsWith(`${member.userId}:entity:`) || saving === `${member.userId}:all-entities`
  const summary = member.allEntities
    ? 'All entities'
    : granted.size === 0
      ? 'None'
      : granted.size === 1
        ? entities.find(e => granted.has(e.id))?.name ?? '1 entity'
        : `${granted.size} entities`
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entities
      .filter(e => !q || e.name.toLowerCase().includes(q))
      // Active first, then by name — an inactive entity is rarely the one being granted.
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
  }, [entities, query])
  const kind = (k: string) => (isVehicleKind(k) ? VEHICLE_KIND_LABELS[k] : '')

  return (
    <div className="inline-flex items-center gap-1">
      <Popover onOpenChange={open => { if (!open) setQuery('') }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`inline-flex h-7 max-w-[180px] items-center gap-1 rounded border px-1.5 text-[11px] ${granted.size === 0 && !member.allEntities ? 'text-muted-foreground' : ''}`}
          >
            <span className="truncate">{summary}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="border-b p-3">
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={!!member.allEntities} onChange={e => onAll(e.target.checked)} />
              <span>
                <span className="font-medium">All entities</span>
                <span className="block text-[11px] text-muted-foreground">Including ones added later, and items not assigned to any entity.</span>
              </span>
            </label>
          </div>
          {!member.allEntities && (
            <>
              {entities.length > 8 && (
                <div className="border-b p-2">
                  <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find an entity" className="h-7 text-xs" />
                </div>
              )}
              <ul className="max-h-64 overflow-y-auto py-1">
                {shown.map(e => (
                  <li key={e.id}>
                    <label className={`flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted ${e.active ? '' : 'text-muted-foreground'}`}>
                      <input type="checkbox" checked={granted.has(e.id)} onChange={() => onToggle(e.id, !granted.has(e.id))} />
                      <span className="min-w-0 flex-1 truncate" title={e.name}>{e.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{e.active ? kind(e.kind) : 'Inactive'}</span>
                    </label>
                  </li>
                ))}
                {shown.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No entity matches.</li>}
              </ul>
              <p className="border-t px-3 py-2 text-[11px] text-muted-foreground tabular-nums">
                {granted.size === 0 ? 'Sees no entity data yet' : `${granted.size} of ${entities.length} selected`}
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  )
}

function LevelPicker({
  value, onChange, busy, inherited,
}: { value: Level; onChange: (l: Level) => void; busy?: boolean; inherited?: boolean }) {
  return (
    <div className="inline-flex items-center gap-1">
      <select
        value={value}
        onChange={e => onChange(e.target.value as Level)}
        disabled={busy}
        className={`rounded border bg-transparent px-1.5 py-1 text-[11px] ${inherited ? 'text-muted-foreground' : ''}`}
      >
        {LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
      </select>
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {inherited && !busy && <span className="text-[9px] text-muted-foreground" title="Following the default for new members">default</span>}
    </div>
  )
}

/**
 * Member or Admin. NOT Viewer.
 *
 * `viewer` is the demo fund's role, not a way to give someone read-only access — and it doesn't
 * behave like its name: it short-circuits the grid entirely and reads everything switched on,
 * INCLUDING areas set to "Admins only". Offering it here invited the exact opposite of what an
 * admin picking "read-only" intends. Read-only access is a column in the grid, per area.
 *
 * The demo account is provisioned by the demo seed; its row renders as a fixed badge below.
 */
function RolePicker({ role, onChange, busy }: { role: string; onChange: (r: string) => void; busy?: boolean }) {
  return (
    <div className="inline-flex items-center gap-1 mt-1">
      <select
        value={role}
        onChange={e => onChange(e.target.value)}
        disabled={busy}
        className="rounded border bg-transparent px-1.5 py-0.5 text-[10px] text-muted-foreground"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  )
}
