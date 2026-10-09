'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PlanDetail } from '@/lib/forecast/service'

type Rule = PlanDetail['rules'][number]
type Account = PlanDetail['accounts'][number]

export interface RuleSubmit {
  method: string
  params: Record<string, unknown>
  cashTiming: Record<string, unknown>
  note: string | null
}

const METHODS: { value: string; label: string; hint: string }[] = [
  { value: 'manual', label: 'Manual', hint: 'Type each month into the table.' },
  { value: 'fixed', label: 'Fixed amount', hint: 'The same amount every month.' },
  { value: 'recurring', label: 'Recurring schedule', hint: 'Every N months from an anchor month — an annual bill lands in one month, not twelve.' },
  { value: 'run_rate', label: 'Historical run rate', hint: 'Average of closed months; unclosed months are left out unless you include them.' },
  { value: 'growth', label: 'Growth', hint: 'A base amount growing by a rate per month or per year.' },
  { value: 'linked_fee', label: 'Linked management fee', hint: 'The fund’s construction fee schedule, on the fee link’s billing cycle. Set up the link under Fee links.' },
  { value: 'linked_construction', label: 'Portfolio construction', hint: 'This fund’s construction fees or expenses by month (construction states them per year; they are spread evenly).' },
]

const selectCls = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

const str = (v: unknown) => (v == null ? '' : String(v))

export function RuleDialog({ account, rule, open, saving, error, onClose, onSave, onRemove }: {
  account: Account | null
  rule: Rule | null
  open: boolean
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (r: RuleSubmit) => void
  onRemove: () => void
}) {
  const [method, setMethod] = useState('fixed')
  const [f, setF] = useState<Record<string, string>>({})
  const [timing, setTiming] = useState<Record<string, string>>({ mode: 'same' })
  const [note, setNote] = useState('')
  const set = (k: string, v: string) => setF(prev => ({ ...prev, [k]: v }))

  useEffect(() => {
    if (!open) return
    const p = (rule?.params ?? {}) as Record<string, unknown>
    setMethod(rule?.method ?? 'fixed')
    setF({
      amount: str(p.amount), start: str(p.start), end: str(p.end), everyMonths: str(p.everyMonths ?? 12), anchor: str(p.anchor),
      annualEscalation: p.annualEscalation != null ? String(Number(p.annualEscalation) * 100) : '',
      window: str(p.window ?? 12), from: str(p.from), to: str(p.to), includeUnclosed: p.includeUnclosed ? '1' : '',
      base: str(p.base), baseMonth: str(p.baseMonth), rate: p.rate != null ? String(Number(p.rate) * 100) : '', per: str(p.per ?? 'year'),
      fundVehicle: str(p.fundVehicle), flow: str(p.flow ?? 'fees'),
    })
    const t = (rule?.cashTiming ?? { mode: 'same' }) as Record<string, unknown>
    setTiming({ mode: str(t.mode), months: str(t.months ?? 1), month: str(t.month ?? 1), direction: str(t.direction ?? 'advance') })
    setNote(rule?.note ?? '')
  }, [open, rule])

  const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
  const month = (s: string) => (s.trim() === '' ? undefined : s.trim())

  const submit = () => {
    let params: Record<string, unknown> = {}
    switch (method) {
      case 'manual':
        params = { amounts: (rule?.method === 'manual' ? (rule.params as any)?.amounts : undefined) ?? {} }
        break
      case 'fixed':
        params = { amount: num(f.amount), start: month(f.start), end: month(f.end) }
        break
      case 'recurring':
        params = {
          amount: num(f.amount), everyMonths: num(f.everyMonths), anchor: month(f.anchor), start: month(f.start), end: month(f.end),
          annualEscalation: f.annualEscalation ? Number(f.annualEscalation) / 100 : undefined,
        }
        break
      case 'run_rate':
        params = f.from || f.to
          ? { from: month(f.from), to: month(f.to), includeUnclosed: f.includeUnclosed === '1' }
          : { window: num(f.window), includeUnclosed: f.includeUnclosed === '1' }
        break
      case 'growth':
        params = { base: num(f.base), baseMonth: month(f.baseMonth), rate: f.rate ? Number(f.rate) / 100 : 0, per: f.per }
        break
      case 'linked_fee':
        params = f.fundVehicle?.trim() ? { fundVehicle: f.fundVehicle.trim() } : {}
        break
      case 'linked_construction':
        params = { flow: f.flow || 'fees' }
        break
    }
    const cashTiming =
      timing.mode === 'offset' ? { mode: 'offset', months: Number(timing.months) }
      : timing.mode === 'month' ? { mode: 'month', month: Number(timing.month), direction: timing.direction }
      : { mode: 'same' }
    onSave({ method, params, cashTiming, note: note.trim() || null })
  }

  const isExpense = account?.type === 'expense'

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{account ? `${account.code} ${account.name}` : 'Rule'}</DialogTitle>
          <DialogDescription>How this account is projected. Month overrides in the table win over the rule without deleting it.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Method">
            <select className={selectCls} value={method} onChange={e => setMethod(e.target.value)}>
              {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <p className="text-xs text-muted-foreground">{METHODS.find(m => m.value === method)?.hint}</p>

          {(method === 'fixed' || method === 'recurring') && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount"><Input inputMode="decimal" value={f.amount ?? ''} onChange={e => set('amount', e.target.value)} /></Field>
              {method === 'recurring' && (
                <Field label="Every (months)"><Input inputMode="numeric" value={f.everyMonths ?? ''} onChange={e => set('everyMonths', e.target.value)} /></Field>
              )}
              {method === 'recurring' && (
                <Field label="Anchor month"><Input type="month" value={f.anchor ?? ''} onChange={e => set('anchor', e.target.value)} /></Field>
              )}
              {method === 'recurring' && (
                <Field label="Annual escalation %"><Input inputMode="decimal" value={f.annualEscalation ?? ''} onChange={e => set('annualEscalation', e.target.value)} /></Field>
              )}
              <Field label="From (optional)"><Input type="month" value={f.start ?? ''} onChange={e => set('start', e.target.value)} /></Field>
              <Field label="Until (optional)"><Input type="month" value={f.end ?? ''} onChange={e => set('end', e.target.value)} /></Field>
            </div>
          )}

          {method === 'run_rate' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Trailing window">
                <select className={selectCls} value={f.window ?? '12'} onChange={e => set('window', e.target.value)} disabled={!!(f.from || f.to)}>
                  <option value="3">3 months</option>
                  <option value="6">6 months</option>
                  <option value="12">12 months</option>
                </select>
              </Field>
              <div />
              <Field label="Or custom from"><Input type="month" value={f.from ?? ''} onChange={e => set('from', e.target.value)} /></Field>
              <Field label="to"><Input type="month" value={f.to ?? ''} onChange={e => set('to', e.target.value)} /></Field>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.includeUnclosed === '1'} onChange={e => set('includeUnclosed', e.target.checked ? '1' : '')} />
                Include months that are not closed yet
              </label>
            </div>
          )}

          {method === 'growth' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base amount"><Input inputMode="decimal" value={f.base ?? ''} onChange={e => set('base', e.target.value)} /></Field>
              <Field label="Base month"><Input type="month" value={f.baseMonth ?? ''} onChange={e => set('baseMonth', e.target.value)} /></Field>
              <Field label="Rate %"><Input inputMode="decimal" value={f.rate ?? ''} onChange={e => set('rate', e.target.value)} /></Field>
              <Field label="Per">
                <select className={selectCls} value={f.per ?? 'year'} onChange={e => set('per', e.target.value)}>
                  <option value="month">Month (compounds monthly)</option>
                  <option value="year">Year (steps every 12 months)</option>
                </select>
              </Field>
            </div>
          )}

          {method === 'linked_fee' && (
            <Field label="Only this fund (optional — blank uses every linked fund)">
              <Input value={f.fundVehicle ?? ''} onChange={e => set('fundVehicle', e.target.value)} />
            </Field>
          )}
          {method === 'linked_construction' && (
            <Field label="Flow">
              <select className={selectCls} value={f.flow ?? 'fees'} onChange={e => set('flow', e.target.value)}>
                <option value="fees">Management fees</option>
                <option value="expenses">Partnership and organizational expenses</option>
              </select>
            </Field>
          )}

          {method !== 'linked_fee' && <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">{isExpense ? 'When it is paid' : 'When cash is received'}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Timing">
                <select className={selectCls} value={timing.mode} onChange={e => setTiming(t => ({ ...t, mode: e.target.value }))}>
                  <option value="same">Same month</option>
                  <option value="offset">Months later / earlier</option>
                  <option value="month">In one calendar month</option>
                </select>
              </Field>
              {timing.mode === 'offset' && (
                <Field label="Months (negative = in advance)"><Input inputMode="numeric" value={timing.months} onChange={e => setTiming(t => ({ ...t, months: e.target.value }))} /></Field>
              )}
              {timing.mode === 'month' && (
                <>
                  <Field label="Month (1–12)"><Input inputMode="numeric" value={timing.month} onChange={e => setTiming(t => ({ ...t, month: e.target.value }))} /></Field>
                  <Field label="Covering">
                    <select className={selectCls} value={timing.direction} onChange={e => setTiming(t => ({ ...t, direction: e.target.value }))}>
                      <option value="advance">The year ahead (in advance)</option>
                      <option value="arrears">The months before (in arrears)</option>
                    </select>
                  </Field>
                </>
              )}
            </div>
          </div>}

          {method === 'linked_fee' && <p className="text-xs text-muted-foreground">Cash timing follows the fee link’s billing cycle.</p>}

          <Field label="Note"><Input value={note} onChange={e => setNote(e.target.value)} /></Field>

          {rule && (rule.basis || rule.warnings.length > 0) && (
            <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
              {rule.basis && <p>{rule.basis}</p>}
              {rule.warnings.map(w => <p key={w} className="text-warning">{w}</p>)}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {rule ? <Button variant="ghost" onClick={onRemove} disabled={saving}>Remove rule</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save rule'}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
