'use client'

import { useState } from 'react'
import { Check, ChevronDown, MoreHorizontal, PencilLine, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { parseMonth, type MonthKey } from '@/lib/forecast/months'

/**
 * The forecast page's range control: presets and a custom From/To month pair behind ONE trigger,
 * the same shape as the statements' PeriodPicker, so choosing Custom never grows the toolbar.
 */

export type RangeChoice = 'plan' | 'ytd' | 'current_year' | 'prior_year' | 'next_12' | 'next_24' | 'custom'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const short = (m: MonthKey) => {
  try {
    const { year, month } = parseMonth(m)
    return `${MONTHS[month - 1]} ${year}`
  } catch {
    return m
  }
}

const itemCls = (active: boolean) =>
  cn(
    'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
    active ? 'font-medium text-foreground' : 'text-muted-foreground',
  )

export function MonthRangePicker({ preset, onPreset, start, end, onStart, onEnd, planLabel }: {
  preset: RangeChoice
  onPreset: (p: RangeChoice) => void
  start: MonthKey
  end: MonthKey
  onStart: (m: MonthKey) => void
  onEnd: (m: MonthKey) => void
  /** Label for the 'plan' preset — "Plan range" with a plan, "Current year" without. */
  planLabel: string
}) {
  const [open, setOpen] = useState(false)
  const options: { value: RangeChoice; label: string }[] = [
    { value: 'plan', label: planLabel },
    { value: 'ytd', label: 'Year to date' },
    { value: 'current_year', label: 'Current year' },
    { value: 'prior_year', label: 'Prior year' },
    { value: 'next_12', label: 'Next 12 months' },
    { value: 'next_24', label: 'Next 24 months' },
    { value: 'custom', label: 'Custom' },
  ]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 font-normal" aria-label="Date range">
          {short(start)} – {short(end)}
          <ChevronDown className="ml-1.5 h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <div className="space-y-0.5">
          {options.map(o => (
            <button key={o.value} type="button" className={itemCls(preset === o.value)}
              onClick={() => { onPreset(o.value); if (o.value !== 'custom') setOpen(false) }}>
              {o.label}
              {preset === o.value && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="mt-2 space-y-2 border-t pt-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-10 shrink-0">From</span>
              <Input type="month" value={start} onChange={e => onStart(e.target.value)} className="h-8 flex-1" aria-label="From" />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-10 shrink-0">To</span>
              <Input type="month" value={end} onChange={e => onEnd(e.target.value)} className="h-8 flex-1" aria-label="To" />
            </label>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export interface MoreItem {
  label: string
  onSelect?: () => void
  href?: string
  /** A toggle: shown with a check, stays open. */
  checked?: boolean
  disabled?: boolean
  hidden?: boolean
}

/** The occasional actions — publish, links, export — behind one button, so the toolbar holds what you use every visit. */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false)
  const visible = items.filter(i => !i.hidden)
  if (!visible.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        {visible.map(i => {
          const body = (
            <>
              {i.label}
              {i.checked !== undefined && <Check className={cn('h-3.5 w-3.5', i.checked ? 'opacity-100' : 'opacity-0')} />}
            </>
          )
          return i.href ? (
            <a key={i.label} href={i.href} className={itemCls(false)} onClick={() => setOpen(false)}>{body}</a>
          ) : (
            <button key={i.label} type="button" disabled={i.disabled} className={cn(itemCls(!!i.checked), 'disabled:opacity-50')}
              onClick={() => { i.onSelect?.(); if (i.checked === undefined) setOpen(false) }}>
              {body}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/**
 * New plan, the one way to start one: build it yourself, or have the Analyst draft it from the
 * entity's history. Without an AI key there is only one way, so the button just opens the dialog.
 */
export function NewPlanMenu({ onManual, onDraftWithAi }: { onManual: () => void; onDraftWithAi?: () => void }) {
  const [open, setOpen] = useState(false)
  if (!onDraftWithAi) {
    return <Button onClick={onManual}><Plus className="mr-1.5 h-4 w-4" /> New plan</Button>
  }
  const choose = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button aria-haspopup="menu"><Plus className="mr-1.5 h-4 w-4" /> New plan <ChevronDown className="ml-1.5 h-3.5 w-3.5 opacity-70" /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <button type="button" className={cn(itemCls(false), 'items-start gap-2 justify-start')} onClick={choose(onManual)}>
          <PencilLine className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="block font-medium text-foreground">Start from scratch</span><span className="block text-xs">Pick the accounts and rules yourself.</span></span>
        </button>
        <button type="button" className={cn(itemCls(false), 'items-start gap-2 justify-start')} onClick={choose(onDraftWithAi)}>
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="block font-medium text-foreground">Draft with AI</span><span className="block text-xs">The Analyst suggests rules from the books&rsquo; history for you to review.</span></span>
        </button>
      </PopoverContent>
    </Popover>
  )
}
