'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, FileText, Mail, Download, ArrowLeft, Eye, ChevronRight, ExternalLink, ShieldCheck, MessageSquare, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppFooter } from '@/components/app-footer'
import { OverviewView } from '@/components/portal/overview-view'
import { ActivityView } from '@/components/portal/activity-view'
import type { ActivityLine } from '@/lib/portal/activity'
import type { OverviewMetrics } from '@/lib/lp-overview'

interface Investor { id: string; name: string }
interface Snapshot { id: string; name: string; as_of_date: string | null }
interface Letter { id: string; period_label: string; period_year: number; period_quarter: number }
interface Doc { id: string; title: string; file_name: string; size_bytes: number | null; category: string | null; doc_date: string | null; uploaded_at: string; scope: string; sample: boolean }
interface Preview { investor: { id: string; name: string }; fund: { name: string; logo_url: string | null }; currency?: string; overview?: OverviewMetrics | null; activity?: { lines: ActivityLine[]; multipleEntities: boolean } | null; portal_enabled: boolean; snapshots: Snapshot[]; letters: Letter[]; documents: Doc[] }

const SCOPE_ORDER: { key: string; label: string }[] = [
  { key: 'fund', label: 'Fund documents' },
  { key: 'investor', label: 'Your documents' },
]

function fmtSize(b: number | null): string {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
function fmtDate(s: string | null): string {
  if (!s) return ''
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const effective = (d: Doc) => d.doc_date || d.uploaded_at || ''

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}
function Empty({ label }: { label: string }) {
  return <div className="rounded-card border bg-card p-8 text-center text-sm text-muted-foreground">{label}</div>
}

export default function LpPortalPreviewPage() {
  const [investors, setInvestors] = useState<Investor[]>([])
  const [investorId, setInvestorId] = useState('sample')
  const [data, setData] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'overview' | 'activity' | 'library' | 'settings' | 'contact'>('overview')
  const [downloading, setDownloading] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/lps/investors')
      .then(r => (r.ok ? r.json() : []))
      .then(d => setInvestors((Array.isArray(d) ? d : []).map((i: any) => ({ id: i.id, name: i.name }))))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!investorId) { setData(null); return }
    setLoading(true)
    fetch(`/api/lps/preview?investor_id=${investorId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false))
  }, [investorId])

  async function download(id: string) {
    setDownloading(id)
    try {
      const r = await fetch(`/api/lps/preview/document/${id}`)
      if (r.ok) { const { url } = await r.json(); if (url) window.open(url, '_blank', 'noopener') }
    } finally { setDownloading(null) }
  }

  async function downloadReport(s: Snapshot) {
    setDownloading(s.id)
    try {
      const res = await fetch(`/api/lps/preview/snapshot/${s.id}/pdf?investor_id=${investorId}`)
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${s.name}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally { setDownloading(null) }
  }

  // scope -> docs (flat, newest first); category shown inline on each row.
  const groupedDocs = useMemo(() => {
    const byScope = new Map<string, Doc[]>()
    for (const d of (data?.documents ?? [])) {
      const s = d.scope === 'investor' ? 'investor' : 'fund'
      if (!byScope.has(s)) byScope.set(s, [])
      byScope.get(s)!.push(d)
    }
    for (const arr of Array.from(byScope.values())) arr.sort((a, b) => effective(b).localeCompare(effective(a)))
    return byScope
  }, [data])

  const docRow = (d: Doc) => {
    const meta = [d.category?.trim(), d.file_name, d.size_bytes ? fmtSize(d.size_bytes) : null, effective(d) ? fmtDate(effective(d)) : null].filter(Boolean).join(' · ')
    const inner = (
      <>
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{d.title}</div>
          {meta && <div className="text-xs text-muted-foreground truncate">{meta}</div>}
        </div>
      </>
    )
    return d.sample ? (
      <div key={d.id} className="w-full flex items-center gap-3 px-4 py-3" title="Sample document — no file to download">
        {inner}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">Sample</span>
      </div>
    ) : (
      <button key={d.id} onClick={() => download(d.id)} disabled={downloading === d.id} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors">
        {inner}
        {downloading === d.id ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" /> : <Download className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>
    )
  }

  const TABS = [
    { key: 'overview' as const, label: 'Overview' },
    { key: 'activity' as const, label: 'Activity' },
    { key: 'library' as const, label: 'Library' },
    { key: 'settings' as const, label: 'Settings' },
    { key: 'contact' as const, label: 'Contact' },
  ]

  const isEmpty = !!data && data.snapshots.length === 0 && data.letters.length === 0 && data.documents.length === 0

  return (
    // Full-bleed: break out of the GP layout's max-w-page wrapper so the
    // preview fills the window like a real standalone portal (banner + header
    // lines span edge-to-edge; content stays centered below).
    <div className="min-h-screen flex flex-col bg-muted/20 w-screen ml-[calc(50%-50vw)]">
      {/* Admin preview bar — NOT part of the real portal an LP sees */}
      <div className="sticky top-0 z-20 border-b bg-warning-subtle dark:bg-warning-subtle/40 text-warning">
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium shrink-0 whitespace-nowrap"><Eye className="h-4 w-4" /> LP portal preview — viewing as</span>
          <select
            value={investorId}
            onChange={e => { setInvestorId(e.target.value); setTab('overview') }}
            className="h-7 w-56 shrink-0 rounded border border-warning bg-white dark:bg-warning-subtle px-2 text-sm text-foreground"
          >
            <option value="sample">Sample investor (example)</option>
            {investors.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          {investorId && data && !data.portal_enabled && <span className="text-xs shrink-0 truncate hidden md:inline">Portal is OFF — LPs can’t see this yet</span>}
          <Link href="/lps" className="ml-auto shrink-0 inline-flex items-center gap-1 whitespace-nowrap opacity-80 hover:opacity-100">
            <ArrowLeft className="h-3.5 w-3.5" /> Exit preview
          </Link>
        </div>
      </div>

      {/* Portal chrome — mirrors the real /portal layout (components/portal-chrome) */}
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4">
          <div className="pt-3 pb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {data?.fund?.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.fund.logo_url} alt="" className="h-7 w-auto max-w-[140px] object-contain rounded shrink-0" />
              ) : null}
              <span className="font-medium text-sm text-muted-foreground tracking-tight truncate">{data?.fund?.name ?? 'Investor Portal'}</span>
            </div>
            <Button variant="outline" size="sm" disabled className="text-muted-foreground gap-2" title="Sign out (disabled in preview)">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
          <nav className="flex items-center gap-4 -mb-px pt-2 overflow-x-auto">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                disabled={!investorId}
                className={`text-sm py-2 border-b-2 disabled:opacity-40 whitespace-nowrap ${tab === t.key ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-6">
        {tab === 'overview' ? (
          loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : data ? (
            <OverviewView data={{ investorName: data.investor.name, currency: data.currency, hasData: !!data.overview, ...(data.overview ?? {}) }} />
          ) : (
            <div className="text-sm text-muted-foreground">Select an LP in the bar above to preview their overview.</div>
          )
        ) : tab === 'activity' ? (
          loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : data ? (
            <ActivityView linkNotices={false} data={{ currency: data.currency ?? 'USD', lines: data.activity?.lines ?? [], multipleEntities: !!data.activity?.multipleEntities }} />
          ) : (
            <div className="text-sm text-muted-foreground">Select an LP in the bar above to preview their activity.</div>
          )
        ) : tab === 'settings' ? (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Manage your sign-in security and who can access your account.</p>
            </div>
            <div className="rounded-card border bg-card p-4 text-sm text-muted-foreground flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Each investor manages their own account here — change password, enable two-factor authentication, and review the people they&apos;ve authorized. There&apos;s nothing investor-specific to preview.</span>
            </div>
          </div>
        ) : tab === 'contact' ? (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Contact your fund</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Send an email to your fund&apos;s team.</p>
            </div>
            <div className="rounded-card border bg-card p-4 text-sm text-muted-foreground flex items-start gap-2">
              <MessageSquare className="h-4 w-4 mt-0.5 shrink-0" />
              <span>The contact form is the same for every investor — there&apos;s nothing investor-specific to preview.</span>
            </div>
          </div>
        ) : !investorId ? (
          <div className="text-sm text-muted-foreground">Select an LP in the bar above to see their portal exactly as they would.</div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : !data ? (
          <div className="rounded-card border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">Could not load preview.</div>
        ) : (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Your documents</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Reports, letters, and documents your fund has shared with you.</p>
            </div>

            {isEmpty ? (
              <Empty label="Nothing has been shared with you yet." />
            ) : (
              <>
                {data.snapshots.length > 0 && (
                  <Section title="Statements">
                    <div className="rounded-md border bg-card divide-y">
                      {data.snapshots.map(s => {
                        const inner = (
                          <>
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm truncate">{s.name}</div>
                              {s.as_of_date && <div className="text-xs text-muted-foreground">As of {s.as_of_date}</div>}
                            </div>
                          </>
                        )
                        return (
                          <button key={s.id} onClick={() => downloadReport(s)} disabled={downloading === s.id} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors">
                            {inner}
                            {downloading === s.id ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" /> : <Download className="h-4 w-4 text-muted-foreground shrink-0" />}
                          </button>
                        )
                      })}
                    </div>
                  </Section>
                )}

                {data.letters.length > 0 && (
                  <Section title="Letters">
                    <div className="rounded-md border bg-card divide-y">
                      {data.letters.map(l => {
                        const inner = (
                          <>
                            <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0"><div className="font-medium text-sm truncate">{l.period_label}</div></div>
                          </>
                        )
                        return (
                          <Link key={l.id} href={`/letters/${l.id}`} target="_blank" className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                            {inner}
                            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          </Link>
                        )
                      })}
                    </div>
                  </Section>
                )}

                {data.documents.length > 0 && (
                  <Section title="Documents">
                    <div className="space-y-4">
                      {SCOPE_ORDER.map(scope => {
                        const list = groupedDocs.get(scope.key)
                        if (!list || list.length === 0) return null
                        return (
                          <div key={scope.key} className="space-y-1.5">
                            <h3 className="text-base font-medium text-muted-foreground uppercase tracking-wide">{scope.label}</h3>
                            <div className="rounded-md border bg-card divide-y">{list.map(docRow)}</div>
                          </div>
                        )
                      })}
                    </div>
                  </Section>
                )}
              </>
            )}
          </div>
        )}
      </main>

      <div className="w-full max-w-5xl mx-auto">
        <AppFooter />
      </div>
    </div>
  )
}
