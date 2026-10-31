'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ChevronLeft, ChevronRight, Check, AlertTriangle, X, ExternalLink, Clock, Loader2, Link as LinkIcon } from 'lucide-react'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { PortfolioNotesProvider, PortfolioNotesButton, PortfolioNotesPanel } from '@/components/portfolio-notes'
import { evaluateAll, type ComplianceProfile, type Applicability } from '@/lib/compliance/applicability'
import { expandInstances, parseGroupKey } from '@/lib/compliance/schedule'
import { resolveStatus } from '@/lib/compliance/status'
import { parseYear } from '@/lib/compliance/completion'
import { ComplianceNav, type ComplianceTab } from './compliance-nav'

interface ComplianceItem {
  id: string
  category: string
  name: string
  short_name: string
  description: string
  frequency: string
  deadline_description: string
  deadline_month: number | null
  deadline_day: number | null
  rolling_days: number | null
  applicability_text: string
  filing_system: string
  filing_portal_url: string | null
  regulation_url: string | null
  complexity: string
  notes: string | null
  alert: string | null
  sort_order: number
  scope: 'firm' | 'vehicle'
}

interface FundSetting {
  compliance_item_id: string
  portfolio_group: string
  applies: string | null
  dismissed: boolean
  dismissed_reason: string | null
  completed: boolean
  completed_at: string | null
  completed_note: string | null
  completed_link: string | null
  notes: string | null
}

interface Deadline {
  id: string
  compliance_item_id: string
  year: number
  due_date: string | null
  status: string
}

interface ComplianceLink {
  id: string
  compliance_item_id: string | null
  title: string
  description: string | null
  url: string
}

// Intake questions
const QUESTIONS = [
  {
    key: 'registration_status',
    question: 'How is your firm registered with the SEC?',
    explainer: 'Most VC firms are ERAs under the Dodd-Frank Act, they file limited sections of Form ADV but aren\'t fully registered. If your firm advises only qualifying VC funds and has filed Form ADV checking the \'exempt reporting adviser\' box, you\'re an ERA.',
    options: [
      { value: 'ria', label: 'SEC-Registered Investment Adviser (RIA)' },
      { value: 'era', label: 'Exempt Reporting Adviser (ERA)' },
      { value: 'not_registered', label: 'Not registered / Venture Capital Fund Adviser exemption only' },
      { value: 'unsure', label: 'I\'m not sure' },
    ],
  },
  {
    key: 'aum_range',
    question: 'What is your firm\'s approximate regulatory assets under management (AUM)?',
    explainer: 'Regulatory AUM is calculated per the Form ADV instructions and may differ from your fund\'s NAV.',
    options: [
      { value: 'under_25m', label: 'Under $25 million' },
      { value: '25m_100m', label: '$25M – $100M' },
      { value: '100m_150m', label: '$100M – $150M' },
      { value: '150m_500m', label: '$150M – $500M' },
      { value: '500m_1.5b', label: '$500M – $1.5B' },
      { value: 'over_1.5b', label: 'Over $1.5B' },
      { value: 'unsure', label: 'I\'m not sure' },
    ],
  },
  {
    key: 'fund_structure',
    question: 'How is your fund structured?',
    explainer: 'Most VC funds are limited partnerships, which file Form 1065 and issue K-1s to partners.',
    options: [
      { value: 'lp', label: 'Limited Partnership' },
      { value: 'llc_partnership', label: 'LLC taxed as partnership' },
      { value: 'llc_corp', label: 'LLC taxed as corporation' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    key: 'fundraising_status',
    question: 'What is your fund\'s current fundraising status?',
    explainer: 'This determines whether Form D amendments and Blue Sky renewal filings are needed.',
    options: [
      { value: 'actively_raising', label: 'Actively raising capital' },
      { value: 'closed_recent', label: 'Closed within the last 12 months' },
      { value: 'closed_over_12m', label: 'Closed more than 12 months ago' },
      { value: 'evergreen', label: 'Evergreen / continuous offering' },
    ],
  },
  {
    key: 'reg_d_exemption',
    question: 'Did your fund raise capital under Regulation D (Rule 506)?',
    explainer: 'Almost all VC funds raise under Reg D. If your fund has a PPM and subscription agreements, you\'re almost certainly using Reg D.',
    options: [
      { value: '506b', label: 'Yes, Rule 506(b) (no general solicitation)' },
      { value: '506c', label: 'Yes, Rule 506(c) (general solicitation permitted)' },
      { value: 'no', label: 'No / not applicable' },
      { value: 'unsure', label: 'I\'m not sure' },
    ],
  },
  {
    key: 'investor_state_count',
    question: 'In how many U.S. states do your fund investors reside?',
    explainer: 'Each state where you have investors may require a Blue Sky notice filing.',
    options: [
      { value: 'single_state', label: 'Just one state' },
      { value: '2_to_5', label: '2–5 states' },
      { value: '6_to_15', label: '6–15 states' },
      { value: '16_plus', label: '16 or more states' },
      { value: 'unsure', label: 'I\'m not sure' },
    ],
  },
  {
    key: 'california_nexus',
    question: 'Does your firm have any connection to California?',
    explainer: 'California\'s diversity reporting law (SB 54 / FIPVCC) has broad \'nexus\' triggers. Even firms headquartered outside CA may be covered.',
    multi: true,
    options: [
      { value: 'hq_ca', label: 'Headquartered or have an office in CA' },
      { value: 'investors_ca', label: 'Have investors based in CA' },
      { value: 'investments_ca', label: 'Made investments in CA-based companies' },
      { value: 'fundraising_ca', label: 'Raised capital from CA-based sources' },
      { value: 'none', label: 'No California connection' },
    ],
  },
  {
    key: 'public_equity',
    question: 'Do any of your funds hold publicly traded equity securities?',
    explainer: 'Most VC funds hold only private company equity, which means 13F, 13G, 13H, and N-PX don\'t apply.',
    options: [
      { value: 'yes_over_100m', label: 'Yes, over $100M in public equities' },
      { value: 'yes_under_100m', label: 'Yes, under $100M' },
      { value: 'yes_5pct_single', label: 'Yes, and we hold 5%+ of a single public company' },
      { value: 'no', label: 'No, private investments only' },
      { value: 'unsure', label: 'I\'m not sure' },
    ],
  },
  {
    key: 'cftc_activity',
    question: 'Does your fund engage in any commodity, futures, or swap trading?',
    explainer: 'If your fund uses any hedging instruments, interest rate swaps, or commodity-linked investments, you may need to file an exemption with the NFA.',
    options: [
      { value: 'yes_with_exemption', label: 'Yes, and we\'ve filed a CPO exemption (e.g., §4.13(a)(3))' },
      { value: 'yes_no_exemption', label: 'Yes, but we haven\'t filed an exemption' },
      { value: 'no', label: 'No commodity/futures/swap activity' },
      { value: 'unsure', label: 'I\'m not sure' },
    ],
  },
  {
    key: 'access_person_count',
    question: 'How many people at your firm have access to nonpublic information about fund holdings or transactions?',
    explainer: 'These are your \'Access Persons\' under the Code of Ethics. They\'ll need to provide periodic personal trading and holdings disclosures.',
    options: [
      { value: '1_to_3', label: '1–3 people' },
      { value: '4_to_10', label: '4–10 people' },
      { value: '11_plus', label: '11 or more' },
    ],
  },
  {
    key: 'has_foreign_entities',
    question: 'Are any of your fund entities formed under the laws of a foreign country?',
    explainer: 'As of March 2025, FinCEN exempted all U.S.-formed entities from BOI reporting. Only foreign-formed entities registered to do business in the U.S. still need to file.',
    options: [
      { value: 'yes', label: 'Yes, we have offshore/foreign fund entities registered in the U.S.' },
      { value: 'no', label: 'No, all entities are U.S.-formed' },
    ],
  },
  {
    key: 'has_foreign_investors',
    question: 'Does your fund have any foreign (non-U.S.) investors?',
    explainer: 'Funds with foreign investors have FATCA withholding and reporting obligations (Form 1042-S, Form 1042) and may have CRS reporting obligations depending on jurisdiction. W-8BEN/W-8BEN-E forms must be collected from foreign investors.',
    options: [
      { value: 'yes', label: 'Yes, one or more investors are non-U.S. persons or entities' },
      { value: 'no', label: 'No, all investors are U.S. persons' },
      { value: 'unsure', label: 'Unsure' },
    ],
  },
] as const

type View = ComplianceTab
type StatusFilter = 'active' | 'completed' | 'dismissed' | 'all'

const STATUS_COLORS: Record<Applicability | 'monitor', { bg: string; text: string; icon: typeof Check }> = {
  applies: { bg: 'bg-success-subtle dark:bg-success-subtle/30', text: 'text-success', icon: Check },
  completed: { bg: 'bg-info-subtle dark:bg-info-subtle/30', text: 'text-info', icon: Check },
  not_applicable: { bg: 'bg-muted', text: 'text-muted-foreground', icon: X },
  needs_review: { bg: 'bg-warning-subtle dark:bg-warning-subtle/30', text: 'text-warning', icon: AlertTriangle },
  monitor: { bg: 'bg-info-subtle dark:bg-info-subtle/30', text: 'text-info', icon: Clock },
}

/**
 * Compliance category → categorical slot.
 *
 * These used to borrow the STATUS colours: "SEC Filings" was amber, "State
 * Compliance" red, "Tax Filings" green. A category is not a status, so a routine
 * state filing rendered as an error and three unrelated categories shared amber
 * because there were not enough status colours to go round.
 *
 * Now each category owns a fixed slot from the categorical palette (--cat-1..8,
 * validated in globals.css). Fixed, so a category keeps its hue no matter which
 * categories are on screen — colour follows the entity, never its rank.
 *
 * The hue rides on a DOT, not on the text or a fill behind it: identity is never
 * colour-alone (the label is right there), and it sidesteps the three light-mode
 * slots that sit under 3:1 on white.
 */
const CATEGORY_DOT: Record<string, string> = {
  'SEC Filings':           'bg-cat-1',
  'Securities Offerings':  'bg-cat-2',
  'Tax Filings':           'bg-cat-3',
  'Internal Compliance':   'bg-cat-4',
  'Fund Reporting':        'bg-cat-5',
  'State Compliance':      'bg-cat-6',
  'CFTC':                  'bg-cat-7',
  'AML / FinCEN':          'bg-cat-8',
}
const DEFAULT_CATEGORY_DOT = 'bg-muted-foreground'
const categoryDot = (c: string) => CATEGORY_DOT[c] ?? DEFAULT_CATEGORY_DOT

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type CalendarEntry = { item: ComplianceItem; group?: string }

function entryKey(e: CalendarEntry) {
  return e.group ? `${e.item.id}::${e.group}` : e.item.id
}

export default function CompliancePage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  // Completion is per year: the page shows, and writes completions to, ?year= (default this UTC
  // year). A reminder for last year's Q4 links here with ?year= set, so marking it complete files
  // the occurrence it was about rather than this year's.
  const currentYear = new Date().getUTCFullYear()
  const year = parseYear(searchParams.get('year'))
  const setYear = useCallback((y: number) => {
    const params = new URLSearchParams(searchParams.toString())
    if (y === currentYear) params.delete('year')
    else params.set('year', String(y))
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [searchParams, router, pathname, currentYear])
  const initialView = (['calendar', 'items', 'setup'].includes(searchParams.get('view') ?? '') ? searchParams.get('view') as View : 'calendar')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ComplianceItem[]>([])
  const [profile, setProfile] = useState<ComplianceProfile | null>(null)
  const [fundSettings, setFundSettings] = useState<FundSetting[]>([])
  const [portfolioGroups, setPortfolioGroups] = useState<string[]>([])
  const [closeMonths, setCloseMonths] = useState<Record<string, number[]>>({})
  const [view, setView] = useState<View>(initialView)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [links, setLinks] = useState<ComplianceLink[]>([])

  // Intake state
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})

  // Refetches when the year changes; links, the profile answers and the initial view are set on
  // the first load only, so stepping the year doesn't bounce the user back to the calendar.
  const firstLoad = useRef(true)
  useEffect(() => {
    let cancelled = false
    const isFirst = firstLoad.current
    Promise.all([
      fetch(`/api/compliance?year=${year}`).then(r => r.json()),
      isFirst ? fetch('/api/compliance/links').then(r => r.json()) : Promise.resolve(null),
    ])
      .then(([d, linksData]) => {
        if (cancelled) return
        setItems(d.items ?? [])
        setFundSettings(d.settings ?? [])
        setPortfolioGroups(d.portfolioGroups ?? [])
        setCloseMonths(d.closeMonths ?? {})
        if (!isFirst) return
        firstLoad.current = false
        setLinks(Array.isArray(linksData) ? linksData : [])
        if (d.profile) {
          setProfile(d.profile)
          // Pre-fill answers from existing profile
          const a: Record<string, string | string[]> = {}
          for (const q of QUESTIONS) {
            const val = d.profile[q.key]
            if (val != null) a[q.key] = val
          }
          setAnswers(a)
          // Only override view if no query param was provided
          if (!searchParams.get('view')) setView('calendar')
        } else {
          setView('setup')
        }
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // searchParams is read for the initial view only; the fetch depends on the year alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year])

  // Compute applicability from profile
  const applicability = useMemo(() => {
    if (!profile) return {}
    return evaluateAll(profile)
  }, [profile])

  // Get setting for an item (optionally scoped to a portfolio group)
  const getSetting = useCallback((itemId: string, group?: string): FundSetting | undefined => {
    const pg = group ?? ''
    return fundSettings.find(s => s.compliance_item_id === itemId && (s.portfolio_group ?? '') === pg)
  }, [fundSettings])

  // Get effective status for an item (optionally scoped to a portfolio group)
  const getStatus = useCallback((itemId: string, group?: string): Applicability => {
    return resolveStatus(getSetting(itemId, group), applicability[itemId]?.result)
  }, [getSetting, applicability])

  // Count answered questions
  const answeredCount = Object.keys(answers).filter(k => {
    const val = answers[k]
    if (Array.isArray(val)) return val.length > 0
    return val != null && val !== ''
  }).length

  // Submit intake
  async function handleSubmitIntake() {
    setSaving(true)
    try {
      const profileData: Record<string, unknown> = {}
      for (const q of QUESTIONS) {
        profileData[q.key] = answers[q.key] ?? null
      }

      const res = await fetch('/api/compliance/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileData),
      })
      if (!res.ok) throw new Error('Failed to save profile')
      const savedProfile = await res.json()
      setProfile(savedProfile)

      // Evaluate and bulk-set applicability
      const results = evaluateAll(savedProfile as ComplianceProfile)
      const settings = Object.entries(results).map(([itemId, { result, reason }]) => ({
        compliance_item_id: itemId,
        applies: result === 'applies' ? 'yes' : result === 'not_applicable' ? 'no' : 'unsure',
        dismissed: result === 'not_applicable',
        dismissed_reason: result === 'not_applicable' ? reason : undefined,
      }))

      const settingsRes = await fetch('/api/compliance/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      })
      if (settingsRes.ok) {
        const savedSettings = await settingsRes.json()
        setFundSettings(savedSettings)
      }

      setView('calendar')
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  // Toggle dismiss/restore (optionally scoped to a portfolio group)
  async function handleToggleDismiss(itemId: string, dismiss: boolean, reason?: string, group?: string) {
    const pg = group ?? ''
    const res = await fetch('/api/compliance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compliance_item_id: itemId,
        portfolio_group: pg,
        year,
        dismissed: dismiss,
        dismissed_reason: reason,
        applies: dismiss ? 'no' : 'unsure',
        // Clear completed when dismissing
        ...(dismiss ? { completed: false } : {}),
      }),
    })
    if (res.ok) {
      const updated = await res.json()
      setFundSettings(prev => {
        const others = prev.filter(s => !(s.compliance_item_id === itemId && (s.portfolio_group ?? '') === pg))
        return [...others, updated]
      })
    }
  }

  // Mark an item as completed (with optional note and link)
  async function handleMarkComplete(itemId: string, completed: boolean, note?: string, link?: string, group?: string) {
    const pg = group ?? ''
    const res = await fetch('/api/compliance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compliance_item_id: itemId,
        portfolio_group: pg,
        year,
        completed,
        completed_note: note || null,
        completed_link: link || null,
        // Clear dismissed when completing
        ...(completed ? { dismissed: false } : {}),
      }),
    })
    if (res.ok) {
      const updated = await res.json()
      setFundSettings(prev => {
        const others = prev.filter(s => !(s.compliance_item_id === itemId && (s.portfolio_group ?? '') === pg))
        return [...others, updated]
      })
    }
  }

  // Save an item's standing notes — for a vehicle item they belong to the vehicle, not one quarter's
  // occurrence, so every quarter shows the same notes (a capital-statement distribution list, say).
  async function handleSaveNotes(itemId: string, notes: string, notesGroup: string) {
    const res = await fetch('/api/compliance/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compliance_item_id: itemId, portfolio_group: notesGroup, year, notes }),
    })
    if (res.ok) {
      const updated = await res.json()
      setFundSettings(prev => {
        const others = prev.filter(s => !(s.compliance_item_id === itemId && (s.portfolio_group ?? '') === notesGroup))
        return [...others, updated]
      })
    }
  }

  // Check if an item passes the current status filter
  const passesFilter = useCallback((status: Applicability): boolean => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'active') return status !== 'not_applicable' && status !== 'completed'
    if (statusFilter === 'completed') return status === 'completed'
    if (statusFilter === 'dismissed') return status === 'not_applicable'
    return true
  }, [statusFilter])

  // Calendar items grouped by month. Placement lives in lib/compliance/schedule.ts, shared
  // with the ops-reminders cron.
  const calendarData = useMemo(() => {
    const months: Record<number, CalendarEntry[]> = {}
    for (let m = 1; m <= 12; m++) months[m] = []
    for (const inst of expandInstances(items, portfolioGroups, closeMonths)) {
      if (!passesFilter(getStatus(inst.item.id, inst.group))) continue
      for (const m of inst.months) months[m].push({ item: inst.item, group: inst.group })
    }
    return { months }
  }, [items, getStatus, passesFilter, portfolioGroups, closeMonths])


  if (loading) {
    return (
      <div className="p-4 md:py-8 md:pl-8 md:pr-4 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <PortfolioNotesProvider pageContext="compliance">
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Compliance</h1>
          <div className="flex items-center gap-2">
            <PortfolioNotesButton />
            <AnalystToggleButton />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Track regulatory filings and compliance deadlines</p>
        {profile && (
          <div className="flex items-center justify-between flex-wrap gap-2 pt-2">
            <ComplianceNav active={view} onSelect={(tab) => setView(tab)} />
            {(view === 'calendar' || view === 'items') && (
              <div className="flex items-center gap-2">
                <div className="flex items-center">
                  <Button variant="ghost" size="sm" className="px-2" onClick={() => setYear(year - 1)} disabled={year <= 2000} aria-label="Previous year">
                    <ChevronLeft />
                  </Button>
                  <span className="min-w-[3rem] text-center text-xs font-medium tabular-nums">{year}</span>
                  <Button variant="ghost" size="sm" className="px-2" onClick={() => setYear(year + 1)} disabled={year >= 2100} aria-label="Next year">
                    <ChevronRight />
                  </Button>
                </div>
                <div className="flex items-center rounded-md border text-xs">
                  {(['active', 'completed', 'dismissed', 'all'] as const).map((f, i, arr) => (
                    <button
                      key={f}
                      onClick={() => setStatusFilter(f)}
                      className={`px-3 py-1 capitalize transition-colors ${ i === 0 ? 'rounded-l-md' : i === arr.length - 1 ? 'rounded-r-md' : '' } ${ statusFilter === f ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground' }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {profile && (view === 'calendar' || view === 'items') && year !== currentYear && (
          <p className="text-xs text-muted-foreground">
            Viewing <span className="tabular-nums">{year}</span> ·{' '}
            <button type="button" onClick={() => setYear(currentYear)} className="underline underline-offset-4 hover:text-foreground">
              Back to <span className="tabular-nums">{currentYear}</span>
            </button>
          </p>
        )}
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-5xl w-full">
          {view === 'setup' && (
            <IntakeQuestionnaire
              answers={answers}
              setAnswers={setAnswers}
              answeredCount={answeredCount}
              totalCount={QUESTIONS.length}
              onSubmit={handleSubmitIntake}
              saving={saving}
              isEdit={!!profile}
            />
          )}

          {view === 'calendar' && (
            <CalendarView
              calendarData={calendarData}
              items={items}
              getStatus={getStatus}
              applicability={applicability}
              getSetting={getSetting}
              expandedItem={expandedItem}
              setExpandedItem={setExpandedItem}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              onToggleDismiss={handleToggleDismiss}
              onMarkComplete={handleMarkComplete}
              onSaveNotes={handleSaveNotes}
              links={links}
            />
          )}

          {view === 'items' && (
            <ItemsView
              items={items}
              getStatus={getStatus}
              applicability={applicability}
              getSetting={getSetting}
              expandedItem={expandedItem}
              setExpandedItem={setExpandedItem}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              onToggleDismiss={handleToggleDismiss}
              onMarkComplete={handleMarkComplete}
              onSaveNotes={handleSaveNotes}
              links={links}
              portfolioGroups={portfolioGroups}
              closeMonths={closeMonths}
            />
          )}
        </div>
        <PortfolioNotesPanel />
        <AnalystPanel />
      </div>
    </div>
    </PortfolioNotesProvider>
  )
}

// --- Intake Questionnaire ---
function IntakeQuestionnaire({
  answers, setAnswers, answeredCount, totalCount, onSubmit, saving, isEdit,
}: {
  answers: Record<string, string | string[]>
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string | string[]>>>
  answeredCount: number
  totalCount: number
  onSubmit: () => void
  saving: boolean
  isEdit: boolean
}) {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-medium mb-1">{isEdit ? 'Update Fund Profile' : 'Fund Profile Setup'}</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Answer these questions to determine which compliance obligations apply to your fund.
          Your answers auto-determine applicability, you can override any result later.
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
            <div
              className="bg-foreground h-full rounded-full transition-all"
              style={{ width: `${(answeredCount / totalCount) * 100}%` }}
            />
          </div>
          <span>{answeredCount} of {totalCount} answered</span>
        </div>
      </div>

      <div className="space-y-6">
        {QUESTIONS.map((q, idx) => {
          const currentVal = answers[q.key]
          return (
            <div key={q.key} className="rounded-card border p-4">
              <p className="font-medium text-sm mb-1">
                <span className="text-muted-foreground mr-2">{idx + 1}.</span>
                {q.question}
              </p>
              <p className="text-xs text-muted-foreground mb-3">{q.explainer}</p>
              {'multi' in q && q.multi ? (
                <div className="space-y-1.5">
                  {q.options.map(opt => {
                    const selected = Array.isArray(currentVal) && currentVal.includes(opt.value)
                    const isNone = opt.value === 'none'
                    return (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setAnswers(prev => {
                            const arr = Array.isArray(prev[q.key]) ? [...(prev[q.key] as string[])] : []
                            if (isNone) return { ...prev, [q.key]: ['none'] }
                            const filtered = arr.filter(v => v !== 'none')
                            if (filtered.includes(opt.value)) {
                              return { ...prev, [q.key]: filtered.filter(v => v !== opt.value) }
                            }
                            return { ...prev, [q.key]: [...filtered, opt.value] }
                          })
                        }}
                        className={`w-full text-left px-3 py-2 rounded-md text-sm border transition-colors ${ selected ? 'border-foreground bg-accent font-medium' : 'border-border hover:bg-accent/50' }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {q.options.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setAnswers(prev => ({ ...prev, [q.key]: opt.value }))}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm border transition-colors ${ currentVal === opt.value ? 'border-foreground bg-accent font-medium' : 'border-border hover:bg-accent/50' }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onSubmit} disabled={saving || answeredCount === 0}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          {isEdit ? 'Update & Re-evaluate' : 'Save & Evaluate'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {answeredCount < totalCount ? `${totalCount - answeredCount} unanswered questions will be marked for review` : 'All questions answered'}
        </span>
      </div>
    </div>
  )
}

// --- Calendar View ---
function CalendarView({
  calendarData, items, getStatus, applicability, getSetting, expandedItem, setExpandedItem,
  statusFilter, setStatusFilter, onToggleDismiss, onMarkComplete, onSaveNotes, links,
}: {
  calendarData: { months: Record<number, CalendarEntry[]> }
  items: ComplianceItem[]
  getStatus: (id: string, group?: string) => Applicability
  applicability: Record<string, { result: Applicability; reason: string }>
  getSetting: (id: string, group?: string) => FundSetting | undefined
  expandedItem: string | null
  setExpandedItem: (id: string | null) => void
  statusFilter: StatusFilter
  setStatusFilter: (v: StatusFilter) => void
  onToggleDismiss: (id: string, dismiss: boolean, reason?: string, group?: string) => void
  onMarkComplete: (id: string, completed: boolean, note?: string, link?: string, group?: string) => void
  onSaveNotes: (id: string, notes: string, notesGroup: string) => void
  links: ComplianceLink[]
}) {
  const now = new Date()
  const currentMonth = now.getMonth() + 1
  // Track which entry is expanded (item id + optional group)
  const [expandedEntry, setExpandedEntry] = useState<{ itemId: string; group?: string } | null>(null)
  // Months that have entries
  const activeMonths = Array.from({ length: 12 }, (_, i) => i + 1)
    .filter(month => (calendarData.months[month] ?? []).length > 0)

  return (
    <div>
      {/* Two-column on desktop, single-column on mobile */}
      <div className="flex flex-col lg:flex-row gap-5 mb-6">
        {/* Month boxes column */}
        <div className="w-full lg:w-80 lg:shrink-0 space-y-3">
          {activeMonths.map(month => {
            const entries = calendarData.months[month] ?? []
            const isPast = month < currentMonth
            const isCurrent = month === currentMonth
            return (
              <div
                key={month}
                className={`rounded-card border p-3 ${isPast ? 'opacity-60' : ''}`}
              >
                <p className={`text-base font-semibold mb-2 ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {MONTHS[month - 1]}
                </p>
                <div className="space-y-1">
                  {entries.map(entry => {
                    const { item, group } = entry
                    const status = getStatus(item.id, group)
                    // Status wins over category: a dismissed or completed item reads as
                    // its state, so it drops the category dot entirely.
                    const tone = status === 'not_applicable'
                      ? 'bg-muted text-muted-foreground'
                      : status === 'completed'
                        ? 'bg-info-subtle dark:bg-info-subtle/30 text-info'
                        : 'bg-muted/60 text-foreground'
                    const dot = status === 'not_applicable' || status === 'completed' ? null : categoryDot(item.category)
                    const ek = entryKey(entry)
                    const isExpanded = expandedEntry?.itemId === item.id && expandedEntry?.group === group
                    return (
                      <div key={ek}>
                        <button
                          onClick={() => setExpandedEntry(isExpanded ? null : { itemId: item.id, group })}
                          className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1.5 ${ isExpanded ? 'ring-1 ring-foreground' : '' } ${tone} hover:opacity-80 transition-opacity`}
                        >
                          {dot && <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden />}
                          {item.short_name}
                          {group && <span className="ml-1 opacity-70">· {group}</span>}
                          {item.deadline_day && !group && <span className="ml-1 opacity-70">({item.deadline_month}/{item.deadline_day})</span>}
                        </button>
                        {/* Inline detail on mobile */}
                        {isExpanded && (
                          <div className="mt-2 mb-1 lg:hidden">
                            <ItemDetail
                              item={items.find(i => i.id === item.id)!}
                              status={getStatus(item.id, group)}
                              reason={applicability[item.id]?.reason}
                              setting={getSetting(item.id, group)}
                              notes={getSetting(item.id, notesGroupOf(items.find(i => i.id === item.id), group))?.notes ?? null}
                              group={group}
                              onClose={() => setExpandedEntry(null)}
                              onToggleDismiss={onToggleDismiss}
                              onMarkComplete={onMarkComplete}
                              onSaveNotes={onSaveNotes}
                              links={links.filter(l => l.compliance_item_id === item.id)}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}

        </div>

        {/* Detail panel, sticky on the right, desktop only */}
        <div className="hidden lg:block flex-1 min-w-0">
          {expandedEntry ? (
            <div className="sticky top-8 [&>div]:mt-0">
              <ItemDetail
                item={items.find(i => i.id === expandedEntry.itemId)!}
                status={getStatus(expandedEntry.itemId, expandedEntry.group)}
                reason={applicability[expandedEntry.itemId]?.reason}
                setting={getSetting(expandedEntry.itemId, expandedEntry.group)}
                notes={getSetting(expandedEntry.itemId, notesGroupOf(items.find(i => i.id === expandedEntry.itemId), expandedEntry.group))?.notes ?? null}
                group={expandedEntry.group}
                onClose={() => setExpandedEntry(null)}
                onToggleDismiss={onToggleDismiss}
                onMarkComplete={onMarkComplete}
                onSaveNotes={onSaveNotes}
                links={links.filter(l => l.compliance_item_id === expandedEntry.itemId)}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Click an item to view details
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

// --- Items List View ---
type ItemInstance = { item: ComplianceItem; group?: string }

function instanceKey(inst: ItemInstance) {
  return inst.group ? `${inst.item.id}::${inst.group}` : inst.item.id
}

function ItemsView({
  items, getStatus, applicability, getSetting, expandedItem, setExpandedItem,
  statusFilter, setStatusFilter, onToggleDismiss, onMarkComplete, onSaveNotes, links,
  portfolioGroups, closeMonths,
}: {
  items: ComplianceItem[]
  getStatus: (id: string, group?: string) => Applicability
  applicability: Record<string, { result: Applicability; reason: string }>
  getSetting: (id: string, group?: string) => FundSetting | undefined
  expandedItem: string | null
  setExpandedItem: (id: string | null) => void
  statusFilter: StatusFilter
  setStatusFilter: (v: StatusFilter) => void
  onToggleDismiss: (id: string, dismiss: boolean, reason?: string, group?: string) => void
  onMarkComplete: (id: string, completed: boolean, note?: string, link?: string, group?: string) => void
  onSaveNotes: (id: string, notes: string, notesGroup: string) => void
  links: ComplianceLink[]
  portfolioGroups: string[]
  closeMonths: Record<string, number[]>
}) {
  const CATEGORY_ORDER = ['SEC Filings', 'Securities Offerings', 'Tax Filings', 'Fund Reporting', 'Internal Compliance', 'State Compliance', 'CFTC', 'AML / FinCEN']

  // Build instances: expand vehicle-scoped items per fund, quarterly items per quarter
  const categoryInstances = useMemo(() => {
    const groups: Record<string, ItemInstance[]> = {}

    function passesFilter(status: Applicability) {
      if (statusFilter === 'all') return true
      if (statusFilter === 'active') return status !== 'not_applicable' && status !== 'completed'
      if (statusFilter === 'completed') return status === 'completed'
      if (statusFilter === 'dismissed') return status === 'not_applicable'
      return true
    }

    function addInstance(item: ComplianceItem, group?: string) {
      const status = getStatus(item.id, group)
      if (!passesFilter(status)) return
      if (!groups[item.category]) groups[item.category] = []
      groups[item.category].push({ item, group })
    }

    for (const inst of expandInstances(items, portfolioGroups, closeMonths)) {
      addInstance(inst.item, inst.group)
    }
    return groups
  }, [items, getStatus, statusFilter, portfolioGroups, closeMonths])

  const orderedCategories = CATEGORY_ORDER.filter(c => (categoryInstances[c]?.length ?? 0) > 0)

  return (
    <div>
      {orderedCategories.map(category => {
        const catDot = categoryDot(category)
        const instances = categoryInstances[category]
        return (
          <div key={category} className="mb-6">
            <h3 className="text-base font-medium mb-2 flex items-center gap-1.5">
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${catDot}`} aria-hidden />
              {category} ({instances.length})
            </h3>
            <div className="space-y-1">
              {instances.map(inst => {
                const ik = instanceKey(inst)
                const status = getStatus(inst.item.id, inst.group)
                const isDismissed = status === 'not_applicable'
                const isCompleted = status === 'completed'
                const dotClass = isDismissed
                  ? 'bg-muted-foreground/40'
                  : isCompleted
                    ? 'bg-info'
                    : catDot
                const isExpanded = expandedItem === ik
                return (
                  <div key={ik}>
                    <button
                      onClick={() => setExpandedItem(isExpanded ? null : ik)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm flex items-center justify-between transition-colors ${ isExpanded ? 'bg-accent border-foreground/20' : 'hover:bg-accent/50' }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass}`} aria-hidden />
                        <span className={`font-medium ${isDismissed ? 'text-muted-foreground line-through' : ''} ${isCompleted ? 'text-info dark:text-info' : ''}`}>
                          {inst.item.short_name}
                        </span>
                        {inst.group && <span className="text-xs text-muted-foreground">· {inst.group}</span>}
                      </span>
                      <span className="flex items-center gap-2">
                        {isCompleted && <span className="text-xs text-info">Completed</span>}
                        {isDismissed && <span className="text-xs text-muted-foreground">Dismissed</span>}
                        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                      </span>
                    </button>
                    {isExpanded && (
                      <ItemDetail
                        item={inst.item}
                        status={status}
                        reason={applicability[inst.item.id]?.reason}
                        setting={getSetting(inst.item.id, inst.group)}
                        notes={getSetting(inst.item.id, notesGroupOf(inst.item, inst.group))?.notes ?? null}
                        group={inst.group}
                        onClose={() => setExpandedItem(null)}
                        onToggleDismiss={onToggleDismiss}
                        onMarkComplete={onMarkComplete}
                        onSaveNotes={onSaveNotes}
                        links={links.filter(l => l.compliance_item_id === inst.item.id)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Where an item's standing notes live: the vehicle for a vehicle item (every quarter's occurrence
 *  of "Fund II::Q3" shares "Fund II"), the firm ('') otherwise. */
function notesGroupOf(item: ComplianceItem | undefined, group?: string): string {
  if (!item || item.scope !== 'vehicle' || !group) return ''
  return parseGroupKey(group).portfolioGroup
}

// --- Item Detail Panel ---
function ItemDetail({
  item, status, reason, setting, notes, group, onClose, onToggleDismiss, onMarkComplete, onSaveNotes, links,
}: {
  item: ComplianceItem
  status: Applicability
  reason?: string
  setting?: FundSetting
  /** The fund's own standing notes for this item (and vehicle), kept across quarters. */
  notes: string | null
  group?: string
  onClose: () => void
  onToggleDismiss: (id: string, dismiss: boolean, reason?: string, group?: string) => void
  onMarkComplete: (id: string, completed: boolean, note?: string, link?: string, group?: string) => void
  onSaveNotes: (id: string, notes: string, notesGroup: string) => void
  links?: ComplianceLink[]
}) {
  const [showCompleteForm, setShowCompleteForm] = useState(false)
  const [completeNote, setCompleteNote] = useState(setting?.completed_note ?? '')
  const [completeLink, setCompleteLink] = useState(setting?.completed_link ?? '')
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState(notes ?? '')

  if (!item) return null

  const isCompleted = status === 'completed'
  const isDismissed = status === 'not_applicable' && setting?.dismissed

  return (
    <div className="rounded-card border bg-card p-4 mt-2 mb-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-medium text-base">{item.name}{group && <span className="text-muted-foreground font-normal"> · {group}</span>}</h3>
          <p className="text-sm text-muted-foreground">{item.category} · {item.frequency} · {item.complexity} complexity</p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {isCompleted && (
        <div className="text-sm px-2.5 py-1.5 rounded mb-3 bg-info-subtle dark:bg-info-subtle/30 text-info">
          <span className="font-medium">Completed</span>
          {setting?.completed_at && <span> on {new Date(setting.completed_at).toLocaleDateString()}</span>}
          {setting?.completed_note && <p className="mt-1">{setting.completed_note}</p>}
          {setting?.completed_link && (
            <a href={setting.completed_link} target="_blank" rel="noopener noreferrer" className="mt-1 flex items-center gap-1 underline underline-offset-2 hover:opacity-80">
              <LinkIcon className="h-3 w-3" />{setting.completed_link}
            </a>
          )}
        </div>
      )}

      <p className="text-sm text-muted-foreground mb-3">{item.description}</p>

      {reason && !isCompleted && (
        <div className={`text-sm px-2.5 py-1.5 rounded mb-3 ${STATUS_COLORS[status].bg} ${STATUS_COLORS[status].text}`}>
          {reason}
        </div>
      )}

      {item.alert && (
        <div className="text-sm px-2.5 py-1.5 rounded mb-3 bg-warning-subtle dark:bg-warning-subtle/30 text-warning">
          {item.alert}
        </div>
      )}

      {item.notes && (
        <p className="text-sm text-muted-foreground mb-3">{item.notes}</p>
      )}

      {/* The fund's own notes — e.g. who receives a vehicle's statements. Per vehicle, not per quarter. */}
      <div className="mb-3 rounded border p-3">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-medium">
            Our notes{notesGroupOf(item, group) ? ` · ${notesGroupOf(item, group)}` : ''}
          </p>
          {!editingNotes && (
            <button
              onClick={() => { setNotesDraft(notes ?? ''); setEditingNotes(true) }}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              {notes ? 'Edit' : 'Add'}
            </button>
          )}
        </div>
        {editingNotes ? (
          <div className="space-y-2">
            <textarea
              value={notesDraft}
              onChange={e => setNotesDraft(e.target.value)}
              rows={6}
              maxLength={2000}
              placeholder="e.g. who receives this, and anyone starting in a later quarter"
              className="w-full text-sm px-2 py-1.5 rounded border bg-background"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => { onSaveNotes(item.id, notesDraft, notesGroupOf(item, group)); setEditingNotes(false) }}>
                Save
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditingNotes(false)}>Cancel</Button>
            </div>
          </div>
        ) : notes ? (
          <p className="text-sm whitespace-pre-line">{notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">None yet.</p>
        )}
      </div>

      {item.id === 'ca-diversity' && (
        <p className="text-sm text-muted-foreground mb-3">
          <a href="https://www.fipvcc.com/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">FIPVCC</a> provides standardized questionnaires for collecting demographic data from founders.
        </p>
      )}

      <div className="text-sm text-muted-foreground mb-3 space-y-0.5">
        <p><strong>Deadline:</strong> {item.deadline_description}</p>
        <p><strong>Filing system:</strong> {item.filing_system}</p>
        <p><strong>Applies to:</strong> {item.applicability_text}</p>
      </div>

      {links && links.length > 0 && (
        <div className="mb-3 space-y-1">
          {links.map(link => (
            <a
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <LinkIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="underline underline-offset-2">{link.title}</span>
              {link.description && <span className="opacity-70">— {link.description}</span>}
            </a>
          ))}
        </div>
      )}

      {/* Complete form (shown when clicking Mark Complete) */}
      {showCompleteForm && (
        <div className="mb-3 rounded border p-3 space-y-2">
          <p className="text-xs font-medium">Mark as completed</p>
          <input
            type="text"
            placeholder="Note (optional)"
            value={completeNote}
            onChange={e => setCompleteNote(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded border bg-background"
          />
          <input
            type="url"
            placeholder="Link (optional, e.g. filing URL)"
            value={completeLink}
            onChange={e => setCompleteLink(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded border bg-background"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                onMarkComplete(item.id, true, completeNote || undefined, completeLink || undefined, group)
                setShowCompleteForm(false)
              }}
            >
              Complete
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCompleteForm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {item.regulation_url && (
          <a
            href={item.regulation_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />View Regulation
          </a>
        )}
        {item.filing_portal_url && (
          <a
            href={item.filing_portal_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />Filing Portal
          </a>
        )}
        <span className="flex-1" />
        {isCompleted ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowCompleteForm(true)}
            >
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onMarkComplete(item.id, false, undefined, undefined, group)}
            >
              Restore
            </Button>
          </>
        ) : isDismissed ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowCompleteForm(true)}
            >
              Mark Complete
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onToggleDismiss(item.id, false, undefined, group)}
            >
              Restore
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowCompleteForm(true)}
            >
              Mark Complete
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onToggleDismiss(item.id, true, 'Manually dismissed', group)}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
