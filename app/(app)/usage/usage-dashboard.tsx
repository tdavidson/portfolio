'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, Lock } from 'lucide-react'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { SourceFilter } from '@/components/audit/source-filter'
import { CHANGE_SOURCE_LABEL, type ChangeSourceKey } from '@/lib/audit/source-labels'

interface DailyRow {
  date: string
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  estimated_cost: number
}

interface ProviderMTD {
  input_tokens: number
  output_tokens: number
  estimated_cost: number
}

interface UserSummary {
  userId: string
  email: string
  displayName: string | null
  actions: Record<string, number>
  total: number
}

interface RecentActivity {
  userId: string
  email: string
  displayName: string | null
  action: string
  metadata: Record<string, unknown>
  source?: ChangeSourceKey | null
  createdAt: string
}

interface ActivityData {
  userSummary: UserSummary[]
  recent: RecentActivity[]
}

interface MonthlyRow {
  month: string
  input_tokens: number
  output_tokens: number
  estimated_cost: number
}

interface UsageData {
  daily: DailyRow[]
  monthly: MonthlyRow[]
  mtd: Record<string, ProviderMTD | number> & { total_estimated_cost: number }
  activity?: ActivityData
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatCost(n: number) {
  return `$${n.toFixed(4)}`
}

const ACTION_LABELS: Record<string, string> = {
  'login': 'Login',
  'logout': 'Logout',
  'company.create': 'Create Company',
  'company.update': 'Update Company',
  'company.summary': 'Generate Summary',
  'company.document_upload': 'Upload Document',
  'import.data': 'Import Data',
  'import.documents': 'Import Documents',
  'review.resolve': 'Resolve Review',
  'requests.send': 'Send Requests',
  'settings.update': 'Update Settings',
  'note.create': 'Create Note',
}

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action
}

function categorizeActions(actions: Record<string, number>) {
  let logins = 0
  let companies = 0
  let imports = 0
  let other = 0
  for (const [action, count] of Object.entries(actions)) {
    if (action === 'login' || action === 'logout') logins += count
    else if (action.startsWith('company.')) companies += count
    else if (action.startsWith('import.')) imports += count
    else other += count
  }
  return { logins, companies, imports, other }
}

function timeAgo(dateString: string) {
  const now = Date.now()
  const then = new Date(dateString).getTime()
  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function UsageDashboard() {
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activitySource, setActivitySource] = useState<ChangeSourceKey | null>(null)

  useEffect(() => {
    fetch('/api/usage')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load usage data')
        return res.json()
      })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const providers = Object.entries(data.mtd)
    .filter(([key]) => key !== 'total_estimated_cost')
    .map(([name, stats]) => ({ name, ...(stats as ProviderMTD) }))

  const totalCost = data.mtd.total_estimated_cost as number
  const now = new Date()
  const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' })

  const activity = data.activity

  return (
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Lock className="h-4 w-4 text-warning" />AI Usage</h1>
          <AnalystToggleButton />
        </div>
        <p className="text-sm text-muted-foreground">{monthLabel} &mdash; month to date</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full space-y-8">

      {/* MTD summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map(p => (
          <Card key={p.name}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium capitalize">{p.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-bold">{formatCost(p.estimated_cost)}</p>
              <p className="text-xs text-muted-foreground">
                {formatTokens(p.input_tokens)} input &middot; {formatTokens(p.output_tokens)} output
              </p>
            </CardContent>
          </Card>
        ))}
        {providers.length > 1 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Month total (estimated)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatCost(totalCost)}</p>
              <p className="text-xs text-muted-foreground">All providers combined</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Daily breakdown table */}
      <div>
        <h2 className="text-lg font-medium mb-3">Daily breakdown</h2>
        {data.daily.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI usage recorded this month.</p>
        ) : (
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left font-medium px-4 py-2.5">Date</th>
                  <th className="text-left font-medium px-4 py-2.5">Provider</th>
                  <th className="text-left font-medium px-4 py-2.5">Model</th>
                  <th className="text-right font-medium px-4 py-2.5">Input tokens</th>
                  <th className="text-right font-medium px-4 py-2.5">Output tokens</th>
                  <th className="text-right font-medium px-4 py-2.5">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-2.5">{row.date}</td>
                    <td className="px-4 py-2.5 capitalize">{row.provider}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{row.model}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.input_tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.output_tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCost(row.estimated_cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/50 font-medium">
                  <td className="px-4 py-2.5" colSpan={3}>Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{data.daily.reduce((s, r) => s + r.input_tokens, 0).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{data.daily.reduce((s, r) => s + r.output_tokens, 0).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCost(data.daily.reduce((s, r) => s + r.estimated_cost, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Monthly summary table */}
      {data.monthly.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-3">Monthly summary</h2>
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left font-medium px-4 py-2.5">Month</th>
                  <th className="text-right font-medium px-4 py-2.5">Input tokens</th>
                  <th className="text-right font-medium px-4 py-2.5">Output tokens</th>
                  <th className="text-right font-medium px-4 py-2.5">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.monthly.map((row) => {
                  const [y, m] = row.month.split('-')
                  const label = new Date(parseInt(y), parseInt(m) - 1).toLocaleString('default', { month: 'long', year: 'numeric' })
                  return (
                    <tr key={row.month} className="border-b last:border-0">
                      <td className="px-4 py-2.5">{label}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{row.input_tokens.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{row.output_tokens.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatCost(row.estimated_cost)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/50 font-medium">
                  <td className="px-4 py-2.5">Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{data.monthly.reduce((s, r) => s + r.input_tokens, 0).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{data.monthly.reduce((s, r) => s + r.output_tokens, 0).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCost(data.monthly.reduce((s, r) => s + r.estimated_cost, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* User activity disabled notice */}
      {!activity && (
        <div className="rounded-card border bg-muted/30 p-5">
          <p className="text-sm text-muted-foreground">
            Per-user activity tracking is turned off. AI token usage above is always recorded regardless of this setting.
            User activity logs (logins, actions, and the activity feed) can be enabled in{' '}
            <a href="/settings" className="underline underline-offset-4 hover:text-foreground">Settings</a>.
          </p>
        </div>
      )}

      {/* User Activity Summary */}
      {activity && activity.userSummary.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-3">User activity summary</h2>
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left font-medium px-4 py-2.5">User</th>
                  <th className="text-right font-medium px-4 py-2.5">Logins</th>
                  <th className="text-right font-medium px-4 py-2.5">Companies</th>
                  <th className="text-right font-medium px-4 py-2.5">Imports</th>
                  <th className="text-right font-medium px-4 py-2.5">Other</th>
                  <th className="text-right font-medium px-4 py-2.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {activity.userSummary.map(u => {
                  const cats = categorizeActions(u.actions)
                  return (
                    <tr key={u.userId} className="border-b last:border-0">
                      <td className="px-4 py-2.5">
                        <div>{u.displayName || u.email}</div>
                        {u.displayName && (
                          <div className="text-xs text-muted-foreground">{u.email}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{cats.logins}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{cats.companies}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{cats.imports}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{cats.other}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">{u.total}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Activity Feed */}
      {activity && activity.recent.length > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-medium">Recent activity</h2>
            <SourceFilter value={activitySource} onChange={setActivitySource} />
          </div>
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left font-medium px-4 py-2.5">Time</th>
                  <th className="text-left font-medium px-4 py-2.5">User</th>
                  <th className="text-left font-medium px-4 py-2.5">Action</th>
                  <th className="text-left font-medium px-4 py-2.5">Source</th>
                </tr>
              </thead>
              <tbody>
                {activity.recent.filter(e => !activitySource || e.source === activitySource).map((entry, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{timeAgo(entry.createdAt)}</td>
                    <td className="px-4 py-2.5">{entry.displayName || entry.email}</td>
                    <td className="px-4 py-2.5">{actionLabel(entry.action)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{entry.source ? CHANGE_SOURCE_LABEL[entry.source] : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
    <AnalystPanel />
    </div>
    </div>
  )
}
