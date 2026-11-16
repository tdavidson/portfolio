'use client'

import { Metric } from '@/components/ui/metric'
import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Loader2, LogIn, Eye, ArrowDownCircle, Search, Upload, BadgeCheck, MessageSquare } from 'lucide-react'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'

interface ActivityEvent {
  id: string
  createdAt: string
  eventType: 'login' | 'view' | 'download' | string
  targetType: 'portal' | 'snapshot' | 'letter' | 'document' | string
  targetId: string | null
  targetTitle: string | null
  personId: string | null
  personName: string
  personEmail: string | null
  personKind: string | null
  investorName: string | null
  /** Which way they came in: the web portal ('web'), or the investor connector ('mcp'). */
  source: string | null
}

interface Person {
  id: string
  name: string
  email: string | null
  kind: string | null
  logins: number
  views: number
  downloads: number
  total: number
  lastSeen: string
}

interface Summary {
  totalEvents: number
  logins: number
  views: number
  downloads: number
  activePeople: number
}

interface ActivityData {
  events: ActivityEvent[]
  people: Person[]
  summary: Summary
  days: number
  truncated: boolean
}

const RANGE_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 365, label: 'Last year' },
  { value: 3650, label: 'All time' },
]

// Event kinds are categories, not states — a download is not "success" and a login
// is not "info", which is what these used to say (plus a raw violet for download).
//
// They are not categorical slots either. Each kind already carries a distinct glyph
// AND a text label, so colour would be a third encoding of something already
// unambiguous. Validating the alternatives made the cost explicit: no three slots
// clear all-pairs separation in both themes at legible icon contrast without
// pulling in the red slot, which would paint "Download" as an error. Identity is
// in the glyph; the icons stay in muted ink.
const EVENT_META: Record<string, { label: string; icon: typeof Eye; className: string }> = {
  login: { label: 'Login', icon: LogIn, className: 'text-muted-foreground' },
  view: { label: 'View', icon: Eye, className: 'text-muted-foreground' },
  download: { label: 'Download', icon: ArrowDownCircle, className: 'text-muted-foreground' },
  upload: { label: 'Upload', icon: Upload, className: 'text-info' },
  acknowledge: { label: 'Wire acknowledged', icon: BadgeCheck, className: 'text-muted-foreground' },
  message: { label: 'Message', icon: MessageSquare, className: 'text-muted-foreground' },
}

const TARGET_LABELS: Record<string, string> = {
  portal: 'Portal',
  snapshot: 'Statement',
  letter: 'Letter',
  document: 'Document',
  capital_call: 'Capital call',
}

function formatDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return formatDateTime(iso)
}

export function LpActivityDashboard() {
  const [data, setData] = useState<ActivityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [days, setDays] = useState(90)
  const [search, setSearch] = useState('')
  const [personFilter, setPersonFilter] = useState('all')
  const [eventFilter, setEventFilter] = useState('all')
  const [targetFilter, setTargetFilter] = useState('all')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/lp-activity?days=${days}`)
      .then(res => { if (!res.ok) throw new Error('Failed to load LP activity'); return res.json() })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [days])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.events.filter(e => {
      if (personFilter !== 'all' && e.personId !== personFilter) return false
      if (eventFilter !== 'all' && e.eventType !== eventFilter) return false
      if (targetFilter !== 'all' && e.targetType !== targetFilter) return false
      if (q) {
        const hay = `${e.personName} ${e.personEmail ?? ''} ${e.targetTitle ?? ''} ${e.investorName ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [data, search, personFilter, eventFilter, targetFilter])

  const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-sm'

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-2xl font-semibold tracking-tight">LP Activity</h1>
        <AnalystToggleButton />
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Logins, views, and downloads by your LPs and their authorized users in the investor portal.
      </p>

      {/* Content and the Analyst side by side at lg, as on every other page with the panel. */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-12">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading activity…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-card border border-destructive/40 bg-destructive/5 text-destructive text-sm p-4">{error}</div>
      )}

      {data && !loading && (
        <>
          {/* Summary tiles: the app's KPI tile (components/ui/metric.tsx). */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Metric label="Active LPs & users" value={data.summary.activePeople} />
            <Metric label="Logins" value={data.summary.logins} />
            <Metric label="Views" value={data.summary.views} />
            <Metric label="Downloads" value={data.summary.downloads} />
          </div>

          {/* Per-person rollup */}
          {data.people.length > 0 && (
            <div className="mb-8">
              <h2 className="text-base font-semibold mb-2">By person</h2>
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Person</th>
                      <th className="px-4 py-2.5 font-medium">Role</th>
                      <th className="px-4 py-2.5 font-medium text-right">Logins</th>
                      <th className="px-4 py-2.5 font-medium text-right">Views</th>
                      <th className="px-4 py-2.5 font-medium text-right">Downloads</th>
                      <th className="px-4 py-2.5 font-medium">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map(p => (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30 cursor-pointer" onClick={() => setPersonFilter(p.id === personFilter ? 'all' : p.id)}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{p.name}</div>
                          {p.email && p.email !== p.name && <div className="text-xs text-muted-foreground">{p.email}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{p.kind === 'authorized_user' ? 'Authorized user' : 'LP'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{p.logins}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{p.views}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{p.downloads}</td>
                        <td className="px-4 py-2.5 text-muted-foreground" title={formatDateTime(p.lastSeen)}>{formatRelative(p.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search person or document…" className="h-8 pl-8 text-sm" />
            </div>
            <select className={selectClass} value={personFilter} onChange={e => setPersonFilter(e.target.value)}>
              <option value="all">All people</option>
              {data.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className={selectClass} value={eventFilter} onChange={e => setEventFilter(e.target.value)}>
              <option value="all">All events</option>
              <option value="login">Logins</option>
              <option value="view">Views</option>
              <option value="download">Downloads</option>
            </select>
            <select className={selectClass} value={targetFilter} onChange={e => setTargetFilter(e.target.value)}>
              <option value="all">All types</option>
              <option value="snapshot">Statements</option>
              <option value="letter">Letters</option>
              <option value="document">Documents</option>
              <option value="portal">Portal</option>
            </select>
            <select className={selectClass} value={days} onChange={e => setDays(Number(e.target.value))}>
              {RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Event feed */}
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Person</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 font-medium">Investor</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => {
                  const meta = EVENT_META[e.eventType]
                  const Icon = meta?.icon ?? Eye
                  return (
                    <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap" title={formatDateTime(e.createdAt)}>{formatRelative(e.createdAt)}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium">{e.personName}</div>
                        {e.personKind === 'authorized_user' && <div className="text-xs text-muted-foreground">Authorized user</div>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1.5 ${meta?.className ?? ''}`}>
                          <Icon className="h-3.5 w-3.5" /> {meta?.label ?? e.eventType}
                        </span>
                        {e.source === 'mcp' && <div className="text-xs text-muted-foreground">Through Claude or ChatGPT</div>}
                      </td>
                      <td className="px-4 py-2.5">
                        {e.eventType === 'login' ? (
                          <span className="text-muted-foreground">Logged in</span>
                        ) : (
                          <>
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1.5">{TARGET_LABELS[e.targetType] ?? e.targetType}</span>
                            {e.targetTitle ?? '—'}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{e.investorName ?? '—'}</td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">No activity matches your filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 text-xs text-muted-foreground">
            Showing {filtered.length} of {data.events.length} events
            {data.truncated && ` (capped at ${data.events.length} — narrow the date range to see more)`}.
          </div>
        </>
      )}

      </div>
      <AnalystPanel />
      </div>
    </div>
  )
}
