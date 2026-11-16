'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CompanyForm } from '@/components/company-form'
import { MetricForm } from '@/components/metric-form'
import { BarChart3, Building2, Check, Loader2, Plus, Sparkles } from 'lucide-react'
import type { Company } from '@/lib/types/database'

// The same "assign a company, then tell Claude what to extract" step the email review modal
// offers, on the detail page — a failed email lands here, not in the modal, and without this
// section there is no way to configure metrics before hitting Process email.

interface MetricInfo {
  id: string
  name: string
  slug: string
  unit: string | null
}

interface Props {
  emailId: string
  initialCompany: { id: string; name: string } | null
}

export function EmailMetricsSection({ emailId, initialCompany }: Props) {
  const router = useRouter()

  const [company, setCompany] = useState(initialCompany)

  // Company assignment
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [showCompanyForm, setShowCompanyForm] = useState(false)

  // Metrics
  const [metrics, setMetrics] = useState<MetricInfo[]>([])
  const [loadingMetrics, setLoadingMetrics] = useState(!!initialCompany)
  const [showMetricForm, setShowMetricForm] = useState(false)
  const [metricsAdded, setMetricsAdded] = useState(0)

  // Fund default metric profile
  const [defaultsAvailable, setDefaultsAvailable] = useState(0)
  const [seeding, setSeeding] = useState(false)

  const loadMetrics = useCallback(async (companyId: string) => {
    setLoadingMetrics(true)
    try {
      const res = await fetch(`/api/companies/${companyId}/metrics`)
      if (res.ok) {
        const data = (await res.json()) as MetricInfo[]
        setMetrics(data.map(m => ({ id: m.id, name: m.name, slug: m.slug, unit: m.unit ?? null })))
      }
    } catch {
      // leave the list as-is; the section still offers Add metric
    } finally {
      setLoadingMetrics(false)
    }
  }, [])

  const loadDefaults = useCallback(async (companyId: string) => {
    try {
      const res = await fetch(`/api/companies/${companyId}/default-metrics`)
      if (!res.ok) return
      const data = (await res.json()) as { status: string }[]
      setDefaultsAvailable(data.filter(d => d.status === 'available').length)
    } catch {
      setDefaultsAvailable(0)
    }
  }, [])

  useEffect(() => {
    if (company) {
      loadMetrics(company.id)
      loadDefaults(company.id)
    } else {
      setMetrics([])
      setDefaultsAvailable(0)
      setLoadingMetrics(false)
      // Only needed for the picker, so fetch it only when there is nothing assigned
      fetch('/api/companies')
        .then(res => (res.ok ? res.json() : []))
        .then((data: { id: string; name: string; status: string }[]) =>
          setCompanies(
            data
              .filter(c => c.status === 'active')
              .map(c => ({ id: c.id, name: c.name }))
              .sort((a, b) => a.name.localeCompare(b.name))
          )
        )
        .catch(() => setCompanies([]))
    }
  }, [company, loadMetrics, loadDefaults])

  async function assignCompany(companyId: string, name: string) {
    const res = await fetch(`/api/emails/${emailId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error ?? 'Failed to assign company')
    }
    setCompany({ id: companyId, name })
    setSelectedCompanyId('')
    setShowCompanyForm(false)
    router.refresh()
  }

  async function handleAssignExisting() {
    const picked = companies.find(c => c.id === selectedCompanyId)
    if (!picked) return
    setAssigning(true)
    try {
      await assignCompany(picked.id, picked.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error assigning company')
    } finally {
      setAssigning(false)
    }
  }

  async function handleCompanyCreated(created: Company) {
    try {
      await assignCompany(created.id, created.name)
      setShowMetricForm(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error assigning company')
    }
  }

  function handleMetricAdded() {
    setMetricsAdded(prev => prev + 1)
    if (company) {
      loadMetrics(company.id)
      loadDefaults(company.id)
    }
  }

  async function handleSeedDefaults() {
    if (!company) return
    setSeeding(true)
    try {
      const res = await fetch(`/api/companies/${company.id}/default-metrics`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Failed to add default metrics')
      }
      const { inserted } = (await res.json()) as { inserted: number }
      toast.success(`${inserted} default metric${inserted === 1 ? '' : 's'} added`)
      await Promise.all([loadMetrics(company.id), loadDefaults(company.id)])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error adding default metrics')
    } finally {
      setSeeding(false)
    }
  }

  const hasMetrics = metrics.length > 0

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-semibold">Metrics</h2>
        {company && !loadingMetrics && (
          <span className="text-xs text-muted-foreground">
            {hasMetrics ? `${metrics.length} configured` : 'none configured'}
          </span>
        )}
      </div>

      {/* ── No company: assign one first ── */}
      {!company && (
        <div className="rounded-card border bg-muted/30 p-4 space-y-3">
          <p className="text-sm text-muted-foreground flex items-start gap-2">
            <Building2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              No company assigned, so there are no metrics to configure. Pick the company this
              email reports on, or create it.
            </span>
          </p>

          {!showCompanyForm && (
            <>
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={selectedCompanyId}
                  onChange={e => setSelectedCompanyId(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 flex-1"
                >
                  <option value="">Select a company…</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={handleAssignExisting}
                  disabled={!selectedCompanyId || assigning}
                  className="gap-1.5 shrink-0"
                >
                  {assigning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Assign
                </Button>
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                <span>or</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowCompanyForm(true)}
                className="gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                Create New Company
              </Button>
            </>
          )}

          {showCompanyForm && (
            <div className="rounded-card border bg-background p-4">
              <CompanyForm
                onSuccess={handleCompanyCreated}
                onCancel={() => setShowCompanyForm(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Company assigned: configure what Claude should extract ── */}
      {company && (
        <div className="space-y-3">
          {loadingMetrics && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading metrics…
            </div>
          )}

          {!loadingMetrics && hasMetrics && (
            <div className="flex flex-wrap gap-1.5">
              {metrics.map(m => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs"
                >
                  {m.name}
                  {m.unit && <span className="text-muted-foreground">({m.unit})</span>}
                </span>
              ))}
            </div>
          )}

          {!loadingMetrics && !hasMetrics && (
            <p className="text-sm text-muted-foreground flex items-start gap-2">
              <BarChart3 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {company.name} has no metrics configured, so the pipeline has nothing to look for.
                Add at least one, then run Process email below.
              </span>
            </p>
          )}

          {metricsAdded > 0 && (
            <p className="text-xs text-success flex items-center gap-1">
              <Check className="h-3 w-3" />
              {metricsAdded} metric{metricsAdded !== 1 ? 's' : ''} added — run Process email below to
              extract values.
            </p>
          )}

          {showMetricForm ? (
            <div className="rounded-card border bg-muted/30 p-4">
              <MetricForm
                key={metricsAdded}
                companyId={company.id}
                onSuccess={handleMetricAdded}
                onCancel={() => setShowMetricForm(false)}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowMetricForm(true)}
                className="gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                Add metric
              </Button>

              {defaultsAvailable > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSeedDefaults}
                  disabled={seeding}
                  className="gap-1.5"
                >
                  {seeding ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  Add {defaultsAvailable} fund default{defaultsAvailable !== 1 ? 's' : ''}
                </Button>
              )}

              <Link
                href={`/companies/${company.id}`}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Manage on {company.name}
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
