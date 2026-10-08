'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { getCurrencySymbol } from '@/components/currency-context'
import type { Metric, CompanyStatus } from '@/lib/types/database'
import { CompanyCharts } from './company-charts'
import { CompanySummary } from './company-summary'
import { CompanyEditButton } from './company-edit-button'
import { CompanyPanelProvider } from './company-panel-context'
import { ChatButton, CompanyNotesPanel } from './company-notes'
import { AnalystButton } from './company-analyst'
import { AnalystPanel } from '@/components/analyst-panel'
import { CompanyDocuments } from './company-documents'
import { CompanyUpdates } from './company-updates'
import { CompanyInvestments } from './company-investments'
import { CompanyInteractions } from './company-interactions'
import { FundRegisterSection } from './fund-register-section'
import { holdingPanels } from './holding-panels'
import { HoldingPriceFeed } from './holding-price-feed'
import { HoldingWallets } from './holding-wallets'
import type { CompanyPageData } from './load'

function formatHighlightValue(value: number, metric: Metric, fundCurrency: string) {
  let formatted: string
  if (metric.value_type === 'percentage') {
    formatted = `${value}%`
  } else if (Math.abs(value) >= 1_000_000) {
    formatted = `${(value / 1_000_000).toFixed(1)}M`
  } else if (Math.abs(value) >= 1_000) {
    formatted = `${(value / 1_000).toFixed(0)}K`
  } else {
    formatted = value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }

  // Use explicit metric unit if set, otherwise fall back to metric/fund currency for currency-type metrics
  const metricCurrency = metric.currency ?? fundCurrency
  const unit = metric.unit ?? (metric.value_type === 'currency' ? getCurrencySymbol(metricCurrency) : null)
  const unitPosition = metric.unit ? metric.unit_position : 'prefix'

  if (!unit) return formatted
  return unitPosition === 'prefix'
    ? `${unit}${formatted}`
    : `${formatted} ${unit}`
}

/**
 * One holding's page — a company, a fund holding or a digital asset, each created, recorded and
 * configured here (plans/spec-ledger-one-writer.md §6). `holdingPanels` decides what shows.
 */
export function CompanyPageView({
  company, userId, isAdmin, fundCurrency, hasClaudeKey, hasOpenAIKey, defaultAIProvider, storageProvider,
  googleDriveFolderId, featureVisibility, showNotes, showInvestments, showInteractions, metrics, latestMrr, latestCash,
  hasCapturedUpdates, holdingType, entities, initialEntityId,
}: CompanyPageData & { initialEntityId?: string | null }) {
  // A demo snapshot recorded before holdingType existed reads as a company.
  const panels = holdingPanels(holdingType)
  const back = panels.companyProfile ? { href: '/dashboard', label: 'Portfolio' } : { href: '/investments', label: 'Investments' }

  return (
    <CompanyPanelProvider companyId={company.id} userId={userId} isAdmin={isAdmin}>
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 max-w-page">
        <Link
          href={back.href}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {back.label}
        </Link>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
          <CompanyEditButton company={company} />
          {holdingType === 'fund' && <Badge variant="outline">Fund holding</Badge>}
          {holdingType === 'crypto' && <Badge variant="outline">Digital asset</Badge>}
          {(company.portfolio_group ?? []).map((pg) => (
            <Badge key={pg} variant="outline">{pg}</Badge>
          ))}
          {panels.companyProfile && company.stage && (
            <Badge variant="outline">{company.stage}</Badge>
          )}
          {panels.companyProfile && (company.industry ?? []).map((ind) => (
            <Badge key={ind} variant="outline">{ind}</Badge>
          ))}
          {showNotes && <ChatButton />}
          <AnalystButton companyId={company.id} pushRight={!showNotes} />
        </div>

        {panels.companyProfile && (latestMrr || latestCash) && (
          <div className="flex items-center gap-4 mt-1.5">
            {latestMrr && (
              <span className="text-sm">
                <span className="text-muted-foreground">MRR:</span>{' '}
                <span className="font-medium">{formatHighlightValue(latestMrr.value, latestMrr.metric, fundCurrency)}</span>
                <span className="text-xs text-muted-foreground ml-1">({latestMrr.period})</span>
              </span>
            )}
            {latestCash && (
              <span className="text-sm">
                <span className="text-muted-foreground">Cash:</span>{' '}
                <span className="font-medium">{formatHighlightValue(latestCash.value, latestCash.metric, fundCurrency)}</span>
                <span className="text-xs text-muted-foreground ml-1">({latestCash.period})</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Content + Notes panel side by side */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-page w-full [&>*:first-child]:mt-0">
          {panels.companyProfile && company.status !== 'exited' && company.status !== 'written-off' && (
            <>
              <CompanySummary
                companyId={company.id}
                hasClaudeKey={hasClaudeKey}
                hasOpenAIKey={hasOpenAIKey}
                defaultAIProvider={defaultAIProvider}
              />

              <CompanyCharts
                companyId={company.id}
                companyName={company.name}
                metrics={metrics}
              />
            </>
          )}

          {showInvestments && panels.register && (
            <FundRegisterSection companyId={company.id} entities={entities ?? []} initialEntityId={initialEntityId ?? null} />
          )}

          {showInvestments && (
            <CompanyInvestments
              companyId={company.id}
              companyStatus={company.status as CompanyStatus}
              portfolioGroups={company.portfolio_group ?? []}
              adminOnly={featureVisibility.investments === 'admin'}
              showUnits={panels.units}
            />
          )}

          {showInvestments && panels.wallets && (
            <HoldingWallets companyId={company.id} entities={entities ?? []} />
          )}

          {showInvestments && panels.priceFeed && (
            <HoldingPriceFeed companyId={company.id} kind={holdingType === 'crypto' ? 'crypto' : 'company'} />
          )}

          <div id="updates">
            <CompanyUpdates companyId={company.id} />
          </div>

          <CompanyDocuments
            companyId={company.id}
            fundId={company.fund_id}
            storageProvider={storageProvider}
            googleDriveFolderId={googleDriveFolderId}
            includeEmailHistory={!hasCapturedUpdates}
          />

          {showInteractions && (
            <CompanyInteractions companyId={company.id} adminOnly={featureVisibility.interactions === 'admin'} />
          )}

          {panels.companyProfile && (company.founders || (company.contact_email && company.contact_email.length > 0) || company.overview || company.why_invested || company.current_update) && (
            <div className="mt-6 space-y-3">
              {company.founders && (
                <div>
                  <h3 className="text-base font-medium text-muted-foreground mb-1">Founders</h3>
                  <p className="text-sm">{company.founders}</p>
                </div>
              )}

              {company.contact_email && company.contact_email.length > 0 && (
                <div>
                  <h3 className="text-base font-medium text-muted-foreground mb-1">Contact{company.contact_email.length > 1 ? 's' : ''}</h3>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {company.contact_email.map((email) => (
                      <p key={email} className="text-sm">
                        <a href={`mailto:${email}`} className="hover:underline">
                          {email}
                        </a>
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {company.overview && (
                <div>
                  <h3 className="text-base font-medium text-muted-foreground mb-1">Overview</h3>
                  <p className="text-sm">{company.overview}</p>
                </div>
              )}

              {company.why_invested && (
                <div>
                  <h3 className="text-base font-medium text-muted-foreground mb-1">Why We Invested</h3>
                  <p className="text-sm">{company.why_invested}</p>
                </div>
              )}

              {company.current_update && (
                <div>
                  <h3 className="text-base font-medium text-muted-foreground mb-1">Current Business Update</h3>
                  <p className="text-sm">{company.current_update}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {showNotes && <CompanyNotesPanel />}
        <AnalystPanel />
      </div>
    </div>
    </CompanyPanelProvider>
  )
}
