'use client'

import { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Trash2, X } from 'lucide-react'
import type { Company } from '@/lib/types/database'
import { holdingDeletePath } from '@/lib/portfolio/holding-href'

interface Props {
  company?: Company
  initialName?: string
  onSuccess: (company: Company) => void
  onCancel: () => void
  onDeleted?: () => void
  /** The kind of holding being edited. A fund holding or a digital asset has no stage, industry,
   *  founders or metrics, and a fund holding is deleted through its own route. Omitted = company. */
  holdingType?: 'company' | 'fund' | 'crypto'
}

/** What the form calls the holding, in its labels. */
const NOUN = { company: 'company', fund: 'fund holding', crypto: 'digital asset' } as const

/** A fund-wide default metric template, as returned by GET /api/default-metrics. */
interface DefaultMetric {
  id: string
  name: string
  unit: string | null
  description: string | null
  is_active: boolean | null
}

interface CustomMetric {
  name: string
  unit: string | null
}

/** One of the fund's entities the viewer can see, as returned by GET /api/entities. */
interface Vehicle {
  id: string
  name: string
  kind: string
  active: boolean
}

export function CompanyForm({ company, initialName, onSuccess, onCancel, onDeleted, holdingType = 'company' }: Props) {
  const isEdit = !!company
  // Stage, industry, founders and metrics describe an operating company, not a fund or a token.
  const isCompany = holdingType === 'company'
  const noun = NOUN[holdingType]

  const [name, setName] = useState(company?.name ?? initialName ?? '')
  const [aliases, setAliases] = useState<string[]>(company?.aliases ?? [])
  const [aliasInput, setAliasInput] = useState('')
  const [stage, setStage] = useState(company?.stage ?? '')
  const [industries, setIndustries] = useState<string[]>(company?.industry ?? [])
  const [industryInput, setIndustryInput] = useState('')
  const [tags, setTags] = useState<string[]>(company?.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [portfolioGroups, setPortfolioGroups] = useState<string[]>(company?.portfolio_group ?? [])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [vehicleInput, setVehicleInput] = useState('')
  const [vehicleDropdownOpen, setVehicleDropdownOpen] = useState(false)
  const vehicleFieldRef = useRef<HTMLDivElement>(null)
  const [notes, setNotes] = useState(company?.notes ?? '')
  const [overview, setOverview] = useState(company?.overview ?? '')
  const [founders, setFounders] = useState(company?.founders ?? '')
  const [whyInvested, setWhyInvested] = useState(company?.why_invested ?? '')
  const [currentUpdate, setCurrentUpdate] = useState(company?.current_update ?? '')
  const [contactEmails, setContactEmails] = useState<string[]>(company?.contact_email ?? [])
  const [contactEmailInput, setContactEmailInput] = useState('')
  const [status, setStatus] = useState(company?.status ?? 'active')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Metrics, create-mode only. The fund's default profile has always been copied in on create;
  // this exposes it so you can uncheck the ones that don't apply and add one-offs up front,
  // instead of creating the company and then fixing its metric list on the company page.
  const [defaults, setDefaults] = useState<DefaultMetric[] | null>(null)
  const [keptDefaults, setKeptDefaults] = useState<Set<string>>(new Set())
  const [customMetrics, setCustomMetrics] = useState<CustomMetric[]>([])
  const [customName, setCustomName] = useState('')
  const [customUnit, setCustomUnit] = useState('')

  useEffect(() => {
    if (isEdit) return
    let cancelled = false
    fetch('/api/default-metrics')
      .then(res => (res.ok ? res.json() : []))
      .then((rows: DefaultMetric[]) => {
        if (cancelled) return
        const active = (rows ?? []).filter(d => d.is_active !== false)
        setDefaults(active)
        setKeptDefaults(new Set(active.map(d => d.id)))
      })
      .catch(() => { if (!cancelled) setDefaults([]) })
    return () => { cancelled = true }
  }, [isEdit])

  useEffect(() => {
    let cancelled = false
    // The viewer's entities (gated on portfolio, not accounting — anyone who edits a company can
    // choose its entities). Active ones to choose from; the management company holds no portfolio.
    fetch('/api/entities')
      .then(res => (res.ok ? res.json() : []))
      .then((rows: Vehicle[]) => {
        if (cancelled) return
        setVehicles((rows ?? []).filter(v => v.active !== false && v.kind !== 'manco'))
      })
      .catch(() => { if (!cancelled) setVehicles([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (vehicleFieldRef.current && !vehicleFieldRef.current.contains(e.target as Node)) {
        setVehicleDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function toggleDefault(id: string) {
    setKeptDefaults(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addCustomMetric() {
    const trimmed = customName.trim()
    if (!trimmed) return
    if (customMetrics.some(m => m.name.toLowerCase() === trimmed.toLowerCase())) return
    setCustomMetrics(prev => [...prev, { name: trimmed, unit: customUnit.trim() || null }])
    setCustomName('')
    setCustomUnit('')
  }

  function handleCustomMetricKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addCustomMetric() }
  }

  function addTag() {
    const trimmed = tagInput.trim()
    if (!trimmed || tags.includes(trimmed)) return
    setTags(prev => [...prev, trimmed])
    setTagInput('')
  }

  function removeTag(tag: string) {
    setTags(prev => prev.filter(t => t !== tag))
  }

  function handleTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTag()
    }
  }

  function addIndustry() {
    const trimmed = industryInput.trim()
    if (!trimmed || industries.includes(trimmed)) return
    setIndustries(prev => [...prev, trimmed])
    setIndustryInput('')
  }

  function removeIndustry(val: string) {
    setIndustries(prev => prev.filter(v => v !== val))
  }

  function handleIndustryKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addIndustry() }
  }

  function removePortfolioGroup(val: string) {
    setPortfolioGroups(prev => prev.filter(v => v !== val))
  }

  const vehicleMatches = vehicles.filter(v =>
    v.name.toLowerCase().includes(vehicleInput.trim().toLowerCase()) &&
    !portfolioGroups.includes(v.name)
  )

  function selectVehicle(name: string) {
    if (!portfolioGroups.includes(name)) {
      setPortfolioGroups(prev => [...prev, name])
    }
    setVehicleInput('')
    setVehicleDropdownOpen(false)
  }

  function handleVehicleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const trimmed = vehicleInput.trim()
    if (!trimmed) return
    // Choose an existing entity only: entities are created under Settings, never from a typo here.
    const existing = vehicles.find(v => v.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) selectVehicle(existing.name)
  }

  function addContactEmail() {
    const trimmed = contactEmailInput.trim()
    if (!trimmed || contactEmails.includes(trimmed)) return
    setContactEmails(prev => [...prev, trimmed])
    setContactEmailInput('')
  }

  function removeContactEmail(val: string) {
    setContactEmails(prev => prev.filter(v => v !== val))
  }

  function handleContactEmailKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addContactEmail() }
  }

  function addAlias() {
    const trimmed = aliasInput.trim()
    if (!trimmed || aliases.includes(trimmed)) return
    setAliases(prev => [...prev, trimmed])
    setAliasInput('')
  }

  function removeAlias(alias: string) {
    setAliases(prev => prev.filter(a => a !== alias))
  }

  function handleAliasKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addAlias()
    }
  }

  async function submit() {
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    setError(null)
    setSaving(true)

    try {
      const url = isEdit ? `/api/companies/${company.id}` : '/api/companies'
      const method = isEdit ? 'PATCH' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          aliases: aliases.length > 0 ? aliases : null,
          tags: tags.length > 0 ? tags : [],
          // Not sent for a fund holding or digital asset: the form does not show them, so it must
          // not write them either.
          ...(isCompany ? {
            stage: stage.trim() || null,
            industry: industries.length > 0 ? industries : null,
            founders: founders.trim() || null,
          } : {}),
          notes: notes.trim() || null,
          overview: overview.trim() || null,
          why_invested: whyInvested.trim() || null,
          current_update: currentUpdate.trim() || null,
          contact_email: contactEmails.length > 0 ? contactEmails : null,
          portfolio_group: portfolioGroups.length > 0 ? portfolioGroups : null,
          ...(isEdit
            ? { status }
            : !isCompany ? {} : {
                // Only send a selection once the defaults have loaded — otherwise omit both keys
                // and the server seeds every active default, the long-standing behaviour.
                ...(defaults ? { default_metric_ids: Array.from(keptDefaults) } : {}),
                ...(customMetrics.length > 0 ? { custom_metrics: customMetrics } : {}),
              }),
        }),
      })

      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`Server error (${res.status}): failed to parse response`)
      }
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong')
      onSuccess(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  async function deleteCompany() {
    if (!company || !onDeleted) return
    setDeleteError(null)
    setDeleting(true)

    try {
      const res = await fetch(holdingDeletePath(company.id, holdingType), { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed to delete the ${noun}`)
      onDeleted()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : `Failed to delete the ${noun}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="company-name">Name</Label>
        <Input
          id="company-name"
          placeholder="Acme Corp"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>Aliases</Label>
        {aliases.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {aliases.map(alias => (
              <Badge key={alias} variant="secondary" className="gap-1 pr-1">
                {alias}
                <button
                  type="button"
                  onClick={() => removeAlias(alias)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input
          placeholder="Add alias and press Enter"
          value={aliasInput}
          onChange={e => setAliasInput(e.target.value)}
          onKeyDown={handleAliasKeyDown}
          onBlur={addAlias}
        />
        <p className="text-xs text-muted-foreground">
          Alternative names Claude might see in emails (e.g. abbreviations, trading names).
        </p>
      </div>

      <div className="space-y-2">
        <Label>Tags</Label>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.map(tag => (
              <Badge key={tag} variant="outline" className="gap-1 pr-1">
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input
          placeholder="Add tag and press Enter (e.g. Fund I)"
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={handleTagKeyDown}
          onBlur={addTag}
        />
        <p className="text-xs text-muted-foreground">
          Tags for organizing companies (e.g. fund name, cohort).
        </p>
      </div>

      {isCompany && (<>
      <div className="space-y-2">
        <Label htmlFor="stage">Stage</Label>
        <Input
          id="stage"
          placeholder="Series A"
          value={stage}
          onChange={e => setStage(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>Industry</Label>
        {industries.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {industries.map(val => (
              <Badge key={val} variant="outline" className="gap-1 pr-1">
                {val}
                <button
                  type="button"
                  onClick={() => removeIndustry(val)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input
          placeholder="Add industry and press Enter (e.g. SaaS)"
          value={industryInput}
          onChange={e => setIndustryInput(e.target.value)}
          onKeyDown={handleIndustryKeyDown}
          onBlur={addIndustry}
        />
      </div>
      </>)}

      <div className="space-y-2">
        <Label>Entities</Label>
        {portfolioGroups.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {portfolioGroups.map(val => (
              <Badge key={val} variant="outline" className="gap-1 pr-1">
                {val}
                <button
                  type="button"
                  onClick={() => removePortfolioGroup(val)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="relative" ref={vehicleFieldRef}>
          <Input
            placeholder="Search entities…"
            value={vehicleInput}
            onChange={e => { setVehicleInput(e.target.value); setVehicleDropdownOpen(true) }}
            onFocus={() => setVehicleDropdownOpen(true)}
            onKeyDown={handleVehicleInputKeyDown}
          />
          {vehicleDropdownOpen && vehicleInput.trim() && (
            <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md max-h-48 overflow-y-auto">
              {vehicleMatches.map(v => (
                <button
                  key={v.id}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); selectVehicle(v.name) }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-sm text-left hover:bg-muted"
                >
                  <span className="truncate">{v.name}</span>
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">{v.kind}</span>
                </button>
              ))}
              {vehicleMatches.length === 0 && (
                <div className="px-3 py-1.5 text-sm text-muted-foreground">No matching entity</div>
              )}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Which of the fund&apos;s entities hold this company. Its team sees it; choose at least one of yours.
        </p>
      </div>

      {isCompany && (
        <div className="space-y-2">
          <Label htmlFor="founders">Founders</Label>
          <Input
            id="founders"
            placeholder="Jane Doe, John Smith"
            value={founders}
            onChange={e => setFounders(e.target.value)}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label>Contact Emails</Label>
        {contactEmails.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {contactEmails.map(val => (
              <Badge key={val} variant="outline" className="gap-1 pr-1">
                {val}
                <button
                  type="button"
                  onClick={() => removeContactEmail(val)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input
          type="email"
          placeholder="Add email and press Enter"
          value={contactEmailInput}
          onChange={e => setContactEmailInput(e.target.value)}
          onKeyDown={handleContactEmailKeyDown}
          onBlur={addContactEmail}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="overview">Overview</Label>
        <Textarea
          id="overview"
          placeholder="Brief description of the company..."
          value={overview}
          onChange={e => setOverview(e.target.value)}
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="why-invested">Why We Invested</Label>
        <Textarea
          id="why-invested"
          placeholder="Investment thesis..."
          value={whyInvested}
          onChange={e => setWhyInvested(e.target.value)}
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="current-update">Current Business Update</Label>
        <Textarea
          id="current-update"
          placeholder="Latest update on the business..."
          value={currentUpdate}
          onChange={e => setCurrentUpdate(e.target.value)}
          rows={2}
        />
      </div>

      {isEdit && (
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="exited">Exited</SelectItem>
              <SelectItem value="written-off">Written off</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          placeholder="Any notes about this company…"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
        />
      </div>

      {!isEdit && isCompany && (
        <div className="space-y-2 border-t pt-4">
          <Label>Metrics</Label>
          {defaults === null ? (
            <p className="text-xs text-muted-foreground">Loading your fund&apos;s default metrics…</p>
          ) : defaults.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Your fund has no default metrics yet. Add any you want to track here, or set a fund-wide
              profile in Settings → Default metrics.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Your fund defaults, applied to this company on create. Uncheck any that don&apos;t apply.
              </p>
              <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border p-2">
                {defaults.map(d => (
                  <label key={d.id} className="flex items-center gap-2 text-sm cursor-pointer py-0.5">
                    <input
                      type="checkbox"
                      checked={keptDefaults.has(d.id)}
                      onChange={() => toggleDefault(d.id)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="truncate">
                      {d.name}
                      {d.unit ? <span className="text-muted-foreground"> · {d.unit}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {customMetrics.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {customMetrics.map(m => (
                <Badge key={m.name} variant="outline" className="gap-1 pr-1">
                  {m.name}{m.unit ? ` · ${m.unit}` : ''}
                  <button
                    type="button"
                    onClick={() => setCustomMetrics(prev => prev.filter(x => x.name !== m.name))}
                    className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              placeholder="Add a metric (e.g. ARR)"
              value={customName}
              onChange={e => setCustomName(e.target.value)}
              onKeyDown={handleCustomMetricKeyDown}
            />
            <Input
              placeholder="Unit"
              value={customUnit}
              onChange={e => setCustomUnit(e.target.value)}
              onKeyDown={handleCustomMetricKeyDown}
              className="w-24"
            />
            <Button type="button" variant="outline" onClick={addCustomMetric} disabled={!customName.trim()}>
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Values get entered on the company page once it exists.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2">
        {isEdit && onDeleted ? (
          <Dialog open={deleteOpen} onOpenChange={(open) => {
            setDeleteOpen(open)
            if (!open) setDeleteError(null)
          }}>
            <DialogTrigger asChild>
              <Button variant="destructive" disabled={saving || deleting}>
                <Trash2 />
                Delete {noun}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {company.name}?</DialogTitle>
                <DialogDescription>
                  {holdingType === 'fund'
                    ? 'This permanently deletes the fund holding with its terms, register and NAV statements, and its notes and documents. This action cannot be undone.'
                    : holdingType === 'crypto'
                      ? 'This permanently deletes the digital asset with its watched wallets and price feed, and its notes and documents. This action cannot be undone.'
                      : 'This permanently deletes the company and its metrics, updates, notes, documents, and other company-owned data. Reporting emails and diligence history are retained but unlinked. This action cannot be undone.'}
                </DialogDescription>
              </DialogHeader>
              {deleteError && (
                <Alert variant="destructive">
                  <AlertDescription>{deleteError}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={deleteCompany} disabled={deleting}>
                  {deleting ? 'Deleting…' : `Delete ${noun}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : <span />}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={saving || deleting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || deleting}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add company'}
          </Button>
        </div>
      </div>
    </div>
  )
}
