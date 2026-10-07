'use client'

import { DashboardCompanies } from './dashboard-companies'
import { DashboardNotesLayout, DashboardChatButton, DashboardNotesPanel } from './dashboard-notes'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import type { DashboardPageData } from './load'
import { PortfolioSheetView } from '@/components/portfolio-sheet'

export function DashboardPageView({ companies, allGroups, canAdd, isAdmin, userId }: DashboardPageData) {
  return (
    <DashboardNotesLayout userId={userId} isAdmin={isAdmin} companies={companies.map(c => ({ id: c.id, name: c.name }))}>
    <div className="p-4 md:py-8 md:pl-8 md:pr-4">
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
          <DashboardCompanies companies={companies} allGroups={allGroups} canAdd={canAdd} />
          {/* Fund holdings and digital assets across the viewer's entities. Companies are the table
              above, which carries their KPIs; the sheet adds the other two kinds of holding. */}
          <div className="mt-8">
            <PortfolioSheetView sections={['funds', 'crypto']} hideWhenEmpty />
          </div>
        </div>
        <DashboardNotesPanel />
        <AnalystPanel />
      </div>
    </div>
    </DashboardNotesLayout>
  )
}
