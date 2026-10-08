// components/fund-holding-navs.tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCurrency, formatCurrency } from '@/components/currency-context'

export interface NavStatementRow {
  id: string
  as_of_date: string
  reported_nav: number
  basis: 'final' | 'preliminary' | 'estimate'
  /** The mark this statement booked; null when there was nothing to book or it was refused. */
  investment_transaction_id: string | null
  /** The entity it is for; a statement naming none is saved but never booked. */
  vehicle_id?: string | null
}

/** What the ledger holds for a statement, as far as the row can tell. */
function ledgerLabel(n: NavStatementRow): { text: string; title?: string } {
  if (n.investment_transaction_id) return { text: 'Mark booked' }
  if (n.vehicle_id === null) return { text: 'Not booked', title: 'This statement names no entity, so it books nothing.' }
  return { text: 'No mark', title: 'Either the ledger already carried this value, or the mark was refused — the message when it was saved says which.' }
}

/**
 * A holding's manager NAV statements, newest first, each editable and deletable. The valuation date
 * is not editable: a statement for another date is another statement — delete it and record it again.
 */
export function FundHoldingNavs({ navs, busy, readOnly = false, onEdit, onDelete, onRebook }: {
  navs: NavStatementRow[]
  busy: boolean
  /** Hides edit and delete for a member who can only read. */
  readOnly?: boolean
  /** Resolves true when the server accepted the change; the edit row closes only then. */
  onEdit: (navId: string, fields: { reportedNav: number; basis: string }) => void | boolean | Promise<void | boolean>
  onDelete: (navId: string) => void
  /**
   * Re-books the newest statement's mark against what the ledger carries now — for a mark left
   * stale by a later change to the ledger. Omitted (or read-only): no button.
   */
  onRebook?: () => void
}) {
  const currency = useCurrency()
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ reportedNav: '', basis: 'final' })

  if (navs.length === 0) {
    return <p className="text-sm text-muted-foreground">No statements received — the position carries at cost.</p>
  }

  const start = (n: NavStatementRow) => { setEditing(n.id); setForm({ reportedNav: String(n.reported_nav), basis: n.basis }) }
  const save = async (id: string) => {
    const reportedNav = Number(form.reportedNav)
    if (form.reportedNav === '' || !Number.isFinite(reportedNav)) return
    const ok = await onEdit(id, { reportedNav, basis: form.basis })
    if (ok !== false) setEditing(null)
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>As of</TableHead>
          <TableHead className="text-right">Reported NAV</TableHead>
          <TableHead>Basis</TableHead>
          <TableHead>Ledger</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {navs.map((n, i) => editing === n.id ? (
          <TableRow key={n.id}>
            <TableCell className="tabular-nums">{n.as_of_date}</TableCell>
            <TableCell className="text-right">
              <Input
                aria-label="Reported NAV" type="number" className="tabular-nums h-8 w-36 ml-auto"
                value={form.reportedNav} onChange={e => setForm(f => ({ ...f, reportedNav: e.target.value }))}
              />
            </TableCell>
            <TableCell>
              <select
                aria-label="Basis" value={form.basis} onChange={e => setForm(f => ({ ...f, basis: e.target.value }))}
                className="border rounded-lg px-2 py-1 text-sm h-8 bg-background"
              >
                <option value="final">Final</option>
                <option value="preliminary">Preliminary</option>
                <option value="estimate">Estimate</option>
              </select>
            </TableCell>
            <TableCell />
            <TableCell className="text-right space-x-2 whitespace-nowrap">
              <Button size="sm" disabled={busy} onClick={() => save(n.id)}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </TableCell>
          </TableRow>
        ) : (
          <TableRow key={n.id}>
            <TableCell className="tabular-nums">{n.as_of_date}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(Number(n.reported_nav), currency)}</TableCell>
            <TableCell className="capitalize">{n.basis}</TableCell>
            <TableCell className="text-xs text-muted-foreground" title={ledgerLabel(n).title}>{ledgerLabel(n).text}</TableCell>
            <TableCell className="text-right space-x-2 whitespace-nowrap">
              {/* Newest first, so row 0 is the newest statement: the one whose mark the books end at. */}
              {!readOnly && onRebook && i === 0 && n.vehicle_id !== null && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onRebook}>Re-book mark</Button>
              )}
              {!readOnly && <Button size="sm" variant="outline" disabled={busy} onClick={() => start(n)}>Edit</Button>}
              {!readOnly && <Button size="sm" variant="outline" disabled={busy} onClick={() => onDelete(n.id)}>Delete</Button>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
