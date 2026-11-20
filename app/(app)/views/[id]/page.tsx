'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, FileSpreadsheet, FileText, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CustomViewRenderer } from '@/components/custom-views/view-renderer'
import type { CustomViewPayload } from '@/lib/mcp-apps/payload'

interface Loaded {
  spec: unknown
  view: { id: string; name: string; kind: 'mine' | 'shared'; shared: boolean }
  payload: CustomViewPayload
}

/**
 * One custom view: the generic page every saved view is drawn on. A client page (nothing in
 * page-domains.ts); /api/views/[id] loads each block as the viewer and marks the ones they cannot
 * read, so the same view serves colleagues with different access.
 */
export default function CustomViewPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [vehicle, setVehicle] = useState('')
  const [asOf, setAsOf] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Callers that change the filters set `loading` first; the first load starts with it set.
  const load = useCallback(async (filters: { vehicle: string; asOf: string }) => {
    const qs = new URLSearchParams()
    if (filters.vehicle) qs.set('vehicle', filters.vehicle)
    if (filters.asOf) qs.set('as_of', filters.asOf)
    try {
      const r = await fetch(`/api/views/${encodeURIComponent(id)}${qs.size ? `?${qs}` : ''}`)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? 'Could not load this view.')
      setData(body)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id])

  // load() sets state only after its fetch resolves; the rule cannot see past the await.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load({ vehicle: '', asOf: '' }) }, [load])

  const remove = async () => {
    const r = await fetch(`/api/views/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (r.ok) router.push('/views')
    else setError((await r.json().catch(() => ({}))).error ?? 'Could not delete this view.')
  }

  const payload = data?.payload
  const params = payload?.data.params ?? []

  // The file is built on the server with the same filters, loaded as the viewer again.
  const exportHref = (format: 'pdf' | 'xlsx') => {
    const qs = new URLSearchParams({ format })
    if (vehicle) qs.set('vehicle', vehicle)
    if (asOf) qs.set('as_of', asOf)
    try { qs.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone) } catch { /* the server uses UTC */ }
    return `/api/views/${encodeURIComponent(id)}/export?${qs}`
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="space-y-2">
        <Link href="/views" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Views
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{data?.view.name ?? 'View'}</h1>
              {data?.view.kind === 'shared' && <Badge variant="outline">Shared with you</Badge>}
              {data?.view.kind === 'mine' && data.view.shared && <Badge variant="outline">Shared with the fund</Badge>}
            </div>
            {payload?.data.description && <p className="text-sm text-muted-foreground">{payload.data.description}</p>}
            {payload && (
              <p className="text-caption text-muted-foreground">
                {payload.subtitle ? `${payload.subtitle} · ` : ''}Live figures, read {new Date(payload.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {params.includes('vehicle') && (payload?.data.vehicles.length ?? 0) > 1 && (
              <select
                aria-label="Entity"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={vehicle}
                onChange={e => { setVehicle(e.target.value); setLoading(true); load({ vehicle: e.target.value, asOf }) }}
              >
                <option value="">All entities</option>
                {payload!.data.vehicles.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
            {params.includes('as_of') && (
              <Input
                type="date"
                aria-label="As of"
                className="h-9 w-[160px]"
                value={asOf}
                onChange={e => { setAsOf(e.target.value); setLoading(true); load({ vehicle, asOf: e.target.value }) }}
              />
            )}
            <Button variant="outline" size="sm" onClick={() => { setLoading(true); load({ vehicle, asOf }) }} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
            {data && (
              <>
                <Button asChild variant="outline" size="sm" className="text-muted-foreground">
                  <a href={exportHref('pdf')} target="_blank" rel="noopener"><FileText /> PDF</a>
                </Button>
                <Button asChild variant="outline" size="sm" className="text-muted-foreground">
                  <a href={exportHref('xlsx')}><FileSpreadsheet /> Excel</a>
                </Button>
              </>
            )}
            {data && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/views/new?from=${encodeURIComponent(id)}`}><Sparkles /> {data.view.kind === 'mine' ? 'Change' : 'Copy and change'}</Link>
              </Button>
            )}
            {data?.view.kind === 'mine' && (
              confirmDelete ? (
                <>
                  <Button variant="destructive" size="sm" onClick={remove}>Delete view</Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Keep</Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>Delete</Button>
              )
            )}
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !payload ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading view</div>
      ) : (
        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <CustomViewRenderer payload={payload} />
        </div>
      )}
    </div>
  )
}
