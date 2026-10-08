// app/(app)/companies/[id]/holding-price-feed.tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, AlertTriangle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCurrency, formatCurrencyFull, formatSharePrice } from '@/components/currency-context'
import { fmtNum } from '@/components/investment-transaction-form'
import { useCanWrite } from '@/components/access-context'
import { latestOnly } from '@/lib/portfolio/latest-only'
import { quoteBasisNote } from './holding-panels'

interface Quote { id: string; as_of_date: string; price: number; basis: 'close' | 'intraday' | 'indicative' }
interface Feed {
  id: string
  symbol: string
  exchange: string | null
  quote_currency: string
  quote_scale: number
  active_from: string
  active_until: string | null
  restriction_until: string | null
  restriction_discount: number | null
}
interface Mark { delta: number; price: number; quoteDate: string; shares: number; derivedCarrying: number; ledgerCarrying: number }
interface EntityMark { vehicleId: string; entity: string; mark: Mark | null; problem: string | null }

const EMPTY = { symbol: '', exchange: '', quoteCurrency: 'USD', quoteScale: '1', activeFrom: '', restrictionUntil: '', restrictionDiscount: '' }
const today = () => new Date().toISOString().slice(0, 10)

/**
 * The price feed a holding marks from — a listed company's ticker or a token's — with the quotes
 * stored against it and the mark each of the viewer's entities still owes. Booking a mark records
 * it as a transaction on this holding (valuation source 'quote'), which posts like any recorded mark.
 */
export function HoldingPriceFeed({ companyId, kind, initialAsOf = null, highlightVehicleId = null }: {
  companyId: string
  kind: 'company' | 'crypto'
  /** The date the marks open on — the period end, when the close's blocker linked here. */
  initialAsOf?: string | null
  /** The entity the link named; its mark row is marked out. */
  highlightVehicleId?: string | null
}) {
  const currency = useCurrency()
  const canWrite = useCanWrite('portfolio', 'investments')
  const fmt = (v: number) => formatCurrencyFull(v, currency)
  const url = `/api/companies/${companyId}/price-feed`
  const [feed, setFeed] = useState<Feed | null>(null)
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [marks, setMarks] = useState<EntityMark[]>([])
  const [asOf, setAsOf] = useState(() => initialAsOf ?? today())
  const [canEditFeed, setCanEditFeed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const guard = useMemo(() => latestOnly(), [])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [marksAsOf, setMarksAsOf] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })
  const [quoteForm, setQuoteForm] = useState({ asOfDate: '', price: '', basis: 'close' })

  const load = useCallback(async () => {
    const current = guard.begin()
    setRefreshing(true)
    try {
      // Today is the route's default: leave it off so the request is the same every day (the
      // public demo answers recorded requests by their exact URL).
      const res = await fetch(asOf === today() ? url : `${url}?asOf=${asOf}`)
      const data = await res.json().catch(() => null)
      if (!current()) return
      if (!res.ok || !data) {
        setLoadError(data?.error ?? 'Could not load the price feed.')
        return
      }
      setFeed(data.feed ?? null)
      setQuotes(data.quotes ?? [])
      setMarks(data.marks ?? [])
      setMarksAsOf(typeof data.asOf === 'string' ? data.asOf : asOf)
      setCanEditFeed(data.canEditFeed === true)
      setLoaded(true)
      setLoadError(null)
    } catch {
      if (current()) setLoadError('Could not load the price feed.')
    } finally {
      if (current()) { setLoading(false); setRefreshing(false) }
    }
  }, [url, asOf, guard])
  useEffect(() => { void load() }, [load])

  const post = async (body: object) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'That did not save.'); return null }
      await load()
      return data
    } finally { setBusy(false) }
  }

  function startEdit() {
    setForm(feed ? {
      symbol: feed.symbol,
      exchange: feed.exchange ?? '',
      quoteCurrency: feed.quote_currency,
      quoteScale: String(feed.quote_scale),
      activeFrom: feed.active_from,
      restrictionUntil: feed.restriction_until ?? '',
      restrictionDiscount: feed.restriction_discount == null ? '' : String(Number((feed.restriction_discount * 100).toFixed(6))),
    } : { ...EMPTY })
    setEditing(true)
  }

  async function saveFeed() {
    const d = await post({
      action: 'set',
      kind: kind === 'crypto' ? 'digital_asset' : 'listed_equity',
      symbol: form.symbol,
      exchange: form.exchange || null,
      quoteCurrency: form.quoteCurrency,
      quoteScale: form.quoteScale,
      activeFrom: form.activeFrom,
      restrictionUntil: form.restrictionUntil || null,
      restrictionDiscount: form.restrictionDiscount ? Number(form.restrictionDiscount) / 100 : null,
    })
    if (d) { setEditing(false); setNote(`${form.symbol.trim()} now prices this holding.`) }
  }

  async function removeFeed() {
    setConfirmRemove(false)
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(url, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Could not remove the feed.')
        return
      }
      setNote('No longer priced by a feed — it marks from its recorded valuations again.')
      await load()
    } finally { setBusy(false) }
  }

  async function recordQuote() {
    const d = await post({ action: 'record-quote', asOfDate: quoteForm.asOfDate, price: Number(quoteForm.price), basis: quoteForm.basis })
    if (d) setQuoteForm({ asOfDate: '', price: '', basis: 'close' })
  }

  async function book(m: EntityMark) {
    // The date the displayed marks were fetched for, not whatever the picker has moved to since.
    setBookingId(m.vehicleId)
    const d = await post({ action: 'book', group: m.entity, asOf: marksAsOf })
    setBookingId(null)
    if (!d) return
    setNote(d.ledger?.posted === false
      ? `Recorded ${m.entity}'s mark; the entry is kept as a draft: ${d.ledger.reason}`
      : `Booked ${m.entity}'s mark of ${fmt(d.mark.delta)} and posted it to the ledger.`)
  }

  if (loading && !loaded) {
    return <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading the price feed…</div>
  }

  if (loadError && !loaded) {
    return (
      <section className="mt-6 space-y-3">
        <h2 className="text-base font-medium">Price feed</h2>
        <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{loadError}</p>
      </section>
    )
  }

  const mayEditFeed = canWrite && canEditFeed

  return (
    <section className="mt-6 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-medium">Price feed</h2>
        {mayEditFeed && !editing && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={startEdit} disabled={busy}>
            {feed ? 'Edit feed' : <><Plus className="h-3.5 w-3.5 mr-1" />Add a price feed</>}
          </Button>
        )}
      </div>

      {loadError && <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{loadError}</p>}
      {error && <p className="flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>}
      {note && <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><Check className="h-4 w-4 mt-0.5 shrink-0 text-success" />{note}</p>}

      {!feed && !editing && (
        <p className="text-sm text-muted-foreground">
          Not priced by a market — it is valued from its recorded transactions. A feed is what makes a
          position Level 1 or 2 in the fair value hierarchy.
          {canWrite && !canEditFeed && ' Another entity also holds this, so only someone who sees every entity can add one.'}
        </p>
      )}

      {mayEditFeed && editing && (
        <div className="rounded-card border p-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="pf-symbol" className="text-xs">Symbol</Label>
              <Input id="pf-symbol" value={form.symbol} placeholder={kind === 'crypto' ? 'ETH' : 'ACME'} onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))} />
            </div>
            {kind === 'company' && (
              <div className="space-y-1">
                <Label htmlFor="pf-exchange" className="text-xs">Exchange</Label>
                <Input id="pf-exchange" value={form.exchange} placeholder="XNAS" onChange={e => setForm(f => ({ ...f, exchange: e.target.value }))} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="pf-currency" className="text-xs">Quoted in</Label>
              <Input id="pf-currency" value={form.quoteCurrency} onChange={e => setForm(f => ({ ...f, quoteCurrency: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pf-scale" className="text-xs">Quote scale</Label>
              <Input id="pf-scale" type="number" className="tabular-nums" value={form.quoteScale} onChange={e => setForm(f => ({ ...f, quoteScale: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pf-from" className="text-xs">Prices this holding from</Label>
              <Input id="pf-from" type="date" value={form.activeFrom} onChange={e => setForm(f => ({ ...f, activeFrom: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pf-until" className="text-xs">Restricted until</Label>
              <Input id="pf-until" type="date" value={form.restrictionUntil} onChange={e => setForm(f => ({ ...f, restrictionUntil: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pf-discount" className="text-xs">Restriction discount (%)</Label>
              <Input id="pf-discount" type="number" className="tabular-nums" value={form.restrictionDiscount} onChange={e => setForm(f => ({ ...f, restrictionDiscount: e.target.value }))} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Quote scale is 100 for a listing quoted in pence, 1 otherwise. Periods before the start date
            are valued from the holding&rsquo;s own transactions.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveFeed} disabled={busy || !form.symbol.trim() || !form.activeFrom}>Save feed</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {feed && !editing && (
        <div className="rounded-card border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium">{feed.symbol}</span>
            {feed.exchange && <span className="text-muted-foreground">{feed.exchange}</span>}
            <span className="text-muted-foreground">Quoted in {feed.quote_currency}{Number(feed.quote_scale) !== 1 ? ` ÷ ${feed.quote_scale}` : ''}</span>
            <span className="text-muted-foreground">From {feed.active_from}{feed.active_until ? ` to ${feed.active_until}` : ''}</span>
            {mayEditFeed && !confirmRemove && (
              <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setConfirmRemove(true)} disabled={busy} aria-label="Remove the price feed">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {mayEditFeed && confirmRemove && (
              <span className="ml-auto flex items-center gap-2">
                <span className="text-sm">Remove this feed and its quotes?</span>
                <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={removeFeed} disabled={busy}>Remove</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmRemove(false)}>Keep</Button>
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{quoteBasisNote(quotes[0] ?? null)}</p>
          {mayEditFeed && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="q-date" className="text-xs">Quote date</Label>
                <Input id="q-date" type="date" className="w-40" value={quoteForm.asOfDate} onChange={e => setQuoteForm(q => ({ ...q, asOfDate: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="q-price" className="text-xs">Price</Label>
                <Input id="q-price" type="number" step="any" className="w-36 tabular-nums" value={quoteForm.price} onChange={e => setQuoteForm(q => ({ ...q, price: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="q-basis" className="text-xs">Basis</Label>
                <select id="q-basis" value={quoteForm.basis} onChange={e => setQuoteForm(q => ({ ...q, basis: e.target.value }))} className="border rounded-lg px-2 py-1 text-sm h-9 bg-background">
                  <option value="close">Official close</option>
                  <option value="intraday">Intraday</option>
                  <option value="indicative">Indicative</option>
                </select>
              </div>
              <Button size="sm" onClick={recordQuote} disabled={busy || !quoteForm.asOfDate || !quoteForm.price}>Save quote</Button>
            </div>
          )}
          {quotes.length > 0 && (
            <table className="w-full text-sm">
              <tbody>
                {quotes.map(q => (
                  <tr key={q.id} className="border-t">
                    <td className="py-1.5 tabular-nums">{q.as_of_date}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatSharePrice(Number(q.price), feed.quote_currency)}</td>
                    <td className="py-1.5 pl-3 text-xs text-muted-foreground capitalize">{q.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {feed && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium">Marks owed</h3>
            <span className="ml-auto text-sm text-muted-foreground">As of</span>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="border rounded-lg px-2 py-1 text-sm" />
          </div>
          {marks.length === 0 ? (
            <p className="text-sm text-muted-foreground">None of your entities hold this yet.</p>
          ) : (
            <ul className="rounded-card border divide-y">
              {marks.map(m => (
                <li
                  key={m.vehicleId}
                  aria-current={m.vehicleId === highlightVehicleId ? 'true' : undefined}
                  className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm${m.vehicleId === highlightVehicleId ? ' bg-muted' : ''}`}
                >
                  <span className="font-medium">{m.entity}</span>
                  {m.mark ? (
                    <>
                      <span className="text-muted-foreground tabular-nums">
                        {fmtNum(m.mark.shares)} at {formatSharePrice(m.mark.price, currency)} on {m.mark.quoteDate} is {fmt(m.mark.derivedCarrying)}; the books carry {fmt(m.mark.ledgerCarrying)}
                      </span>
                      {canWrite && (
                        <Button size="sm" className="ml-auto h-7 text-xs" onClick={() => book(m)} disabled={busy || refreshing || marksAsOf !== asOf}>
                          {bookingId === m.vehicleId ? 'Booking…' : `Book ${fmt(m.mark.delta)} mark`}
                        </Button>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{m.problem}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
