'use client'

import { Filter, CheckSquare, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { VEHICLE_KINDS, VEHICLE_KIND_LABELS_PLURAL } from '@/lib/vehicle-kinds'

// Re-exported rather than redeclared: these were a second copy of the kind vocabulary, and the
// filter bar showing a different set of kinds from the one the create modal can produce is a bug
// with no error message.
export { VEHICLE_KINDS }
export const KIND_LABELS: Record<string, string> = VEHICLE_KIND_LABELS_PLURAL

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'exited', label: 'Exited' },
  { value: 'written-off', label: 'Written Off' },
]

interface Props {
  selectedKinds: Set<string>
  onToggleKind: (k: string) => void
  showEmpty: boolean
  onToggleShowEmpty: () => void
  status: string
  onStatusChange: (s: string) => void
  /** The entities with holdings, to pick from; and the ones left out. Empty hidden = all shown. */
  entities?: string[]
  hiddenEntities?: Set<string>
  onToggleEntity?: (name: string) => void
  onShowAllEntities?: () => void
}

function CheckRow({ checked, label, onClick, muted }: { checked: boolean; label: string; onClick: () => void; muted?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5 cursor-pointer hover:bg-muted/30" onClick={onClick}>
      {checked
        ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
        : <Square className="h-4 w-4 text-muted-foreground shrink-0" />}
      <span className={`text-sm truncate ${muted ? 'text-muted-foreground' : ''}`}>{label}</span>
    </div>
  )
}

export function InvestmentVehicleFilters({
  selectedKinds, onToggleKind, showEmpty, onToggleShowEmpty,
  status, onStatusChange,
  entities = [], hiddenEntities = new Set(), onToggleEntity, onShowAllEntities,
}: Props) {
  const active = selectedKinds.size < VEHICLE_KINDS.length || showEmpty || status !== '' || hiddenEntities.size > 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`gap-1.5 h-8 py-2 text-muted-foreground hover:text-foreground ${active ? 'bg-accent' : ''}`}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 max-h-[70vh] overflow-y-auto p-0" align="end">
        <div className="px-4 py-2 border-b bg-muted text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Vehicle type</div>
        {VEHICLE_KINDS.map(k => (
          <CheckRow key={k} checked={selectedKinds.has(k)} label={KIND_LABELS[k]} onClick={() => onToggleKind(k)} />
        ))}

        <div className="border-t">
          <CheckRow checked={showEmpty} label="Show empty vehicles (no transactions)" onClick={onToggleShowEmpty} muted />
        </div>

        {entities.length > 1 && onToggleEntity && (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-y bg-muted text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <span>Entities</span>
              {hiddenEntities.size > 0 && onShowAllEntities && (
                <button type="button" onClick={onShowAllEntities} className="normal-case tracking-normal hover:text-foreground">Show all</button>
              )}
            </div>
            {entities.map(name => (
              <CheckRow key={name} checked={!hiddenEntities.has(name)} label={name} onClick={() => onToggleEntity(name)} />
            ))}
          </>
        )}

        <div className="px-4 py-2 border-y bg-muted text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</div>
        {STATUS_OPTIONS.map(opt => (
          <CheckRow key={opt.value} checked={status === opt.value} label={opt.label} onClick={() => onStatusChange(opt.value)} />
        ))}
      </PopoverContent>
    </Popover>
  )
}
