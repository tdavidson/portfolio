'use client'

import Link from 'next/link'
import { Plus, Landmark, HandCoins, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddCompanyButton } from '@/components/add-company-button'
import { AddInvestmentButton } from '@/components/add-investment-button'
import { AddVehicleButton } from '@/components/add-vehicle-button'
import { ImportDocumentsButton } from '@/components/import-documents'
import type { CreateAction } from '@/lib/start/quick-actions'

// Icons live here rather than in lib/start/quick-actions.ts, a pure module the tests import
// without React. The modal actions carry their own (a Plus, inside each button component); these
// are the link actions'. The capital pair uses the glyph of the page they open, and the
// distribution the hand-with-coins because it is money going OUT.
const LINK_ICONS: Record<string, LucideIcon> = {
  'add-deal': Plus,
  'issue-capital-call': Landmark,
  'declare-distribution': HandCoins,
}

/**
 * The create shortcuts — add an investment or a company, import documents, issue a call, declare a
 * distribution — one row per group. Start shows them firm-wide; an entity's Admin page shows them
 * for that entity. The list and its gating are lib/start/quick-actions.ts; this only draws it.
 *
 * `vehicleId` sends the capital actions to that entity's capital accounts rather than the
 * firm-wide landing that asks which one.
 */
export function QuickActionButtons({ actions, vehicleId }: { actions: CreateAction[]; vehicleId?: string | null }) {
  const hrefFor = (href: string) =>
    vehicleId ? href.replace('/funds/capital-accounts', `/funds/${vehicleId}/capital-accounts`) : href
  // One row per group — see CreateAction.group. A group with nothing in it renders no row.
  const groups = (['create', 'capital'] as const)
    .map(g => actions.filter(a => a.group === g))
    .filter(g => g.length > 0)

  return (
    <>
      {groups.map((group, i) => (
        <div key={i} className="flex flex-wrap justify-start gap-2">
          {group.map(a => {
            if (a.kind === 'link') {
              const Icon = LINK_ICONS[a.id]
              return (
                <Button key={a.id} variant="outline" size="sm" asChild className="gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground">
                  <Link href={hrefFor(a.href!)}>{Icon && <Icon className="h-3.5 w-3.5" />}{a.label}</Link>
                </Button>
              )
            }
            if (a.id === 'add-investment') return <AddInvestmentButton key={a.id} />
            if (a.id === 'add-company') return <AddCompanyButton key={a.id} />
            if (a.id === 'import-documents') return <ImportDocumentsButton key={a.id} />
            if (a.id === 'add-vehicle') return <AddVehicleButton key={a.id} />
            return null
          })}
        </div>
      ))}
    </>
  )
}
