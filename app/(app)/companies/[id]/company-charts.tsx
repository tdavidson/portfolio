'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MetricForm } from '@/components/metric-form'
import type { Metric } from '@/lib/types/database'
import { csvField } from '@/lib/csv/escape'
import { MetricChart } from './metric-chart'
import { AddDataPointDialog } from './add-data-point-dialog'
import { CompanyDefaultMetricsDialog, type DefaultMetricStatus } from './default-metrics-dialog'

interface MetricValueRow {
  id: string
  metric_id: string
  period_label: string
  period_year: number
  period_quarter: number | null
  period_month: number | null
  value_number: number | null
  value_text: string | null
  confidence: 'high' | 'medium' | 'low'
  source_email_id: string | null
  notes: string | null
  is_manually_entered: boolean
  created_at: string
  inbound_emails: { id: string; subject: string; received_at: string } | null
}

export type { MetricValueRow }

interface Props {
  companyId: string
  companyName: string
  metrics: Metric[]
}

export function CompanyCharts({ companyId, companyName, metrics }: Props) {
  const router = useRouter()
  const [valuesByMetric, setValuesByMetric] = useState<Record<string, MetricValueRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [addMetricOpen, setAddMetricOpen] = useState(false)
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState<DefaultMetricStatus[] | null>(null)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())

  // Stabilize metrics dependency to avoid refetching on every render
  const metricIds = metrics.map(m => m.id).join(',')

  const loadValues = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch(`/api/companies/${companyId}/metrics/values`)
      if (!res.ok) throw new Error('Chart data unavailable')
      setValuesByMetric(await res.json())
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, metricIds])

  useEffect(() => {
    loadValues()
  }, [loadValues])

  // Whether the fund has default metrics, and how many this company is still missing — drives the
  // "Fund defaults" affordance. Cheap single request; re-fetched when the dialog reports a change.
  const loadDefaultStatus = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/default-metrics`)
    if (res.ok) setDefaultStatus(await res.json())
  }, [companyId])

  useEffect(() => { loadDefaultStatus() }, [loadDefaultStatus])

  const fundHasDefaults = (defaultStatus?.length ?? 0) > 0
  const availableDefaults = (defaultStatus ?? []).filter(d => d.status === 'available').length

  const defaultsDialog = (
    <CompanyDefaultMetricsDialog
      companyId={companyId}
      open={defaultsOpen}
      onOpenChange={setDefaultsOpen}
      onChanged={() => { loadDefaultStatus(); router.refresh() }}
    />
  )

  const exportCsv = () => {
    const rows: string[][] = [
      ['Company', 'Metric', 'Period', 'Value', 'Unit', 'Confidence', 'Source', 'Date Entered'],
    ]
    for (const m of metrics) {
      const values = valuesByMetric[m.id] ?? []
      for (const v of values) {
        const value = v.value_number !== null ? String(v.value_number) : (v.value_text ?? '')
        const unit = m.unit ?? ''
        const source = v.is_manually_entered
          ? 'Manual'
          : (v.inbound_emails?.subject ?? 'Email')
        rows.push([
          companyName,
          m.name,
          v.period_label,
          value,
          unit,
          v.confidence,
          source,
          v.created_at ? new Date(v.created_at).toLocaleDateString() : '',
        ])
      }
    }

    const csv = rows.map((r) => r.map((c) => csvField(c, { alwaysQuote: true })).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_metrics.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const addMetricDialog = (
    <Dialog open={addMetricOpen} onOpenChange={setAddMetricOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Metric</DialogTitle>
        </DialogHeader>
        <MetricForm
          companyId={companyId}
          onSuccess={() => {
            setAddMetricOpen(false)
            router.refresh()
          }}
          onCancel={() => setAddMetricOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )

  if (metrics.length === 0) {
    return (
      <>
        <div className="rounded-card border border-dashed p-12 text-center space-y-3" data-metrics-ready="company">
          <p className="text-muted-foreground">
            No metrics configured yet. Add metrics to this company to start tracking data.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button size="sm" onClick={() => setAddMetricOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              Add metric
            </Button>
            {fundHasDefaults && (
              <Button size="sm" variant="outline" onClick={() => setDefaultsOpen(true)}>
                Use fund defaults{availableDefaults > 0 ? ` (${availableDefaults})` : ''}
              </Button>
            )}
          </div>
        </div>
        {addMetricDialog}
        {defaultsDialog}
      </>
    )
  }

  const visibleMetrics = metrics.filter(m => !deletedIds.has(m.id))

  const gridClass =
    visibleMetrics.length === 1
      ? 'grid gap-4 grid-cols-1'
      : visibleMetrics.length >= 3 && visibleMetrics.length % 2 !== 0
        ? 'grid gap-4 grid-cols-1 md:grid-cols-3'
        : 'grid gap-4 grid-cols-1 md:grid-cols-2'

  if (loadError) {
    return <p role="alert" className="text-sm text-muted-foreground">Could not load chart data. Refresh this page to try again.</p>
  }

  if (loading) {
    return (
      <div className={gridClass}>
        {visibleMetrics.map((m) => (
          <div key={m.id} className="rounded-card border p-4 animate-pulse">
            <div className="h-4 w-32 bg-muted rounded mb-3" />
            <div className="h-[180px] bg-muted/50 rounded" />
          </div>
        ))}
      </div>
    )
  }

  const hasData = visibleMetrics.some((m) => (valuesByMetric[m.id]?.length ?? 0) > 0)

  return (
    <div className="space-y-4" data-metrics-ready="company">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Metrics</h2>
        <div className="flex items-center gap-3">
          {hasData && (
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          )}
          {fundHasDefaults && (
            <Button size="sm" variant="ghost" onClick={() => setDefaultsOpen(true)} className="text-muted-foreground">
              Fund defaults{availableDefaults > 0 ? ` (${availableDefaults})` : ''}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setAddMetricOpen(true)} className="text-muted-foreground">
            <Plus className="h-4 w-4 mr-1.5" />
            Add metric
          </Button>
        </div>
      </div>

      <div className={gridClass}>
        {visibleMetrics.map((m) => (
          <MetricChartCard
            key={m.id}
            companyId={companyId}
            metric={m}
            values={valuesByMetric[m.id] ?? []}
            onRefresh={loadValues}
            onDelete={(id) => setDeletedIds(prev => new Set(prev).add(id))}
          />
        ))}
      </div>

      {addMetricDialog}
      {defaultsDialog}
    </div>
  )
}

function MetricChartCard({
  companyId,
  metric,
  values,
  onRefresh,
  onDelete,
}: {
  companyId: string
  metric: Metric
  values: MetricValueRow[]
  onRefresh: () => void
  onDelete: (id: string) => void
}) {
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0)

  const handleDelete = async () => {
    setConfirmStep(2)
    try {
      const res = await fetch(`/api/metrics/${metric.id}?force=true`, { method: 'DELETE' })
      if (res.ok) {
        onDelete(metric.id)
      } else {
        setConfirmStep(0)
      }
    } catch {
      setConfirmStep(0)
    }
  }

  return (
    <div className="rounded-card border bg-card p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <h3 className="font-medium text-base truncate">{metric.name}</h3>
          {metric.description && (
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{metric.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <button
            onClick={() => setAddOpen(true)}
            className="text-[11px] text-primary hover:underline"
          >
            + Add
          </button>
          <button
            onClick={() => setEditOpen(true)}
            className="text-muted-foreground/50 hover:text-foreground transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setConfirmStep(1)}
            className="text-muted-foreground/50 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {confirmStep >= 1 ? (
        <div className="h-[180px] flex flex-col items-center justify-center rounded border border-dashed border-destructive/30 bg-destructive/5 gap-3 px-4">
          <p className="text-sm text-center">
            Delete <strong>{metric.name}</strong> and all its data? This cannot be undone.
          </p>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="destructive"
              disabled={confirmStep === 2}
              onClick={handleDelete}
            >
              {confirmStep === 2 ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : null}
              Delete
            </Button>
            <button
              onClick={() => setConfirmStep(0)}
              className="text-xs text-muted-foreground hover:text-foreground"
              disabled={confirmStep === 2}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : values.length === 0 ? (
        <div className="h-[180px] flex items-center justify-center rounded border border-dashed">
          <p className="text-xs text-muted-foreground text-center px-3">
            No data yet. Add data points manually or process a report.
          </p>
        </div>
      ) : (
        <MetricChart
          metric={metric}
          values={values}
          onRefresh={onRefresh}
          compact
        />
      )}

      <AddDataPointDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        companyId={companyId}
        metric={metric}
        onSuccess={() => { onRefresh(); router.refresh() }}
      />

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Metric</DialogTitle>
          </DialogHeader>
          <MetricForm
            companyId={companyId}
            metric={metric}
            onSuccess={() => {
              setEditOpen(false)
              router.refresh()
            }}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
