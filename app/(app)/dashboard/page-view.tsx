'use client'

import { useState } from 'react'
import { DashboardCompanies } from './dashboard-companies'
import { DashboardNotesLayout, DashboardChatButton, DashboardNotesPanel } from './dashboard-notes'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import type { DashboardPageData } from './load'
import { PortfolioSheetView, usePortfolioSheet } from '@/components/portfolio-sheet'
import { GettingStartedBanner } from '@/components/getting-started-banner'
import { PendingApprovalsNotice } from '@/components/pending-approvals'

export function DashboardPageView({ companies, fundHoldings, entityOptions, initialExcluded, hasSavedSelection, canAdd, isAdmin, userId }: DashboardPageData) {
  // The entity selection drives both the company list and the holdings sheet below it.
  const [excluded, setExcluded] = useState<string[]>(initialExcluded)
  const [hasSaved, setHasSaved] = useState(hasSavedSelection)
  const excludedNames = entityOptions.filter(o => excluded.includes(o.id)).map(o => o.name)
  const [view, setView] = useState<'cards' | 'table'>('cards')
  // One sheet fetch for the page: the fund cards take their figures from it, and the tables below
  // show the rest (digital assets; fund holdings too in the table view, which lists companies only).
  const sheet = usePortfolioSheet({ exclude: excludedNames })
  return (
    <DashboardNotesLayout userId={userId} isAdmin={isAdmin} companies={companies.map(c => ({ id: c.id, name: c.name }))}>
    <div className="p-4 md:py-8 md:pl-8 md:pr-4" data-page-ready="portfolio" data-metrics-ready="portfolio">
      <GettingStartedBanner isAdmin={isAdmin} className="mb-4 max-w-page" />
      {/* Changes staged from a connected chat or a script, here as on Start: a member who lands on
          the dashboard should not have to go looking for them. */}
      <PendingApprovalsNotice className="mb-4 max-w-page" />
      <div className="mb-4 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
          <div className="flex items-center gap-2">
            <DashboardChatButton />
            <AnalystToggleButton />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Track performance and activity across your portfolio companies</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-page w-full">
          <DashboardCompanies
            companies={companies}
            fundHoldings={fundHoldings}
            fundFigures={sheet}
            view={view}
            onViewChange={setView}
            canAdd={canAdd}
            entities={{
              options: entityOptions,
              excluded,
              hasSaved,
              onChange: (next, saved) => { setExcluded(next); setHasSaved(saved) },
            }}
          />
          {/* Digital assets across the viewer's entities. Fund holdings are cards in the grid above,
              beside the companies; the table view lists companies only, so it shows funds here. */}
          <div className="mt-8">
            <PortfolioSheetView sections={view === 'table' ? ['funds', 'crypto'] : ['crypto']} state={sheet} hideWhenEmpty />
          </div>
        </div>
        <DashboardNotesPanel />
        <AnalystPanel />
      </div>
    </div>
    </DashboardNotesLayout>
  )
}
