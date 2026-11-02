'use client'

// A vehicle's carry terms — what the close accrues carried interest on.
//
// Rates are entered as PERCENTAGES here and stored as fractions. Nobody thinks in 0.2; they
// think in 20%. The conversion happens at this boundary and nowhere else.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLedgerFetch } from '@/components/accounting-vehicle'

type Kind = 'none' | 'straight' | 'american' | 'european'

interface Candidate { lpEntityId: string; name: string; partnerClass: string }
interface Recipient { lpEntityId: string; pct: number }
interface Step { lpMultiple?: number; lpIrr?: number; carryRate: number; catchUpRate?: number; catchUpMeasure?: 'profit' | 'split' }
/** A step as typed: the threshold and rates are strings until saved. */
interface StepRow { at: 'multiple' | 'irr'; threshold: string; carry: string; catchUp: string; measure: 'profit' | 'split' }

interface Terms {
  kind: Kind
  carryRate: number
  prefRate: number
  catchupRate: number
  catchupSize?: number
  prefCompounds: boolean
  prefBase?: 'contributed' | 'unreturned'
  prefMultiple?: number | null
  prefDayCount?: 'act/365' | '30/360'
  catchupMeasure?: 'preferred' | 'profit'
  carrySteps?: Step[]
  capitalIncludes?: string[]
  gpCommitBearsCarry?: boolean
  waterfallScope?: 'fund' | 'per_lp'
  recipients: Recipient[]
}

// Percent <-> fraction at the UI boundary. 0 renders as '0' (a real, editable value) rather than
// blank — a blank field reads as "unset", and for a rate that is a meaningful, different claim.
const pct = (fraction: number) => String(Math.round((fraction || 0) * 10000) / 100)
const frac = (percent: string) => {
  if (percent.trim() === '') return 0
  const n = Number(percent)
  return Number.isFinite(n) ? n / 100 : 0
}

export function CarryTerms() {
  const lf = useLedgerFetch()

  const [kind, setKind] = useState<Kind>('none')
  const [carry, setCarry] = useState('')
  // Defaults: no preferred return, no GP catch-up, simple (non-compounding) pref. Funds add these
  // deliberately; starting them at zero means a saved term only carries what was actually entered.
  const [pref, setPref] = useState('0')
  const [catchup, setCatchup] = useState('0')
  const [compounds, setCompounds] = useState(false)
  const [prefBase, setPrefBase] = useState<'contributed' | 'unreturned'>('contributed')
  const [catchupSize, setCatchupSize] = useState('100')
  // A hurdle is a rate (accruing) or a multiple of capital (flat). Most LPAs say a rate.
  const [hurdleAs, setHurdleAs] = useState<'rate' | 'multiple'>('rate')
  const [multiple, setMultiple] = useState('')
  const [dayCount, setDayCount] = useState<'act/365' | '30/360'>('act/365')
  const [catchupMeasure, setCatchupMeasure] = useState<'preferred' | 'profit'>('preferred')
  const [steps, setSteps] = useState<StepRow[]>([])
  const [investedOnly, setInvestedOnly] = useState(false)
  const [gpCommitBearsCarry, setGpCommitBearsCarry] = useState(false)
  const [waterfallScope, setWaterfallScope] = useState<'fund' | 'per_lp'>('fund')
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [vehicleName, setVehicleName] = useState('')

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const applyTerms = useCallback((d: any) => {
    const t: Terms = d.terms
    setKind(t.kind)
    setCarry(t.carryRate ? pct(t.carryRate) : '')
    setPref(pct(t.prefRate))
    setCatchup(pct(t.catchupRate))
    setCompounds(t.prefCompounds)
    setPrefBase(t.prefBase === 'unreturned' ? 'unreturned' : 'contributed')
    setCatchupSize(pct(t.catchupSize ?? 1))
    setHurdleAs(t.prefMultiple != null ? 'multiple' : 'rate')
    setMultiple(t.prefMultiple != null ? String(t.prefMultiple) : '')
    setDayCount(t.prefDayCount === '30/360' ? '30/360' : 'act/365')
    setCatchupMeasure(t.catchupMeasure === 'profit' ? 'profit' : 'preferred')
    setSteps((t.carrySteps ?? []).map(st => ({
      at: st.lpIrr != null ? 'irr' : 'multiple',
      threshold: st.lpIrr != null ? pct(st.lpIrr) : String(st.lpMultiple ?? ''),
      carry: pct(st.carryRate),
      catchUp: st.catchUpRate ? pct(st.catchUpRate) : '',
      measure: st.catchUpMeasure === 'split' ? 'split' : 'profit',
    })))
    setInvestedOnly(Array.isArray(t.capitalIncludes) && t.capitalIncludes.length === 1 && t.capitalIncludes[0] === 'investments')
    setGpCommitBearsCarry(t.gpCommitBearsCarry === true)
    setWaterfallScope(t.waterfallScope === 'per_lp' ? 'per_lp' : 'fund')
    setRecipients(t.recipients ?? [])
    setCandidates(d.candidates ?? [])
    setVehicleName(d.group ?? '')
  }, [])

  const load = useCallback(async () => {
    const res = await lf('/api/accounting/waterfall-terms')
    if (res.ok) applyTerms(await res.json())
    setLoading(false)
  }, [lf, applyTerms])

  // Load once per vehicle. A ref guards against the fetch re-firing (e.g. when the vehicle context
  // hydrates) and OVERWRITING what the user has typed but not yet saved — the bug that made carry
  // silently save as 0. A genuine vehicle switch changes `lf` and re-arms the guard below.
  const loadedForLf = useRef<unknown>(null)
  useEffect(() => {
    if (loadedForLf.current === lf) return
    loadedForLf.current = lf
    void load()
  }, [lf, load])

  const save = async () => {
    setBusy(true); setError(null); setSaved(false)
    const res = await lf('/api/accounting/waterfall-terms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        carryRate: frac(carry),
        prefRate: frac(pref),
        catchupRate: frac(catchup),
        catchupSize: catchupSize.trim() === '' ? 1 : frac(catchupSize),
        prefCompounds: compounds,
        prefBase,
        prefMultiple: hurdleAs === 'multiple' && multiple.trim() !== '' ? Number(multiple) : null,
        prefDayCount: dayCount,
        catchupMeasure,
        carrySteps: steps.map(st => ({
          ...(st.at === 'irr' ? { lpIrr: frac(st.threshold) } : { lpMultiple: st.threshold.trim() === '' ? null : Number(st.threshold) }),
          carryRate: frac(st.carry),
          ...(st.catchUp.trim() !== '' && frac(st.catchUp) > 0
            ? { catchUpRate: frac(st.catchUp), ...(st.measure === 'split' ? { catchUpMeasure: 'split' } : {}) }
            : {}),
        })),
        capitalIncludes: investedOnly ? ['investments'] : ['investments', 'fees', 'expenses', 'other'],
        gpCommitBearsCarry,
        // Per LP is European or straight only; American runs whole fund.
        waterfallScope: kind === 'american' ? 'fund' : waterfallScope,
        carryRecipients: recipients,
      }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setBusy(false); setError(d.error ?? 'Could not save'); return }
    // Reload from the server so the form shows exactly what PERSISTED — no more "save, navigate
    // away, and the old value reappears". If a field didn't take, you see it immediately.
    const reread = await lf('/api/accounting/waterfall-terms')
    if (reread.ok) applyTerms(await reread.json())
    setBusy(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />Loading carry terms…
    </div>
  }

  const carryOn = kind !== 'none'
  const hasHurdle = kind === 'european' || kind === 'american' // a straight split has no pref or catch-up
  const carryMissing = carryOn && frac(carry) <= 0

  const totalPct = recipients.reduce((sum, r) => sum + (r.pct || 0), 0)
  const recipientsInvalid = carryOn && !carryMissing && (recipients.length === 0 || Math.abs(totalPct - 100) > 0.01)

  const toggleRecipient = (lpEntityId: string) => {
    setRecipients(prev => {
      const exists = prev.some(r => r.lpEntityId === lpEntityId)
      const ids = exists
        ? prev.filter(r => r.lpEntityId !== lpEntityId).map(r => r.lpEntityId)
        : [...prev.map(r => r.lpEntityId), lpEntityId]
      // Even split that always totals 100 (last absorbs the remainder); fine-tune per row after.
      const n = ids.length
      const each = n > 0 ? Math.round(100 / n) : 0
      return ids.map((id, i) => ({ lpEntityId: id, pct: i === n - 1 ? 100 - each * (n - 1) : each }))
    })
  }

  const setRecipientPct = (lpEntityId: string, pctStr: string) => {
    const n = Number(pctStr)
    const value = pctStr.trim() === '' ? 0 : (Number.isFinite(n) ? n : 0)
    setRecipients(prev => prev.map(r => r.lpEntityId === lpEntityId ? { ...r, pct: value } : r))
  }

  return (
    <div className="space-y-3">
      {vehicleName && <p className="text-xs text-muted-foreground">{vehicleName}</p>}
      <p className="text-xs text-muted-foreground max-w-3xl">
        The close accrues carry on <strong>unrealized</strong> gains, as if the fund liquidated at
        that period&rsquo;s NAV. Without it every LP&rsquo;s reported NAV overstates what they would
        actually receive by the GP&rsquo;s share of the gain. It reverses on its own if NAV falls.
      </p>

      <div className="flex flex-wrap gap-1.5 pt-1">
        {([
          ['none', 'No carry'],
          ['straight', 'Straight split'],
          ['american', 'American (deal-by-deal)'],
          ['european', 'European (pref + catch-up)'],
        ] as [Kind, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${ kind === k ? 'border-foreground/30 bg-accent font-medium' : 'border-border text-muted-foreground hover:text-foreground' }`}
          >
            {label}
          </button>
        ))}
      </div>

      {kind === 'none' && (
        <p className="text-xs text-muted-foreground">
          Nothing is accrued. This is the default &mdash; accruing carry nobody agreed to is worse
          than accruing none.
        </p>
      )}

      {kind === 'american' && (
        <p className="text-xs text-muted-foreground max-w-3xl">
          Deal-by-deal: a distribution first returns the LPs&rsquo; capital in every deal realized so
          far, written-off deals included, with its share of fees and expenses and the preferred
          return on it. Carry is paid on what is left, before the whole fund is made whole. Realized
          deals come from the portfolio&rsquo;s exits and write-offs.
          <strong> Total carry is the same as European; only the timing differs.</strong> The accrued
          mark is the whole-fund figure, the GP&rsquo;s ultimate entitlement once the clawback is
          applied.
        </p>
      )}

      {carryOn && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Carry" hint="GP's share of profit">
              <Suffix suffix="%">
                <Input value={carry} onChange={e => setCarry(e.target.value)} placeholder="e.g. 20" />
              </Suffix>
            </Field>

            {hasHurdle && (
              <>
                {hurdleAs === 'rate' ? (
                  <Field label="Preferred return" hint="Annual hurdle (0 = none)">
                    <Suffix suffix="%">
                      <Input value={pref} onChange={e => setPref(e.target.value)} />
                    </Suffix>
                  </Field>
                ) : (
                  <Field label="Hurdle multiple" hint="Capital back times this before the catch-up">
                    <Suffix suffix="×">
                      <Input value={multiple} onChange={e => setMultiple(e.target.value)} placeholder="e.g. 1.08" />
                    </Suffix>
                  </Field>
                )}
                <Field label="Catch-up rate" hint="GP's share of each dollar while it catches up (0 = none)">
                  <Suffix suffix="%">
                    <Input value={catchup} onChange={e => setCatchup(e.target.value)} />
                  </Suffix>
                </Field>
                {frac(catchup) > 0 && (
                  <Field label="Catch-up size" hint="Share of a full catch-up the GP gets (100% = full)">
                    <Suffix suffix="%">
                      <Input value={catchupSize} onChange={e => setCatchupSize(e.target.value)} />
                    </Suffix>
                  </Field>
                )}
              </>
            )}

          </div>

          <Field label="Carry accrues to" hint="Which partner(s) receive it, and their share">
            <div className="space-y-1.5">
              {candidates.map(c => {
                const r = recipients.find(x => x.lpEntityId === c.lpEntityId)
                const checked = !!r
                return (
                  <div key={c.lpEntityId} className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-sm flex-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRecipient(c.lpEntityId)}
                      />
                      {c.name}{c.partnerClass === 'gp' ? ' (GP)' : ''}
                    </label>
                    {checked && (
                      <div className="w-20">
                        <Suffix suffix="%">
                          <Input
                            value={String(r.pct)}
                            onChange={e => setRecipientPct(c.lpEntityId, e.target.value)}
                            className="h-8 text-sm"
                          />
                        </Suffix>
                      </div>
                    )}
                  </div>
                )
              })}
              <p className={`text-sm ${Math.abs(totalPct - 100) > 0.01 && recipients.length > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                Total: {totalPct}%
              </p>
            </div>
          </Field>

          {hasHurdle && (
            <Field label="The hurdle is" hint="Most LPAs set a rate that accrues">
              <Choice
                value={hurdleAs}
                onChange={setHurdleAs}
                options={[['rate', 'A rate'], ['multiple', 'A multiple of capital']]}
              />
            </Field>
          )}

          {hasHurdle && hurdleAs === 'rate' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={compounds} onChange={e => setCompounds(e.target.checked)} />
              The preferred return compounds annually
            </label>
          )}

          {hasHurdle && hurdleAs === 'rate' && (
            <Field label="Years are counted" hint="Actual days unless the LPA says 30/360">
              <Choice
                value={dayCount}
                onChange={setDayCount}
                options={[['act/365', 'Actual/365'], ['30/360', '30/360']]}
              />
            </Field>
          )}

          {hasHurdle && frac(catchup) > 0 && frac(catchup) < 1 && (
            <Field label="The catch-up runs until the GP has" hint="They differ only when the LPs share the catch-up">
              <Choice
                value={catchupMeasure}
                onChange={setCatchupMeasure}
                options={[['preferred', 'Its share of the preferred return'], ['profit', 'Its share of all profit']]}
              />
            </Field>
          )}

          {hasHurdle && hurdleAs === 'rate' && (
            <Field label="Preferred return accrues on" hint="Most LPAs say unreturned capital">
              <div className="flex flex-wrap gap-1.5">
                {([
                  ['contributed', 'All contributed capital'],
                  ['unreturned', 'Unreturned capital'],
                ] as ['contributed' | 'unreturned', string][]).map(([b, label]) => (
                  <button
                    key={b}
                    onClick={() => setPrefBase(b)}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${ prefBase === b ? 'border-foreground/30 bg-accent font-medium' : 'border-border text-muted-foreground hover:text-foreground' }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label="GP commit pays carry" hint="Most LPAs leave the GP's own commitment carry-free">
            <Choice
              value={gpCommitBearsCarry ? 'yes' : 'no'}
              onChange={v => setGpCommitBearsCarry(v === 'yes')}
              options={[['no', 'No'], ['yes', 'Yes']]}
            />
          </Field>
          {gpCommitBearsCarry && (
            <p className="text-xs text-muted-foreground max-w-3xl">
              The carry recipients&rsquo; own capital runs through the waterfall with the LPs&rsquo;
              when a distribution is split, instead of taking its share beside it, and the carry it
              pays goes to the recipients. The close&rsquo;s carry accrual still measures the
              LPs&rsquo; carry only.
            </p>
          )}

          <Field label="The waterfall runs" hint="Most LPAs run it for the whole fund">
            {kind === 'american' ? (
              <span className="text-sm text-muted-foreground">For the whole fund (each LP isn&rsquo;t supported with deal-by-deal terms)</span>
            ) : (
              <Choice
                value={waterfallScope}
                onChange={v => setWaterfallScope(v === 'per_lp' ? 'per_lp' : 'fund')}
                options={[['fund', 'For the whole fund'], ['per_lp', 'For each LP']]}
              />
            )}
          </Field>
          {waterfallScope === 'per_lp' && kind !== 'american' && (
            <p className="text-xs text-muted-foreground max-w-3xl">
              Each distribution is divided among the LPs by their share of contributed capital at the
              date, and each LP&rsquo;s share runs through its own return of capital, preferred return,
              catch-up and split, on its own contributions and what it has already received. The
              close accrues carry the same way, so each LP is charged its own carry. Forecasts still
              run the waterfall for the whole fund, since a forecast has no per-LP timing.
            </p>
          )}

          <Field label="Capital returned before carry" hint="Most LPAs return fees and expenses too">
            <Choice
              value={investedOnly ? 'invested' : 'all'}
              onChange={v => setInvestedOnly(v === 'invested')}
              options={[['all', 'All contributions'], ['invested', 'Invested capital only']]}
            />
          </Field>
          {investedOnly && (
            <p className="text-xs text-muted-foreground max-w-3xl">
              The capital that paid management fees and partnership expenses is not returned before
              the split, and the preferred return doesn&rsquo;t accrue on it. The books don&rsquo;t say
              which call paid which fee, so each fee uses the partner&rsquo;s oldest capital first.
            </p>
          )}

          <Field label="Carry steps up" hint="A higher rate once the LPs reach a multiple or an IRR">
            <div className="space-y-2">
              {steps.map((st, i) => {
                const set = (patch: Partial<StepRow>) => setSteps(prev => prev.map((x, j) => j === i ? { ...x, ...patch } : x))
                return (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Choice value={st.at} onChange={at => set({ at })} options={[['multiple', 'LP multiple'], ['irr', 'LP IRR']]} />
                    <div className="w-24">
                      <Suffix suffix={st.at === 'irr' ? '%' : '×'}>
                        <Input value={st.threshold} onChange={e => set({ threshold: e.target.value })} placeholder={st.at === 'irr' ? 'e.g. 15' : 'e.g. 2.5'} className="h-8 text-sm" />
                      </Suffix>
                    </div>
                    <span className="text-xs text-muted-foreground pb-2">then</span>
                    <div className="w-24">
                      <Suffix suffix="%">
                        <Input value={st.carry} onChange={e => set({ carry: e.target.value })} placeholder="carry" className="h-8 text-sm" />
                      </Suffix>
                    </div>
                    <div className="w-32">
                      <Suffix suffix="%">
                        <Input value={st.catchUp} onChange={e => set({ catchUp: e.target.value })} placeholder="catch-up (opt.)" className="h-8 text-sm" />
                      </Suffix>
                    </div>
                    {st.catchUp.trim() !== '' && (
                      <Choice value={st.measure} onChange={measure => set({ measure })} options={[['profit', 'of all profit'], ['split', 'of the split']]} />
                    )}
                    <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setSteps(prev => prev.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                )
              })}
              <Button size="sm" variant="outline" className="text-muted-foreground" onClick={() => setSteps(prev => [...prev, { at: 'multiple', threshold: '', carry: '', catchUp: '', measure: 'profit' }])}>
                Add a step
              </Button>
            </div>
          </Field>

          {/* Carry of 0% accrues nothing — the single most common reason "carry isn't showing up".
              Warn in place rather than silently saving a term that does nothing. */}
          {carryMissing && (
            <p className="text-sm text-warning flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Carry is 0% — nothing will accrue. Enter the GP&rsquo;s share (e.g. 20).
            </p>
          )}

          {/* The carry has to land in real partners' capital accounts, or it belongs to nobody
              — it never shows in any capital account, and the associates look-through can't
              split it. Say so before they hit Save and get a 400. */}
          {recipientsInvalid && (
            <p className="text-sm text-warning flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Recipient shares must total 100%.
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Each partner&rsquo;s <strong>carry points</strong> can differ from their capital: set a
            weight override on the <em>Carried interest</em> column below. A partner may hold carry
            points with no commitment at all.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-warning">{error}</p>}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="outline" className="text-muted-foreground" onClick={save} disabled={busy || recipientsInvalid}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
          Save carry terms
        </Button>
        {saved && <span className="text-xs text-success">Saved</span>}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Suffix({ suffix, children }: { suffix: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
    </div>
  )
}

/** A row of exclusive choices, styled like the other toggles on this page. */
function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${ value === v ? 'border-foreground/30 bg-accent font-medium' : 'border-border text-muted-foreground hover:text-foreground' }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

