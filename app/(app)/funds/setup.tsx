'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFundSeg, useVehicle, useLedgerFetch } from '@/components/accounting-vehicle'
import { Button } from '@/components/ui/button'
import { isManagementCompany } from '@/lib/vehicle-kinds'

/** Secondary actions: none is THE next step, so none takes the primary fill. */
const MUTED = 'text-muted-foreground hover:text-foreground'

/** Ordinary data-entry actions, available throughout the life of an entity. */
export function AccountingSetup(_props: { alwaysShow?: boolean; onSetup?: () => void } = {}) {
  const router = useRouter()
  const lf = useLedgerFetch()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function record() {
    setBusy(true); setError(null)
    try {
      const res = await lf('/api/accounting/chart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not prepare the accounts')
      router.push(`/funds/${seg}/journal`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not prepare the accounts') }
    finally { setBusy(false) }
  }
  const seg = useFundSeg()
  const { kind } = useVehicle()
  if (!seg) return null
  return <div className="flex flex-wrap gap-2">
    <Button asChild size="sm" variant="outline" className={MUTED}><Link href={`/funds/${seg}/migrate`}>Import books</Link></Button>
    {!isManagementCompany(kind) && <Button asChild size="sm" variant="outline" className={MUTED}><Link href="/lps/capital">Enter reported balances</Link></Button>}
    <Button size="sm" variant="outline" className={MUTED} onClick={record} disabled={busy}>Record a transaction</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!isManagementCompany(kind) && <Button asChild size="sm" variant="outline" className={MUTED}><Link href={`/funds/${seg}/opening-balances`}>Enter opening balances</Link></Button>}
  </div>
}
