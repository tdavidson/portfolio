'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, AlertTriangle, Ban, Info, ChevronRight, Lock, Landmark, Plus, X, Pencil, FileArchive, FileText } from 'lucide-react'
import { TaxPackageLink } from '@/components/accounting/download-menu'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch, useFundSeg, useVehicle } from '@/components/accounting-vehicle'
import { VehicleEditModal, type EditableVehicle } from '@/components/vehicle-edit-modal'
import { DealCarryCard } from './deal-carry-card'
import { BootstrapInvestmentsCard } from './bootstrap-investments'
import { CarryTerms } from '../allocation-terms/carry-terms'
import { useAccess, useCanRead, useIsAdmin } from '@/components/access-context'
import { QuickActionButtons } from '@/components/quick-action-buttons'
import { createActions } from '@/lib/start/quick-actions'
import { CapitalCallsCard } from './capital-calls-card'
import { isManagementCompany, VEHICLE_KIND_LABELS } from '@/lib/vehicle-kinds'
import { MancoIntercompanyCard } from './intercompany-card'
import { AllocationTermsView } from '../allocation-terms/view'
import { CollapsibleSection } from '@/components/collapsible-section'
import { ChartOfAccountsCard } from '@/components/accounting/chart-of-accounts-card'
import { WireInstructionsCard } from '@/components/accounting/wire-instructions-card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

interface Issue { level: 'blocker' | 'warning' | 'info'; title: string; detail: string; href?: string; action?: string }
interface Status {
  vehicle: string
  setup: {
    chartSeeded: boolean
    accountCount: number
    hasPostedEntries: boolean
    partnerCount: number
    partnersWithCommitment: number
  }
  ledger: { entryCount: number; postedCount: number; draftCount: number; trialBalanced: boolean; nav: number; netAssets: number }
  close: { basis: string; lastClosedEnd: string | null; lastClosedLabel: string | null; nextStart: string | null; unallocatedEarnings: number }
  bank: { total: number; needsAttention: number }
  issues: Issue[]
}

const LEVEL = {
  blocker: { Icon: Ban, cls: 'text-destructive', box: 'border-destructive/40 bg-destructive/5' },
  warning: { Icon: AlertTriangle, cls: 'text-warning', box: 'border-warning/40 bg-warning/5' },
  info: { Icon: Info, cls: 'text-muted-foreground', box: '' },
}

export function StatusView() {
  const { group } = useVehicle()
  return <EntityStatusView key={group} />
}

function EntityStatusView() {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const lf = useLedgerFetch()
  const fundSeg = useFundSeg()
  const { group, kind, vehicleId } = useVehicle()
  const access = useAccess()
  const isAdmin = useIsAdmin()
  const manco = isManagementCompany(kind)
  // The status issues carry bare /funds/<page> hrefs (built server-side, where the URL's
  // vehicle id isn't known); rewrite them fund-first for the current vehicle.
  const fundHref = (href: string) => {
    if (!fundSeg) return href
    const m = href.match(/^\/funds\/(.+)$/)
    return m ? `/funds/${fundSeg}/${m[1]}` : href
  }
  const canReadGpEconomics = useCanRead('gp_economics')
  const [s, setS] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const res = await lf('/api/accounting/status')
      if (!res.ok) throw new Error('Could not load the current status. Please try again.')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setS(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load status')
    } finally {
      setLoading(false)
    }
  }, [lf])
  useEffect(() => { void load() }, [load])

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
  if (error) return <EmptyState>{error} <Button variant="outline" size="sm" onClick={load}>Retry</Button></EmptyState>
  if (!s) return <EmptyState>Could not load status for this vehicle.</EmptyState>

  // Vehicle identity — name, type, vintage, aliases — sits above the accounting state on both
  // branches below. It used to be editable only from the group table on /investments, which meant
  // the page named after a fund was the one place you couldn't correct the fund's own details.

  const cards: { label: string; value: string; hint?: string; href: string }[] = [
    { label: manco ? 'Members’ capital' : 'Net assets', value: s.setup.hasPostedEntries ? fmt(s.ledger.netAssets) : 'No entries yet', hint: `${s.ledger.postedCount} posted entries`, href: '/funds/statements' },
    manco
      ? { label: 'Books', value: `${s.setup.accountCount} accounts`, hint: `${s.ledger.draftCount} draft entries`, href: '/funds/journal' }
      : { label: 'Partners', value: String(s.setup.partnerCount), hint: `${s.setup.partnersWithCommitment} with a commitment`, href: '/funds/capital-accounts' },
    {
      label: 'Bank',
      value: s.bank.total === 0 ? 'No transactions' : s.bank.needsAttention > 0 ? `${s.bank.needsAttention} to review` : 'No pending transactions',
      hint: `${s.bank.total} transactions`,
      href: '/funds/bank',
    },
    {
      label: 'Trial balance',
      value: !s.setup.hasPostedEntries ? 'No entries yet' : s.ledger.trialBalanced ? 'Balanced' : 'Out',
      hint: s.ledger.draftCount > 0 ? `${s.ledger.draftCount} draft entries` : `${s.ledger.postedCount} posted entries`,
      href: '/funds/statements',
    },
  ]

  const unallocated = Math.abs(s.close.unallocatedEarnings) > 0.004
  const closeSummary = s.close.lastClosedEnd
    ? `Closed through ${s.close.lastClosedLabel ?? s.close.lastClosedEnd} (${s.close.lastClosedEnd}).`
    : 'No period has been closed yet.'
  const closeNext = s.close.nextStart
    ? `The next close starts ${s.close.nextStart}.`
    : 'Nothing left to close.'

  return (
    <div className="space-y-6">
      <VehicleDetailsCard />

      {/* The entity's everyday work, from its own page: the same shortcuts as Start, under the
          same gates, with the capital pair opening this entity's capital accounts. A management
          company has no partners to call or distribute to. */}
      {(() => {
        const actions = createActions(access, { isAdmin })
          .filter(a => a.id !== 'add-deal' && a.id !== 'add-vehicle')
          .filter(a => !manco || a.group !== 'capital')
        return actions.length > 0 ? (
          <div className="space-y-2">
            <QuickActionButtons actions={actions} vehicleId={vehicleId} />
          </div>
        ) : null
      })()}

      {!manco && <CapitalCallsCard capitalHref={fundHref('/funds/capital-accounts')} />}


      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map(c => (
          <Link key={c.label} href={fundHref(c.href)} className="border rounded-card p-3 hover:bg-muted/30">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="text-lg tabular-nums font-semibold mt-0.5 truncate">{c.value}</p>
            {c.hint && <p className="text-[11px] text-muted-foreground mt-0.5">{c.hint}</p>}
          </Link>
        ))}
      </div>

      <div>
        <p className="text-sm font-medium mb-2">Needs attention</p>
        {s.issues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-sm text-success">
            <Check className="h-4 w-4" />
            No outstanding issues detected in the books.
          </div>
        ) : (
          <div className="space-y-2">
            {s.issues.map((i, idx) => {
              const L = LEVEL[i.level] ?? LEVEL.info
              return (
                <div key={idx} className={`flex items-start gap-2 rounded-card border p-3 text-sm ${L.box}`}>
                  <L.Icon className={`h-4 w-4 mt-0.5 shrink-0 ${L.cls}`} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{i.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{i.detail}</p>
                  </div>
                  {i.href && (
                    <Link href={fundHref(i.href)} className="shrink-0 rounded border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                      {i.action ?? 'Open'}
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Where the close got to, and what it would pick up next — the one thing you
          come to this page to find out. Amber when income is sitting unallocated,
          because until it's closed every partner's capital account understates. */}
      <Link
        href={fundHref('/funds/periods')}
        className={`flex items-center gap-3 rounded-card border p-3 transition-colors hover:bg-muted/30 ${unallocated ? 'border-warning/40 bg-warning/5' : ''}`}
      >
        <Lock className={`h-4 w-4 shrink-0 ${unallocated ? 'text-warning' : 'text-muted-foreground'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Period close</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {closeSummary} {closeNext}
            {unallocated && (
              <>
                {' '}
                <span className="text-warning">
                  {fmt(s.close.unallocatedEarnings)} of net income {manco ? 'has not yet been closed to members’ capital.' : 'is not yet allocated to partners.'}
                </span>
              </>
            )}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Link>

      {/* Settings — configuration that used to live on the separate Allocation terms page, now
          folded in here as collapsible sections so it's all on one surface but hideable. */}
      <div className="pt-2 space-y-2">
        <p className="text-sm font-medium">Settings</p>

        {/* Carry rate, preferred return, catch-up, and the GP entity that receives it — the
            gp_economics domain, not plain accounting. Someone who runs the close does not
            thereby get to see (or set) the partners' carry terms. */}
        {!manco && canReadGpEconomics && (
          <CollapsibleSection title="General Partners and carried interest" subtitle="Carried interest and general partner settings">
            <div className="space-y-4">
              <CarryTerms />
              {/* GP-of links live here — a one-time set-and-done setting next to the carry it drives
                  (many-to-many via vehicle_gp_links; separate from the legacy single-GP capital-accounts panel). */}
              <GeneralPartnersCard />
            </div>
          </CollapsibleSection>
        )}

        {!manco && <CollapsibleSection title="Payment instructions" subtitle="Bank details printed on this vehicle's capital call notices">
          <WireInstructionsCard />
        </CollapsibleSection>}

        {/* The entity's governing documents — the LPA or operating agreement, side letters and
            amendments — are managed on their own page; this is the way in. */}
        {vehicleId && (
          <CollapsibleSection title="Fund documents" subtitle="The LPA or operating agreement, side letters and amendments">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Upload and manage this entity&apos;s governing documents. The Analyst can answer questions about their terms.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href={`/entities/${vehicleId}/documents`}><FileText className="h-3.5 w-3.5 mr-1.5" />Documents</Link>
              </Button>
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection title="Chart of accounts" subtitle="Add, rename, or hide the accounts this vehicle posts to">
          <ChartOfAccountsCard />
        </CollapsibleSection>

        {!manco && <>
        {/* Renders nothing unless the tracker holds transactions the ledger never derived. */}
        <BootstrapInvestmentsCard onBooked={load} />

        <CollapsibleSection
          title="Partners Detail"
          subtitle={`Splitting on ${s.close.basis === 'capital_balance' ? 'capital-account balance' : 'committed capital'} · who bears fees, expenses, and carry · commitment history`}
        >
          <AllocationTermsView showHeader={false} />
        </CollapsibleSection>
        </>}
      </div>

      {/* Migrating a QuickBooks general ledger happens once, at the start of a vehicle's life,
          so it is linked from here instead of occupying a permanent sidebar slot. */}
      <Link
        href={fundHref('/funds/migrate')}
        className="flex items-center gap-3 rounded-card border p-3 transition-colors hover:bg-muted/30"
      >
        <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Migrate from QuickBooks</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Import a QuickBooks general ledger, map its accounts to this chart, and tie every period out before cutting over.
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Link>

      {/* The MANAGEMENT COMPANY's own intercompany register. A fund does not get one: an
          intercompany charge is already a pair of postings, one in each entity's ledger, so the
          fund side has nothing to show that its journal and statements do not. The fund-side card
          rendered one box per management company in the firm whether or not the fund had any
          relationship with it, which is how every fund ended up displaying every manco. */}
      {manco && (
        <div id="intercompany">
          <MancoIntercompanyCard onChanged={load} />
        </div>
      )}

      {/* The year's preparer bundle. Lives here beside the other once-a-year work; the same
          control is in the statements page's Download menu. */}
      <div className="flex items-start gap-3 rounded-card border p-3">
        <FileArchive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 -mx-2 -my-1.5">
          <TaxPackageLink group={group} />
        </div>
      </div>

      {/* Deal-by-deal carry — a reference calculator for American vehicles. gp_economics, for the
          same reason as the carry terms above. Renders to nothing on other vehicles anyway. */}
      {!manco && canReadGpEconomics && <DealCarryCard />}

    </div>
  )
}

// The one vocabulary, from lib/vehicle-kinds.ts — this file used to keep its own copy, which is
// how a kind added there (manco, then individual) rendered here as a raw string.
const KIND_LABELS: Record<string, string> = VEHICLE_KIND_LABELS

/**
 * The vehicle's own record — name, type, vintage year, aliases, active — editable in place. Reads
 * the registry by the selected vehicle's id; a legacy name-only vehicle (no registry row) falls
 * back to matching on name, and shows nothing if neither resolves.
 */
function VehicleDetailsCard() {
  const { vehicleId, group, setVehicle } = useVehicle()
  const [vehicle, setVehicleRow] = useState<EditableVehicle | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/vehicles')
    if (!res.ok) return
    const rows = (await res.json()) as Array<{
      id: string; name: string; kind: string; aliases: string[] | null
      active: boolean; vintage_year: number | null
    }>
    const n = (group ?? '').trim().toLowerCase()
    const row =
      rows.find(v => v.id === vehicleId) ??
      rows.find(v => v.name.trim().toLowerCase() === n) ??
      null
    setVehicleRow(row
      ? { id: row.id, name: row.name, kind: row.kind, vintage_year: row.vintage_year, active: row.active, aliases: row.aliases ?? [] }
      : null)
  }, [vehicleId, group])

  useEffect(() => { load() }, [load])

  if (!vehicle) return null

  return (
    <>
      <div className="rounded-card border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{vehicle.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {KIND_LABELS[vehicle.kind] ?? vehicle.kind}
              {' · '}
              {vehicle.vintage_year != null ? `Vintage ${vehicle.vintage_year}` : 'No vintage set'}
              {vehicle.active ? '' : ' · Inactive'}
              {vehicle.aliases.length > 0 ? ` · also known as ${vehicle.aliases.join(', ')}` : ''}
            </p>
          </div>
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />Edit
          </button>
        </div>
      </div>
      {editing && (
        <VehicleEditModal
          vehicle={vehicle}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            await load()
            // A rename cascades server-side; the selected vehicle's name is cached in context and
            // localStorage, so re-point it or every ledger fetch keeps asking for the old group.
            const res = await fetch('/api/vehicles')
            if (res.ok) {
              const rows = (await res.json()) as Array<{ id: string; name: string }>
              const fresh = rows.find(v => v.id === vehicle.id)
              if (fresh) setVehicle(fresh.name, fresh.id)
            }
          }}
        />
      )}
    </>
  )
}

interface GpLinkRow { id: string; gpVehicleId: string; gpName: string; lpEntityId: string | null; lpName: string | null }
interface GpLinksData {
  links: GpLinkRow[]
  candidates: { id: string; name: string }[]
  partners: { id: string; name: string }[]
}

/** "General partner(s)" — the GP/associate entities linked to this vehicle via vehicle_gp_links. */
function GeneralPartnersCard() {
  const lf = useLedgerFetch()
  const [data, setData] = useState<GpLinksData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [addGpId, setAddGpId] = useState('')
  const [addPartnerId, setAddPartnerId] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    lf('/api/accounting/vehicle-gp-links')
      .then(async r => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) { setError(d.error ?? 'Could not load GP links'); return }
        setError(null)
        setData(d)
      })
      .finally(() => setLoading(false))
  }, [lf])
  useEffect(() => { load() }, [load])

  async function addLink() {
    if (!addGpId) return
    setBusy('add')
    setError(null)
    const res = await lf('/api/accounting/vehicle-gp-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gpVehicleId: addGpId, lpEntityId: addPartnerId || null }),
    })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setError(d.error ?? 'Could not add GP'); return }
    setAddGpId(''); setAddPartnerId('')
    load()
  }

  async function removeLink(id: string) {
    setBusy(id)
    setError(null)
    const res = await lf('/api/accounting/vehicle-gp-links', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setBusy(null)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error ?? 'Could not remove GP'); return }
    load()
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs border rounded-lg px-3 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading general partner(s)…
      </div>
    )
  }
  if (!data) return null

  const linkedGpIds = new Set(data.links.map(l => l.gpVehicleId))
  const addableCandidates = data.candidates.filter(c => !linkedGpIds.has(c.id))

  return (
    <div className="border rounded-card p-3 space-y-2">
      <p className="text-sm font-medium">General partner(s)</p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data.links.length === 0 ? (
        <p className="text-xs text-muted-foreground">No general partner linked to this vehicle yet.</p>
      ) : (
        <ul className="space-y-1">
          {data.links.map(l => (
            <li key={l.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {l.gpName}
                {l.lpName && <span className="ml-1.5 text-xs text-muted-foreground">as {l.lpName}</span>}
              </span>
              <button
                onClick={() => removeLink(l.id)}
                disabled={busy === l.id}
                title="Remove"
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                {busy === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {data.candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No GP/associate entities in this fund yet.</p>
      ) : addableCandidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">Every GP/associate entity in this fund is already linked.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <label className="text-xs text-muted-foreground">GP entity
            <select
              value={addGpId}
              onChange={e => setAddGpId(e.target.value)}
              className="mt-1 h-9 px-2 rounded-md border border-input bg-background text-sm block min-w-[160px]"
            >
              <option value="">Choose…</option>
              {addableCandidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">As partner (optional)
            <select
              value={addPartnerId}
              onChange={e => setAddPartnerId(e.target.value)}
              className="mt-1 h-9 px-2 rounded-md border border-input bg-background text-sm block min-w-[160px]"
            >
              <option value="">—</option>
              {data.partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <Button size="sm" onClick={addLink} disabled={!addGpId || busy !== null}>
            {busy === 'add' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />} Add
          </Button>
        </div>
      )}
    </div>
  )
}
