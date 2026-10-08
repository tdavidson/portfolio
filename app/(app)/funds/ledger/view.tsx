'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { PeriodPicker } from '@/components/accounting/period-picker'
import { AccountPicker, type PickerAccount } from '@/components/accounting/account-picker'
import { PERIOD_PRESETS, type PeriodPreset } from '@/lib/accounting/statement-period'
import type { AccountRegister } from '@/lib/accounting/register'
import { EmptyState } from '@/components/ui/empty-state'
import { EntryModal } from '../entry-modal'

interface Period { preset: PeriodPreset; start: string | null; end: string | null; label: string }
interface Data { period: Period; accounts: PickerAccount[]; register: AccountRegister | null; error?: string }

const isPreset = (v: string | null): v is PeriodPreset => !!v && PERIOD_PRESETS.some(p => p.value === v)

/**
 * The general ledger, one account at a time: the balance carried in, every posted line with the
 * accounts on the other side of it, a running balance, and the closing balance — the page a
 * statement line, a trial balance row or a journal posting links to.
 *
 * The URL carries the account and the period (`?account=1000&preset=ytd`), so a register is a
 * link you can send. `?highlight=<entryId>` marks one entry and scrolls to it, which is how
 * "Save & post" lands you on the account you just hit.
 */
export function LedgerView() {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const lf = useLedgerFetch()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [accountRef, setAccountRef] = useState<string>(params.get('account') ?? '')
  const [preset, setPreset] = useState<PeriodPreset>(isPreset(params.get('preset')) ? params.get('preset') as PeriodPreset : 'ytd')
  const [start, setStart] = useState(params.get('start') ?? '')
  const [end, setEnd] = useState(params.get('end') ?? '')
  const [highlight, setHighlight] = useState<string | null>(params.get('highlight'))
  // Carried from a tax-basis statement link: the register then reads the ledger plus the overlay.
  const basis = params.get('basis') === 'tax' ? 'tax' : 'book'
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    setLoading(true); setError(null)
    const qs = new URLSearchParams({ preset })
    if (preset === 'custom') { if (start) qs.set('start', start); if (end) qs.set('end', end) }
    if (accountRef) qs.set('account', accountRef)
    if (basis === 'tax') qs.set('basis', 'tax')
    lf(`/api/accounting/ledger?${qs}`)
      .then(r => r.json().then(d => (r.ok ? d : Promise.reject(new Error(d?.error ?? `Request failed (${r.status})`)))))
      .then(setData)
      .catch(e => { setData(null); setError(e?.message ?? 'Could not load the register') })
      .finally(() => setLoading(false))
  }, [lf, preset, start, end, accountRef, reloadKey, basis])

  // Keep the URL in step with what is on screen, so the register can be bookmarked or sent.
  // Replace, not push: changing the account is not a page the back button should revisit.
  useEffect(() => {
    const qs = new URLSearchParams()
    if (accountRef) qs.set('account', accountRef)
    qs.set('preset', preset)
    if (preset === 'custom') { if (start) qs.set('start', start); if (end) qs.set('end', end) }
    if (highlight) qs.set('highlight', highlight)
    if (basis === 'tax') qs.set('basis', 'tax')
    const next = `${pathname}?${qs}`
    if (typeof window !== 'undefined' && window.location.pathname + window.location.search !== next) router.replace(next, { scroll: false })
  }, [accountRef, preset, start, end, highlight, basis, pathname, router])

  // Scroll the highlighted entry into view once its row exists.
  const highlightRef = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    if (!loading && highlight && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [loading, highlight, data])

  const reg = data?.register ?? null
  const accounts = data?.accounts ?? []
  const selectedId = accounts.find(a => a.code === accountRef || a.id === accountRef)?.id ?? ''
  const period = data?.period
  const openingLabel = period?.start ? `Opening balance at ${period.start}` : 'Opening balance — inception'
  const closingLabel = period?.end ? `Closing balance at ${period.end}` : 'Closing balance'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <AccountPicker
          accounts={accounts}
          value={selectedId}
          onChange={id => {
            const a = accounts.find(x => x.id === id)
            setAccountRef(a ? a.code : '')
            setHighlight(null)
          }}
          className="w-full max-w-md"
        />
        <div className="ml-auto">
          <PeriodPicker
            preset={preset} onPreset={p => { setPreset(p); setHighlight(null) }}
            start={start} end={end} onStart={setStart} onEnd={setEnd}
          />
        </div>
      </div>

      {error && <p className="text-sm text-warning">{error}</p>}

      {loading && !data ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : !accountRef ? (
        <EmptyState>Pick an account to see its register — every posting, with the balance before and after.</EmptyState>
      ) : !reg ? null : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div>
              <h2 className="text-base font-semibold">
                <span className="tabular-nums text-muted-foreground mr-2">{reg.account.code}</span>{reg.account.name}
              </h2>
              <p className="text-xs text-muted-foreground">
                {reg.account.type} · {reg.account.normalSide}-normal, so the balance rises on a {reg.account.normalSide}
                {basis === 'tax' && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">tax basis</span>}
                {loading && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">{closingLabel}</div>
              <div className="text-lg font-semibold tabular-nums">{fmt(reg.closing)}</div>
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            {/* Fixed layout: the date and the three amount columns take a set width each, and
                Entry and Against split what is left evenly. Auto layout gave Against, whose
                lines were unwrappable, everything it asked for and squeezed the memo into the
                remainder. The min width keeps the split honest on a phone, where the wrapper
                scrolls instead. */}
            <table className="w-full min-w-[48rem] table-fixed text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs">
                  <th className="w-28 text-left px-3 py-2 font-medium whitespace-nowrap">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Entry</th>
                  <th className="text-left px-3 py-2 font-medium">Against</th>
                  <th className="w-32 text-right px-3 py-2 font-medium">Debit</th>
                  <th className="w-32 text-right px-3 py-2 font-medium">Credit</th>
                  <th className="w-36 text-right px-3 py-2 font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b bg-muted/20 text-muted-foreground">
                  <td className="px-3 py-1.5 tabular-nums">{period?.start ?? ''}</td>
                  <td className="px-3 py-1.5" colSpan={4}>{openingLabel}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(reg.opening)}</td>
                </tr>
                {reg.lines.length === 0 && (
                  <tr className="border-b">
                    <td className="px-3 py-3 text-muted-foreground" colSpan={6}>No posted activity in this period.</td>
                  </tr>
                )}
                {reg.lines.map((l, i) => {
                  const isHighlight = l.entryId === highlight
                  return (
                    <tr
                      key={`${l.entryId}-${i}`}
                      ref={isHighlight && !reg.lines.slice(0, i).some(x => x.entryId === highlight) ? highlightRef : undefined}
                      onClick={() => setViewing(l.entryId)}
                      className={`border-b last:border-b-0 cursor-pointer hover:bg-muted/30 ${isHighlight ? 'bg-primary/10' : ''}`}
                    >
                      <td className="px-3 py-1.5 tabular-nums whitespace-nowrap align-top">{l.entryDate ?? '—'}</td>
                      <td className="px-3 py-1.5 align-top break-words">
                        <div>{l.memo || <span className="text-muted-foreground">(no memo)</span>}</div>
                        {l.sourceType && l.sourceType !== 'manual' && (
                          <div className="text-[11px] text-muted-foreground">{l.sourceType.replace(/_/g, ' ')}</div>
                        )}
                      </td>
                      <td className="px-3 py-1.5 align-top break-words text-muted-foreground">
                        {l.counterAccounts.map(c => (
                          <div key={c.id}><span className="tabular-nums">{c.code}</span> {c.name}</div>
                        ))}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums align-top">{l.debit ? fmt(l.debit) : ''}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums align-top">{l.credit ? fmt(l.credit) : ''}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums align-top font-medium">{fmt(l.running)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-3 py-2 tabular-nums">{period?.end ?? ''}</td>
                  <td className="px-3 py-2" colSpan={2}>{closingLabel}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(reg.totals.debit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(reg.totals.credit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(reg.closing)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Posted entries only. Click a line to open the entry; the closing balance is this account&rsquo;s trial balance{period?.end ? ` at ${period.end}` : ''}.
          </p>
        </div>
      )}

      {viewing && (
        <EntryModal
          entryId={viewing}
          readOnly
          onClose={() => setViewing(null)}
          onSaved={() => setReloadKey(k => k + 1)}
        />
      )}
    </div>
  )
}
