'use client'

import { useState } from 'react'
import { Building2, ChevronDown, Coins, Landmark, Layers, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCanWrite } from '@/components/access-context'
import { AddCompanyButton } from '@/components/add-company-button'
import { AddFundHoldingButton } from '@/components/add-fund-holding-button'
import { AddDigitalAssetButton } from '@/components/add-digital-asset-button'
import { AddVehicleButton } from '@/components/add-vehicle-button'

/** What a parent passes to drive one of the Add dialogs instead of its own button. */
export interface DialogControl {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}

type Kind = 'company' | 'fund' | 'asset' | 'vehicle'

const ITEMS: { kind: Kind; label: string; hint: string; icon: typeof Plus }[] = [
  { kind: 'company', label: 'Company', hint: 'A startup the fund invests in', icon: Building2 },
  { kind: 'fund', label: 'Fund holding', hint: 'A position in another fund', icon: Layers },
  { kind: 'asset', label: 'Digital asset', hint: 'Tokens or coins, held in wallets', icon: Coins },
  { kind: 'vehicle', label: 'Vehicle', hint: 'A fund, SPV or entity that invests', icon: Landmark },
]

/**
 * One Add button for everything the Investments page can create. The four dialogs are the same
 * components that stand alone elsewhere (Start, the dashboard); here they are opened from a menu.
 */
export function AddInvestmentMenu({ onCreated }: { onCreated?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<Kind | null>(null)
  // The digital-asset dialog draws nothing without write access; the menu does not offer it either.
  const canWriteInvestments = useCanWrite('portfolio', 'investments')
  const items = ITEMS.filter(i => i.kind !== 'asset' || canWriteInvestments)
  const control = (kind: Kind) => ({
    hideTrigger: true,
    open: dialog === kind,
    onOpenChange: (o: boolean) => setDialog(o ? kind : null),
  })

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground" aria-haspopup="menu">
            <Plus className="h-3.5 w-3.5" />Add<ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          {items.map(({ kind, label, hint, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => { setMenuOpen(false); setDialog(kind) }}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <AddCompanyButton {...control('company')} />
      <AddFundHoldingButton onCreated={onCreated} {...control('fund')} />
      <AddDigitalAssetButton {...control('asset')} />
      <AddVehicleButton onCreated={onCreated} {...control('vehicle')} />
    </>
  )
}
