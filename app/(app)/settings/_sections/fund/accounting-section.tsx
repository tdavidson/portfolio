'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/settings/section'
import { useCanRead } from '@/components/access-context'
import { isManagementCompany } from '@/lib/vehicle-kinds'

type Entity = { id: string; name: string; kind: string }

/** Secondary actions: none is THE next step, so none takes the primary fill. */
const MUTED = 'text-muted-foreground hover:text-foreground'

/** Setting up an entity's books. Shown only to a viewer who can read accounting. */
export function AccountingSection() {
  const canRead = useCanRead('accounting')
  const [entities, setEntities] = useState<Entity[] | null>(null)

  useEffect(() => {
    if (!canRead) return
    let live = true
    fetch('/api/entities')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (live) setEntities(Array.isArray(d) ? d : []) })
      .catch(() => { if (live) setEntities([]) })
    return () => { live = false }
  }, [canRead])

  if (!canRead || !entities || entities.length === 0) return null
  const anyFund = entities.some(e => !isManagementCompany(e.kind))

  return (
    <Section title="Accounting">
      <p className="text-xs text-muted-foreground mb-3">
        Set up an entity&apos;s books by importing its history or entering opening balances.
      </p>
      <ul className="divide-y rounded-lg border max-h-72 overflow-y-auto">
        {entities.map(e => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="text-sm min-w-0 truncate">{e.name}</span>
            <span className="flex gap-2">
              <Button asChild size="sm" variant="outline" className={MUTED}><Link href={`/funds/${e.id}/migrate`}>Import books</Link></Button>
              {!isManagementCompany(e.kind) && (
                <Button asChild size="sm" variant="outline" className={MUTED}><Link href={`/funds/${e.id}/opening-balances`}>Opening balances</Link></Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {anyFund && (
        <div className="mt-3">
          <Button asChild size="sm" variant="outline" className={MUTED}><Link href="/lps/capital">Enter reported balances</Link></Button>
        </div>
      )}
    </Section>
  )
}
