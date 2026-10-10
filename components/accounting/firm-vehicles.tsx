'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, AlertTriangle, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useAccess, useIsAdmin } from '@/components/access-context'
import { VEHICLE_KIND_LABELS, isVehicleKind } from '@/lib/vehicle-kinds'
import { hasSectionForKind, sectionForSlug } from '@/lib/accounting/nav'
import { withCapitalAction, type CapitalAction } from '@/lib/accounting/capital-action'
import { bookAllNote, type BookAllVehicle } from '@/lib/accounting/backfill-note'
import { EmptyState } from '@/components/ui/empty-state'
import { AddVehicleButton } from '@/components/add-vehicle-button'

// THE FIRM-WIDE TABLE: every entity the caller may see, with the state of its books.
//
// This is what the separate "Firm overview" page used to be, and the reason it is no longer a page
// of its own is that it turned out to be the landing for EVERY section. `/funds/journal` has to
// answer "which vehicle's journal?", and the answer is a table of the vehicles.
//
// But it is one table, not one column set. Asked "which vehicle's journal?", the number that
// decides is how many drafts are waiting; asked "which vehicle's bank?", it is how many rows are
// unreconciled; asked "which schedule of investments?", it is what the vehicle holds. Showing all
// nine columns everywhere made every section's landing identical, so the question you arrived with
// was the one thing the page did not answer. COLUMNS below maps each section to the two or three
// figures that answer it; the firm-wide Admin page (section null) keeps the full set, because
// there the whole state of the books IS the question.
//
// Management companies are rows in it like anything else. They were a section of their own while
// their pages were a parallel copy of the fund ones; the pages are shared now, so the only thing
// left that is particular to a manco is that its chart has to be seeded before there is anything
// to open — which is the button on its row.

interface Row {
  id: string | null; name: string; kind: string | null
  closedThrough: string | null; lastEntryDate: string | null
  postedEntries: number; draftEntries: number; openBankRows: number
  trialBalanced: boolean; totalDebits: number; empty: boolean; cash: number
  investmentsAtCost: number; investmentsAtValue: number
  underivedTransactions: number
}
interface Overview { vehicles: Row[]; mancoOmitted: boolean }

/** What /api/manco/vehicles adds for a management company: whether its chart is seeded yet. */
interface MancoState {
  id: string; name: string; active: boolean
  accountCount: number; missingAccounts: number; chartSeeded: boolean; convertedFromOtherChart: boolean
}

const kindLabel = (k: string | null) => (k && isVehicleKind(k) ? VEHICLE_KIND_LABELS[k] : 'Fund')

/** Where a row's pages live. Every entity is addressed the same way, management company included. */
function baseFor(r: { id: string | null; name: string; kind: string | null }): string {
  return `/funds/${r.id ?? encodeURIComponent(r.name)}`
}

/**
 * Does this entity have a `<section>` page at all? Null section = the lead page, which every
 * entity has. Answered by the section's own `hideFor`, so a management company is filtered by
 * the same rule as an individual or a GP entity rather than by a list of its own.
 */
function hasSection(r: { kind: string | null }, section: string | null): boolean {
  return !section || hasSectionForKind(section, r.kind)
}

/** A row's link helper, closed over the row's base path and whether it can be linked at all. */
type LinkCell = (label: string | number, href: string, warn?: boolean) => React.ReactNode

interface Col {
  key: string
  label: string
  align?: 'right'
  cell: (r: Row, link: LinkCell, money: (n: number) => string) => React.ReactNode
}

const dash = <span className="text-muted-foreground">&mdash;</span>

const CLOSED: Col = {
  key: 'closed', label: 'Closed through',
  cell: (r, link) => (r.closedThrough ? link(r.closedThrough, '/periods') : <span className="text-muted-foreground">Never</span>),
}
const LAST_ENTRY: Col = {
  key: 'last', label: 'Last entry',
  cell: r => <span className="text-muted-foreground">{r.lastEntryDate ?? '—'}</span>,
}
const POSTED: Col = { key: 'posted', label: 'Posted', align: 'right', cell: (r, link) => link(r.postedEntries, '/journal') }
const DRAFTS: Col = {
  key: 'drafts', label: 'Drafts', align: 'right',
  cell: (r, link) => link(r.draftEntries, '/journal?status=draft', r.draftEntries > 0),
}
const BANK_OPEN: Col = {
  key: 'bank', label: 'Bank open', align: 'right',
  cell: (r, link) => link(r.openBankRows, '/bank', r.openBankRows > 0),
}
const CASH: Col = {
  key: 'cash', label: 'Cash', align: 'right',
  cell: (r, link, money) => (r.empty ? dash : link(money(r.cash), '/bank')),
}
const TOTAL_DEBITS: Col = {
  key: 'debits', label: 'Trial balance', align: 'right',
  cell: (r, link, money) => (r.empty ? dash : link(money(r.totalDebits), '/statements')),
}
const TIES: Col = {
  key: 'ties', label: 'Ties',
  cell: r =>
    r.empty
      ? <span className="text-muted-foreground">Empty</span>
      : r.trialBalanced
        ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" />Yes</span>
        : <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle className="h-3.5 w-3.5" />No</span>,
}
/** A vehicle whose tracker holds transactions the ledger does not carry says so, not "—". */
const notOnLedger = (r: Row, link: LinkCell) =>
  link(`${r.underivedTransactions} not on the ledger`, '/status#book-investments', true)

const AT_COST: Col = {
  key: 'cost', label: 'At cost', align: 'right',
  cell: (r, link, money) => (r.underivedTransactions > 0 && r.investmentsAtCost === 0
    ? notOnLedger(r, link)
    : r.empty ? dash : link(money(r.investmentsAtCost), '/schedule-of-investments')),
}
const AT_VALUE: Col = {
  key: 'value', label: 'At value', align: 'right',
  cell: (r, link, money) => (r.empty || (r.underivedTransactions > 0 && r.investmentsAtValue === 0)
    ? dash : link(money(r.investmentsAtValue), '/schedule-of-investments')),
}

/** The whole state of the books — the firm-wide Admin view, and the fallback for a section
 *  with no figures of its own (allocation terms, opening balances, a migration). */
const ALL: Col[] = [CLOSED, LAST_ENTRY, POSTED, DRAFTS, BANK_OPEN, TOTAL_DEBITS, TIES]

/** The two or three figures that answer "which entity?" for each section. */
const COLUMNS: Record<string, Col[]> = {
  status: ALL,
  journal: [DRAFTS, POSTED, LAST_ENTRY],
  bank: [BANK_OPEN, CASH, CLOSED],
  ledger: [POSTED, LAST_ENTRY, TOTAL_DEBITS],
  text: [DRAFTS, POSTED, LAST_ENTRY],
  periods: [CLOSED, DRAFTS, TIES],
  statements: [CLOSED, TOTAL_DEBITS, TIES],
  'capital-accounts': [CLOSED, LAST_ENTRY, POSTED],
  'schedule-of-investments': [AT_COST, AT_VALUE, LAST_ENTRY],
  construction: [AT_VALUE, AT_COST, CLOSED],
  tax: [CLOSED, LAST_ENTRY, TIES],
  // Actuals run through the last close; cash is what a forecast is mostly about.
  forecast: [CLOSED, CASH, LAST_ENTRY],
}

/**
 * The one-line summary above the table, counting what THIS section is waiting on. The firm-wide
 * view counts everything, because there the question is whether the books are done at all.
 */
function summaryFor(section: string | null, rows: Row[]): string | null {
  const live = rows.filter(r => !r.empty)
  const n = (count: number, one: string, many: string) =>
    count === 0 ? null : `${count} ${count === 1 ? 'entity' : 'entities'} ${count === 1 ? one : many}`
  switch (section) {
    case 'journal':
    case 'text':
      return n(live.filter(r => r.draftEntries > 0).length, 'has drafts waiting.', 'have drafts waiting.')
        ?? 'No drafts waiting anywhere.'
    case 'bank':
      return n(live.filter(r => r.openBankRows > 0).length, 'has bank rows to reconcile.', 'have bank rows to reconcile.')
        ?? 'Every bank row is reconciled.'
    case 'periods':
      return n(live.filter(r => !r.closedThrough).length, 'has never been closed.', 'have never been closed.')
        ?? 'Every entity with postings has been closed at least once.'
    case 'statements':
    case 'ledger':
      return n(live.filter(r => !r.trialBalanced).length, 'does not tie.', 'do not tie.')
        ?? 'Every trial balance ties.'
    case 'schedule-of-investments':
    case 'construction': {
      const holding = rows.filter(r => (!r.empty || r.underivedTransactions > 0) && (r.investmentsAtValue !== 0 || r.underivedTransactions > 0))
      const k = rows.filter(r => r.underivedTransactions > 0).length
      const base = n(holding.length, 'holds investments.', 'hold investments.') ?? 'No entity carries an investment balance.'
      return k > 0 ? `${base} ${k} ${k === 1 ? 'has' : 'have'} transactions not on the ledger yet.` : base
    }
    default: {
      const open = rows.filter(r => (!r.empty && (r.draftEntries > 0 || r.openBankRows > 0 || !r.trialBalanced)) || r.underivedTransactions > 0)
      return open.length === 0
        ? 'Nothing waiting: no drafts, no open bank rows, every trial balance ties.'
        : `${open.length} of ${rows.length} entities have something waiting.`
    }
  }
}

export function FirmVehiclesTable({
  section = null,
  showAdd = false,
  action = null,
}: {
  /** The subpage each row leads to (`journal`, `bank`, …), or null for the entity's lead page. */
  section?: string | null
  /** Offer the one Add vehicle button — the firm-wide Admin page carries it. */
  showAdd?: boolean
  /**
   * Carried onto each row's link. /start sends "issue a capital call" to the firm-wide capital
   * accounts landing, which is this table; without forwarding, picking the entity would drop the
   * request and land on a closed panel.
   */
  action?: CapitalAction | null
}) {
  const currency = useCurrency()
  const access = useAccess()
  const isAdmin = useIsAdmin()
  const canSeeBooks = access('accounting') !== 'none'
  const canSeeManco = access('management_company') !== 'none'

  const [data, setData] = useState<Overview | null>(null)
  const [manco, setManco] = useState<MancoState[]>([])
  const [loading, setLoading] = useState(true)
  const [booking, setBooking] = useState(false)
  const [bookError, setBookError] = useState<string | null>(null)
  const [bookNote, setBookNote] = useState<string | null>(null)

  // The backlog count costs queries per entity, so only the pages that show it ask for it.
  const withBacklog = section === null || section === 'status' || section === 'schedule-of-investments' || section === 'construction'

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      // The books of every entity — an `accounting` route. A manco-only bookkeeper cannot call it,
      // and gets the management companies alone from the second request rather than an error.
      canSeeBooks
        ? fetch(withBacklog ? '/api/accounting/firm?backlog=1' : '/api/accounting/firm').then(r => (r.ok ? r.json() : null)).catch(() => null)
        : Promise.resolve(null),
      canSeeManco
        ? fetch('/api/manco/vehicles').then(r => (r.ok ? r.json() : [])).catch(() => [])
        : Promise.resolve([]),
    ]).then(([firm, mancos]) => {
      setData(firm)
      setManco(Array.isArray(mancos) ? mancos : [])
    }).finally(() => setLoading(false))
  }, [canSeeBooks, canSeeManco, withBacklog])
  useEffect(() => { load() }, [load])

  async function bookAll() {
    setBooking(true); setBookError(null); setBookNote(null)
    try {
      const res = await fetch('/api/accounting/investments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'backfill', all: true }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setBookError(body?.error ?? 'Could not put the transactions on the ledger.')
        return
      }
      const note = bookAllNote((body?.vehicles ?? []) as BookAllVehicle[])
      if (note) setBookNote(note)
      load()
    } catch {
      setBookError('Could not put the transactions on the ledger.')
    } finally {
      setBooking(false)
    }
  }

  if (loading) {
    return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  // The books rows, plus any management company the firm route did not list (a caller who holds
  // the manco grant without fund accounting sees only these). Merged by id so a manco that IS on
  // the books list is not shown twice.
  const mancoById = new Map(manco.map(m => [m.id, m]))
  const rows: Row[] = [...(data?.vehicles ?? [])]
  const listed = new Set(rows.map(r => r.id).filter(Boolean))
  for (const m of manco) {
    if (listed.has(m.id)) continue
    rows.push({
      id: m.id, name: m.name, kind: 'manco',
      closedThrough: null, lastEntryDate: null, postedEntries: 0, draftEntries: 0, openBankRows: 0,
      trialBalanced: true, totalDebits: 0, empty: true, cash: 0,
      investmentsAtCost: 0, investmentsAtValue: 0, underivedTransactions: 0,
    })
  }
  const visible = rows.filter(r => hasSection(r, section))

  // Booking every entity's transactions is admin-only; the route enforces it, this just hides the button.
  const showBookAll = (section === null || section === 'status' || section === 'schedule-of-investments')
    && isAdmin && access('accounting') === 'write' && rows.some(r => r.underivedTransactions > 0)

  const addButton = showAdd ? <AddVehicleButton onCreated={load} /> : null

  if (visible.length === 0) {
    return (
      <EmptyState action={addButton}>
        {rows.length === 0
          ? 'No entities yet. Add a fund, SPV, GP entity, individual or management company to start keeping its books.'
          : 'None of the firm’s entities has this page.'}
      </EmptyState>
    )
  }

  const sectionLabel = section ? sectionForSlug(section)?.label ?? null : null
  const cols = (section && COLUMNS[section]) || ALL
  const summary = data ? summaryFor(section, visible) : null
  const money = (n: number) => formatCurrencyFull(n, currency)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {section
            ? <>Pick an entity to open its {sectionLabel ? sectionLabel.toLowerCase() : 'page'}. </>
            : null}
          {summary}
          {data?.mancoOmitted && !canSeeManco && ' Management companies are not shown; that needs the management-company grant.'}
        </p>
        <div className="flex items-center gap-2">
          {showBookAll && (
            <Button size="sm" variant="outline" onClick={bookAll} disabled={booking}>
              {booking ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}Put every entity&rsquo;s transactions on the ledger
            </Button>
          )}
          {addButton}
        </div>
      </div>

      {bookError && <p className="text-sm text-destructive">{bookError}</p>}
      {bookNote && <p className="text-sm text-muted-foreground">{bookNote}</p>}

      <div className="rounded-card border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Entity</th>
              <th className="text-left px-3 py-2 font-medium">Kind</th>
              {cols.map(c => (
                <th key={c.key} className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map(r => {
              const base = baseFor(r)
              const m = r.id ? mancoById.get(r.id) : undefined
              // A management company whose chart is not the manco chart yet has nothing to open:
              // its row offers the setup step where the link would be.
              const target = withCapitalAction(section ? `${base}/${section}` : base, action)
              const cell = (label: string | number, href: string, warn = false) => (
                <Link href={`${base}${href}`} className={warn ? 'text-warning hover:underline' : 'hover:underline'}>{label}</Link>
              )
              return (
                <tr key={r.id ?? r.name} className="border-t">
                  <td className="px-3 py-2 font-medium">
                    <Link href={target} className="hover:underline">{r.name}</Link>
                    {m && !m.active && (
                      <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground">Inactive</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{kindLabel(r.kind)}</td>
                  {cols.map(c => (
                    <td key={c.key} className={`px-3 py-2 tabular-nums ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                      {c.cell(r, cell, money)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button asChild variant="outline" size="sm">
                      <Link href={target}>Open <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
