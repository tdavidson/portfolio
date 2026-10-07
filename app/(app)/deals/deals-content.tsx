'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Lock, Search, ExternalLink, Table as TableIcon, Columns3, ChevronUp, ChevronDown, Copy, Check, Plus, Loader2, ChevronsUpDown } from 'lucide-react'
import { useFeatureVisibility } from '@/components/feature-visibility-context'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { STATUS_OPTIONS, DEFAULT_STATUSES, STATUS_ORDER } from '@/lib/deals/statuses'
import { EntityPicker } from '@/components/entity-picker'

interface Deal {
  id: string
  email_id: string
  company_name: string | null
  company_url: string | null
  company_domain: string | null
  founder_name: string | null
  founder_email: string | null
  intro_source: string | null
  referrer_name: string | null
  thesis_fit_score: 'strong' | 'moderate' | 'weak' | 'out_of_thesis' | 'spam' | null
  stage: string | null
  industry: string | null
  raise_amount: string | null
  status: 'new' | 'reviewing' | 'advancing' | 'met' | 'diligence' | 'invested' | 'passed'
  prior_deal_id: string | null
  created_at: string
}

const FIT_BADGE: Record<string, { label: string; cls: string }> = {
  strong: { label: 'Strong', cls: 'bg-success-subtle dark:bg-success-subtle/30 text-success' },
  moderate: { label: 'Moderate', cls: 'bg-warning-subtle dark:bg-warning-subtle/30 text-warning' },
  weak: { label: 'Weak', cls: 'bg-muted text-muted-foreground' },
  out_of_thesis: { label: 'Out', cls: 'bg-destructive-subtle dark:bg-destructive-subtle/30 text-destructive' },
  spam: { label: 'Spam', cls: 'bg-muted text-muted-foreground line-through' },
}

const FIT_OPTIONS = ['strong', 'moderate', 'weak', 'out_of_thesis', 'spam']

// The sources a human can pick from.
const SOURCE_OPTIONS = ['referral', 'cold', 'warm_intro', 'accelerator', 'demo_day', 'event', 'other']

type ViewMode = 'table' | 'board'
type SortKey = 'date' | 'company' | 'founder' | 'source' | 'fit' | 'status'
interface SortState { key: SortKey; dir: 'asc' | 'desc' }

const FIT_ORDER: Record<NonNullable<Deal['thesis_fit_score']>, number> = {
  spam: 0,
  out_of_thesis: 1,
  weak: 2,
  moderate: 3,
  strong: 4,
}
export function DealsContent({ initialDeals }: { initialDeals: Deal[] }) {
  const fv = useFeatureVisibility()
  const [deals, setDeals] = useState<Deal[]>(initialDeals)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<Deal['status'][]>(DEFAULT_STATUSES)
  const [fitFilter, setFitFilter] = useState<string>('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [view, setView] = useState<ViewMode>('table')
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' })
  const [inboundAddress, setInboundAddress] = useState('')
  const [copied, setCopied] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(s => {
      if (s?.postmarkInboundAddress) setInboundAddress(s.postmarkInboundAddress)
    }).catch(() => {})
  }, [])

  function toggleSort(key: SortKey) {
    setSort(prev => {
      if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      // Default direction per column: date defaults desc (newest first); others asc.
      return { key, dir: key === 'date' ? 'desc' : 'asc' }
    })
  }

  // Refetch when filters change. Selecting nothing means nothing matches, so don't
  // bother the server — an empty `status` param would be read as "no filter" and
  // return every deal, which is the opposite of what was asked for.
  useEffect(() => {
    if (statusFilter.length === 0) { setDeals([]); return }
    const params = new URLSearchParams()
    if (statusFilter.length < STATUS_OPTIONS.length) params.set('status', statusFilter.join(','))
    if (fitFilter) params.set('fit_score', fitFilter)
    if (sourceFilter) params.set('intro_source', sourceFilter)
    params.set('limit', '500')
    fetch(`/api/deals?${params.toString()}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Deal[]) => setDeals(data))
      .catch(() => {})
  }, [statusFilter, fitFilter, sourceFilter])

  const filtered = useMemo(() => {
    if (!search.trim()) return deals
    const q = search.trim().toLowerCase()
    return deals.filter(d =>
      (d.company_name?.toLowerCase().includes(q)) ||
      (d.founder_name?.toLowerCase().includes(q)) ||
      (d.founder_email?.toLowerCase().includes(q))
    )
  }, [deals, search])

  const sorted = useMemo(() => {
    const out = [...filtered]
    const dir = sort.dir === 'asc' ? 1 : -1
    out.sort((a, b) => {
      const cmp = compareDeals(a, b, sort.key)
      // Tiebreaker: newer first so the order stays stable when keys tie.
      if (cmp === 0) return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      return cmp * dir
    })
    return out
  }, [filtered, sort])

  async function updateStatus(id: string, status: Deal['status']) {
    const prev = deals
    // Optimistic — and if the new status isn't in the filter, the deal leaves the view.
    // Anything else would show a "Passed" row under a filter that excludes Passed.
    setDeals(d => d
      .map(x => x.id === id ? { ...x, status } : x)
      .filter(x => statusFilter.includes(x.status)))
    const res = await fetch(`/api/deals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (!res.ok) setDeals(prev)
  }

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {fv.deals === 'admin' && <Lock className="h-4 w-4 text-warning" />}
            Deals
          </h1>
          <p className="text-sm text-muted-foreground">Inbound pitches screened against your fund thesis.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border rounded-md overflow-hidden bg-card">
            <button
              onClick={() => setView('table')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === 'table' ? 'bg-muted' : 'hover:bg-muted/50'}`}
            >
              <TableIcon className="h-3.5 w-3.5" /> Table
            </button>
            <button
              onClick={() => setView('board')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 border-l ${view === 'board' ? 'bg-muted' : 'hover:bg-muted/50'}`}
            >
              <Columns3 className="h-3.5 w-3.5" /> Board
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Deal
          </Button>
        </div>
      </div>

      <NewDealDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(dealId) => {
        setCreateOpen(false)
        if (dealId) router.push(`/deals/${dealId}`)
        else router.refresh()
      }} />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search company, founder, or email"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-9 w-72"
          />
        </div>
        <StatusFilter value={statusFilter} onChange={setStatusFilter} />
        <select
          value={fitFilter}
          onChange={e => setFitFilter(e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm"
        >
          <option value="">All fit scores</option>
          {FIT_OPTIONS.map(o => <option key={o} value={o}>{FIT_BADGE[o].label}</option>)}
        </select>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm"
        >
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map(o => <option key={o} value={o}>{labelFor(o)}</option>)}
        </select>
        {inboundAddress && (
          <div className="ml-auto flex items-center gap-1.5">
            <Input
              type="text"
              readOnly
              value={inboundAddress}
              title="Forward inbound pitches to this address"
              className="h-9 w-64 text-sm bg-muted text-muted-foreground cursor-default"
              tabIndex={-1}
            />
            <button
              onClick={() => {
                navigator.clipboard.writeText(inboundAddress)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="h-9 px-2 text-muted-foreground hover:text-foreground transition-colors"
              title="Copy to clipboard"
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>

      {view === 'board' ? (
        <DealsBoard deals={filtered} onMove={updateStatus} />
      ) : (
      <div className="rounded-md border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left text-xs uppercase text-muted-foreground">
              <SortableTh label="Date"     sortKey="date"     sort={sort} onToggle={toggleSort} />
              <SortableTh label="Company"  sortKey="company"  sort={sort} onToggle={toggleSort} />
              <SortableTh label="Founder"  sortKey="founder"  sort={sort} onToggle={toggleSort} />
              <SortableTh label="Source"   sortKey="source"   sort={sort} onToggle={toggleSort} />
              <SortableTh label="Fit"      sortKey="fit"      sort={sort} onToggle={toggleSort} />
              <SortableTh label="Status"   sortKey="status"   sort={sort} onToggle={toggleSort} />
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-muted-foreground">
                  {statusFilter.length === 0
                    ? 'No statuses selected — pick at least one to see deals.'
                    : statusFilter.length < STATUS_OPTIONS.length
                      ? <>No deals match this filter. <button onClick={() => setStatusFilter([...STATUS_OPTIONS])} className="underline underline-offset-2 hover:text-foreground">Show all statuses</button>.</>
                      : "No deals yet. When inbound pitches arrive, they'll appear here."}
                </td>
              </tr>
            ) : sorted.map(d => (
              <tr key={d.id} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                  {new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
                <td className="px-3 py-2">
                  <Link href={`/deals/${d.id}`} className="font-medium hover:underline">
                    {d.company_name ?? '—'}
                  </Link>
                  {d.stage && <span className="ml-2 text-xs text-muted-foreground">{d.stage}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{d.founder_name ?? '—'}</div>
                  {d.founder_email && (
                    <div className="text-xs text-muted-foreground">{d.founder_email}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {d.intro_source ? labelFor(d.intro_source) : '—'}
                  {d.referrer_name && <div className="text-muted-foreground">{d.referrer_name}</div>}
                </td>
                <td className="px-3 py-2">
                  {d.thesis_fit_score && (
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${FIT_BADGE[d.thesis_fit_score].cls}`}>
                      {FIT_BADGE[d.thesis_fit_score].label}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={d.status}
                    onChange={e => updateStatus(d.id, e.target.value as Deal['status'])}
                    className="h-7 px-2 rounded border border-input bg-background text-xs"
                  >
                    {STATUS_OPTIONS.map(s => (
                      <option key={s} value={s}>{labelFor(s)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-right">
                  <Link href={`/deals/${d.id}`} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                    View <ExternalLink className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {sorted.length > 0 && view === 'table' && (
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => exportCsv(sorted)}>
            Export CSV
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status filter — any set of statuses, not one or all. A native <select multiple>
// can technically do this but needs ctrl-click to add a second option, which nobody
// discovers; checkboxes make "and also show passed" a single click.
// ---------------------------------------------------------------------------

function StatusFilter({ value, onChange }: {
  value: Deal['status'][]
  onChange: (v: Deal['status'][]) => void
}) {
  const [open, setOpen] = useState(false)

  const isDefault = value.length === DEFAULT_STATUSES.length && DEFAULT_STATUSES.every(s => value.includes(s))
  const label =
    value.length === 0 ? 'No statuses'
    : value.length === STATUS_OPTIONS.length ? 'All statuses'
    : isDefault ? 'Active deals'
    : value.length === 1 ? labelFor(value[0])
    : `${value.length} statuses`

  function toggle(s: Deal['status']) {
    onChange(value.includes(s) ? value.filter(x => x !== s) : [...value, s])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`h-9 px-3 rounded-md border bg-background text-sm inline-flex items-center gap-1.5 hover:bg-muted/50 ${isDefault ? 'border-input' : 'border-foreground/30'}`}
        >
          {label}
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        <div className="flex items-center gap-1 px-1 pb-1.5 mb-1 border-b text-xs">
          <button onClick={() => onChange(DEFAULT_STATUSES)} className="px-1.5 py-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground">Active</button>
          <button onClick={() => onChange([...STATUS_OPTIONS])} className="px-1.5 py-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground">All</button>
          <button onClick={() => onChange([])} className="px-1.5 py-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground">None</button>
        </div>
        {STATUS_OPTIONS.map(s => (
          <label
            key={s}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer hover:bg-muted"
          >
            <input
              type="checkbox"
              checked={value.includes(s)}
              onChange={() => toggle(s)}
              className="h-3.5 w-3.5 rounded border-input accent-foreground"
            />
            <span>{labelFor(s)}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  )
}

const BOARD_COLUMNS: { status: Deal['status']; label: string }[] = [
  { status: 'new', label: 'New' },
  { status: 'reviewing', label: 'Reviewing' },
  { status: 'advancing', label: 'Advancing' },
  { status: 'met', label: 'Met' },
  { status: 'diligence', label: 'Diligence' },
  { status: 'invested', label: 'Invested' },
  { status: 'passed', label: 'Passed' },
]

function DealsBoard({ deals, onMove }: { deals: Deal[]; onMove: (id: string, status: Deal['status']) => void }) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<Deal['status'] | null>(null)

  function handleDragStart(e: React.DragEvent, id: string) {
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }

  function handleDragEnd() {
    setDraggingId(null)
    setOverColumn(null)
  }

  function handleDragOver(e: React.DragEvent, status: Deal['status']) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverColumn(status)
  }

  function handleDrop(e: React.DragEvent, status: Deal['status']) {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain') || draggingId
    if (id) {
      const deal = deals.find(d => d.id === id)
      if (deal && deal.status !== status) onMove(id, status)
    }
    setDraggingId(null)
    setOverColumn(null)
  }

  return (
    <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${BOARD_COLUMNS.length}, minmax(220px, 1fr))`, minWidth: `${BOARD_COLUMNS.length * 220}px` }}>
      {BOARD_COLUMNS.map(col => {
        const colDeals = deals.filter(d => d.status === col.status)
        const isOver = overColumn === col.status
        return (
          <div
            key={col.status}
            onDragOver={e => handleDragOver(e, col.status)}
            onDragLeave={() => setOverColumn(null)}
            onDrop={e => handleDrop(e, col.status)}
            className={`rounded-md border bg-card flex flex-col min-h-[400px] transition-colors ${isOver ? 'ring-2 ring-primary border-primary' : ''}`}
          >
            <div className="p-2 border-b flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{col.label}</span>
              <span className="text-xs text-muted-foreground">{colDeals.length}</span>
            </div>
            <div className="p-2 space-y-2 flex-1 overflow-y-auto">
              {colDeals.length === 0 ? (
                <div className="text-xs text-muted-foreground/60 italic px-1 py-4 text-center">drop here</div>
              ) : colDeals.map(d => (
                <div
                  key={d.id}
                  draggable
                  onDragStart={e => handleDragStart(e, d.id)}
                  onDragEnd={handleDragEnd}
                  className={`rounded border bg-background p-2 cursor-grab active:cursor-grabbing hover:border-primary/50 ${draggingId === d.id ? 'opacity-40' : ''}`}
                >
                  <Link href={`/deals/${d.id}`} className="block" onClick={e => { if (draggingId) e.preventDefault() }}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-sm truncate">{d.company_name ?? '—'}</div>
                      {d.thesis_fit_score && (
                        <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${FIT_BADGE[d.thesis_fit_score].cls}`}>
                          {FIT_BADGE[d.thesis_fit_score].label}
                        </span>
                      )}
                    </div>
                    {d.founder_name && <div className="text-xs text-muted-foreground truncate">{d.founder_name}</div>}
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                      {d.intro_source && <span>{labelFor(d.intro_source)}</span>}
                      {d.stage && <span>· {d.stage}</span>}
                      <span className="ml-auto">{new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}

function SortableTh({ label, sortKey, sort, onToggle }: {
  label: string
  sortKey: SortKey
  sort: SortState
  onToggle: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <th className="px-3 py-2 font-medium select-none">
      <button
        onClick={() => onToggle(sortKey)}
        className="inline-flex items-center gap-1 uppercase hover:text-foreground"
      >
        <span>{label}</span>
        {active && (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </button>
    </th>
  )
}

function compareDeals(a: Deal, b: Deal, key: SortKey): number {
  switch (key) {
    case 'date':    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    case 'company': return strCmp(a.company_name, b.company_name)
    case 'founder': return strCmp(a.founder_name, b.founder_name)
    case 'source':  return strCmp(a.intro_source, b.intro_source)
    case 'fit': {
      const av = a.thesis_fit_score ? FIT_ORDER[a.thesis_fit_score] : -1
      const bv = b.thesis_fit_score ? FIT_ORDER[b.thesis_fit_score] : -1
      return av - bv
    }
    case 'status':  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  }
}

function strCmp(a: string | null, b: string | null): number {
  // Null / empty values sort to the bottom on asc.
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

function labelFor(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function exportCsv(deals: Deal[]) {
  const headers = ['Date', 'Company', 'Founder', 'Email', 'Source', 'Referrer', 'Fit', 'Stage', 'Industry', 'Raise', 'Status']
  const rows = deals.map(d => [
    d.created_at,
    d.company_name ?? '',
    d.founder_name ?? '',
    d.founder_email ?? '',
    d.intro_source ?? '',
    d.referrer_name ?? '',
    d.thesis_fit_score ?? '',
    d.stage ?? '',
    d.industry ?? '',
    d.raise_amount ?? '',
    d.status,
  ])
  const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `deals-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function escape(v: string): string {
  if (v.includes('"') || v.includes(',') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

// ---------------------------------------------------------------------------
// New Deal dialog — admin-entered pitch with optional file uploads. Posts as
// multipart/form-data to /api/deals/manual which composes a synthetic email
// and runs the same processDeal pipeline as Postmark webhooks.
// ---------------------------------------------------------------------------

function NewDealDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (dealId: string | null) => void
}) {
  const [companyName, setCompanyName] = useState('')
  const [companyUrl, setCompanyUrl] = useState('')
  const [founderName, setFounderName] = useState('')
  const [founderEmail, setFounderEmail] = useState('')
  const [introSource, setIntroSource] = useState('')
  const [referrerName, setReferrerName] = useState('')
  const [referrerEmail, setReferrerEmail] = useState('')
  const [pitch, setPitch] = useState('')
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setCompanyName(''); setCompanyUrl(''); setFounderName(''); setFounderEmail('')
    setIntroSource(''); setReferrerName(''); setReferrerEmail('')
    setPitch(''); setVehicleId(null); setFiles([]); setError(null)
  }

  const canSubmit = !!companyName.trim() && !!founderName.trim() && !!founderEmail.trim() && !!pitch.trim() && !submitting

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('company_name', companyName.trim())
      form.append('founder_name', founderName.trim())
      form.append('founder_email', founderEmail.trim())
      if (companyUrl.trim()) form.append('company_url', companyUrl.trim())
      if (introSource) form.append('intro_source', introSource)
      if (referrerName.trim()) form.append('referrer_name', referrerName.trim())
      if (referrerEmail.trim()) form.append('referrer_email', referrerEmail.trim())
      form.append('pitch', pitch.trim())
      if (vehicleId) form.append('vehicle_id', vehicleId)
      for (const f of files) form.append('files', f)

      const res = await fetch('/api/deals/manual', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Create failed')
      reset()
      onCreated(body.deal_id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription>Enter pitch details directly. The same AI screener runs as on inbound emails: thesis fit, dedupe, prior-deal check.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">For entity</label>
            <EntityPicker value={vehicleId} onChange={setVehicleId} allowUnassigned />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Company name *</label>
              <Input value={companyName} onChange={e => setCompanyName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Company URL</label>
              <Input value={companyUrl} onChange={e => setCompanyUrl(e.target.value)} placeholder="https://..." />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Founder name *</label>
              <Input value={founderName} onChange={e => setFounderName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Founder email *</label>
              <Input type="email" value={founderEmail} onChange={e => setFounderEmail(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Intro source</label>
              <select
                value={introSource}
                onChange={e => setIntroSource(e.target.value)}
                className="h-9 w-full px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="">(none)</option>
                {SOURCE_OPTIONS.map(o => <option key={o} value={o}>{labelFor(o)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Referrer name</label>
              <Input value={referrerName} onChange={e => setReferrerName(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Referrer email</label>
            <Input type="email" value={referrerEmail} onChange={e => setReferrerEmail(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Pitch / description *</label>
            <textarea
              value={pitch}
              onChange={e => setPitch(e.target.value)}
              rows={5}
              placeholder="What the company does, traction, ask, anything you'd normally put in an intro email."
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Attachments (optional)</label>
            <label className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md border bg-card text-sm hover:bg-muted/50 cursor-pointer ${submitting ? 'opacity-50 pointer-events-none' : ''}`}>
              <Plus className="h-3.5 w-3.5" />
              {files.length === 0 ? 'Choose files' : `${files.length} file${files.length === 1 ? '' : 's'} selected`}
              <input
                type="file"
                multiple
                className="hidden"
                disabled={submitting}
                onChange={e => setFiles(e.target.files ? Array.from(e.target.files) : [])}
              />
            </label>
            {files.length > 0 && (
              <ul className="mt-2 text-[11px] text-muted-foreground space-y-0.5 max-h-20 overflow-y-auto">
                {files.map((f, i) => <li key={i} className="truncate">{f.name}</li>)}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">Pitch deck, one-pager, financial model. Up to 10 files, 10MB each.</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button variant="outline" onClick={submit} disabled={!canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Create deal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

