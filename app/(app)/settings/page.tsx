'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { DefaultsEditor } from './memo-agent/defaults/editor'
import { LedgerAgentAccess } from '@/components/ledger-agent-access'
import { DefaultMetricsSettings } from '@/components/settings/default-metrics-settings'
import { AppearanceEditor } from './appearance/editor'
import { ProfileSection } from './_sections/account/profile-section'
import { MfaSection } from './_sections/account/mfa-section'
import { NotificationPreferencesSection } from './_sections/account/notification-preferences-section'
import { AccountingSection } from './_sections/fund/accounting-section'
import { VersionSection } from './_sections/fund/version-section'
import { CurrencySection } from './_sections/fund/currency-section'
import { FundNameSection } from './_sections/fund/fund-name-section'
import { SignInSection } from './_sections/fund/sign-in-section'
import { AuthEmailTemplatesSection } from './_sections/fund/auth-email-templates-section'
import { WhitelistSection } from './_sections/fund/whitelist-section'
import { TeamSection } from './_sections/fund/team-section'
import { DangerZone } from './_sections/fund/danger-zone'
import { AnalyticsSection } from './_sections/fund/analytics-section'
import { UsageTrackingSection } from './_sections/fund/usage-tracking-section'
import { AIProvidersSection } from './_sections/platform/ai-providers-section'
import { InboundEmailSection } from './_sections/platform/inbound-email-section'
import { StorageSection } from './_sections/platform/storage-section'
import { OutboundEmailSection } from './_sections/platform/outbound-email-section'
import { RemindersSection } from './_sections/platform/reminders-section'
import { SendersSection } from './_sections/platform/senders-section'
import { AiSummaryPromptSection, AiSummaryPromptReadOnly } from './_sections/products/portfolio/ai-summary-prompt-section'
import { DashboardEntitiesSection } from './_sections/products/portfolio/dashboard-entities-section'
import { DealScreeningSection } from './_sections/products/investment/deal-screening-section'
import { KnownReferrersSection } from './_sections/products/investment/known-referrers-section'
import { MemoAgentSection } from './_sections/products/investment/memo-agent-section'
import { LpPortalRow } from './_sections/products/lp/lp-portal-card'
import { ProductGroup } from './_sections/products/product-group'
import { SettingsGroup } from './_sections/settings-group'
import type { FeatureKey, FeatureVisibility } from '@/lib/types/features'
import { AnalystToggleButton } from '@/components/analyst-button'
import { AnalystPanel } from '@/components/analyst-panel'
import { AffinityConnect } from '@/components/settings/affinity-connect'
import { DealResearchSettings } from '@/components/settings/deal-research-settings'
import { AdminSectionContext, Section } from '@/components/settings/section'
import type { SettingsData } from './_sections/types'

export default function SettingsPage() {
  const router = useRouter()
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  // Optimistic overlay for feature visibility: the per-feature access controls (now embedded
  // in each ProductGroup) and the product on/off toggles both write here immediately, then
  // PATCH /api/settings in the background. Cleared on the next successful load() so server
  // state always wins after a refetch.
  const [visOverride, setVisOverride] = useState<Record<string, string> | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/settings')
    if (res.ok) setSettings(await res.json())
    setVisOverride(null)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="p-4 md:p-8">
        <div className="mb-6 space-y-1">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <AnalystToggleButton />
          </div>
          <p className="text-sm text-muted-foreground">Configure your fund, integrations, and team preferences</p>
        </div>
        <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-3xl w-full">
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted rounded-lg" />)}
          </div>
        </div>
        <AnalystPanel />
        </div>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="p-4 md:p-8">
        <div className="mb-6 space-y-1">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <AnalystToggleButton />
          </div>
          <p className="text-sm text-muted-foreground">Configure your fund, integrations, and team preferences</p>
        </div>
        <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 min-w-0 max-w-3xl w-full">
          <p className="text-muted-foreground">Could not load settings.</p>
        </div>
        <AnalystPanel />
        </div>
      </div>
    )
  }

  const visValues = visOverride ?? settings.featureVisibility

  async function handleFeatureChange(key: FeatureKey, level: FeatureVisibility) {
    const next = { ...visValues, [key]: level }
    setVisOverride(next)
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureVisibility: next }),
    })
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <AnalystToggleButton />
        </div>
        <p className="text-sm text-muted-foreground">Configure your fund, integrations, and team preferences</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 max-w-3xl w-full space-y-8">

      {/* Account settings are not grouped/collapsible — they sit directly on the page. */}
      <ProfileSection displayName={settings.displayName} onSaved={load} />
      <MfaSection />
      <NotificationPreferencesSection />
      {/* Per-user API/MCP keys, so this lives on the page for all users; the admin on/off
          toggle lives in Organization below. */}
      <Section title="API and MCP">
        <LedgerAgentAccess isAdmin={settings.isAdmin} section="keys" />
      </Section>

      <AccountingSection />

      {/* Per-USER, not per-fund: the Affinity key is the caller's own personal access
          token and every user needs their own. Admins get the same card inside Investment
          Workflow, where it belongs alongside deal screening and diligence. */}
      {!settings.isAdmin && <AffinityConnect />}
      {!settings.isAdmin && (
        <AiSummaryPromptReadOnly prompt={settings.aiSummaryPrompt} />
      )}

      {settings.isAdmin && (
        <AdminSectionContext.Provider value={true}>
          <SettingsGroup label="Organization">
            <FundNameSection name={settings.fundName} logo={settings.fundLogo} address={settings.fundAddress} onSaved={load} />
            <SignInSection logo={settings.signInLogo} title={settings.signInTitle} onSaved={load} />
            <Section title="Appearance">
              <AppearanceEditor />
            </Section>
            <CurrencySection currency={settings.currency} onSaved={load} />
            <AuthEmailTemplatesSection />
            <AnalyticsSection
              fathomSiteId={settings.analyticsFathomSiteId}
              gaMeasurementId={settings.analyticsGaMeasurementId}
              onSaved={load}
            />
            <UsageTrackingSection
              disableUserTracking={settings.disableUserTracking}
              onSaved={load}
            />
            <TeamSection isAdmin={settings.isAdmin} featureVisibility={settings.featureVisibility} />
            <WhitelistSection />
            <VersionSection appVersion={settings.appVersion} updateAvailable={settings.updateAvailable} />
            {/* Investment-vehicle management moved out of Settings: add/edit (name, type, vintage,
                aliases, active) on /investments; GP linking on /funds/status. */}
            <AIProvidersSection
              hasClaudeKey={settings.hasClaudeKey}
              claudeModel={settings.claudeModel}
              hasOpenAIKey={settings.hasOpenAIKey}
              openaiModel={settings.openaiModel}
              hasOpenRouterKey={settings.hasOpenRouterKey}
              openrouterModel={settings.openrouterModel}
              openrouterBaseUrl={settings.openrouterBaseUrl}
              defaultAIProvider={settings.defaultAIProvider}
              onSaved={load}
            />
            <InboundEmailSection
              provider={settings.inboundEmailProvider}
              postmarkAddress={settings.postmarkInboundAddress}
              postmarkToken={settings.postmarkWebhookToken}
              mailgunInboundDomain={settings.mailgunInboundDomain}
              hasMailgunSigningKey={settings.hasMailgunSigningKey}
              onSaved={load}
            />
            <SendersSection senders={settings.senders} onChanged={load} />
            <OutboundEmailSection
              provider={settings.outboundEmailProvider}
              asksProvider={settings.asksEmailProvider}
              approvalEmailSubject={settings.approvalEmailSubject}
              approvalEmailBody={settings.approvalEmailBody}
              systemEmailFromName={settings.systemEmailFromName}
              systemEmailFromAddress={settings.systemEmailFromAddress}
              hasResendKey={settings.hasResendKey}
              hasPostmarkServerToken={settings.hasPostmarkServerToken}
              hasMailgunApiKey={settings.hasMailgunApiKey}
              mailgunSendingDomain={settings.mailgunSendingDomain}
              googleConnected={settings.googleDriveConnected}
              hasGoogleCredentials={settings.hasGoogleCredentials}
              googleClientId={settings.googleClientId}
              onSaved={load}
            />
            <RemindersSection />
            <StorageSection
              fundId={settings.fundId}
              fileStorageProvider={settings.fileStorageProvider}
              googleDriveConnected={settings.googleDriveConnected}
              googleDriveFolderId={settings.googleDriveFolderId}
              googleDriveFolderName={settings.googleDriveFolderName}
              hasGoogleCredentials={settings.hasGoogleCredentials}
              googleClientId={settings.googleClientId}
              onChanged={load}
            />
            <Section title="Agent access">
              <LedgerAgentAccess isAdmin={settings.isAdmin} section="toggle" />
            </Section>
            <DangerZone onDeleted={() => router.push('/auth')} />
          </SettingsGroup>

          <ProductGroup product="portfolio_reporting" values={visValues} onFeatureChange={handleFeatureChange} onToggled={load}>
            <Section title="Default metrics">
              <DefaultMetricsSettings />
            </Section>
            <AiSummaryPromptSection currentPrompt={settings.aiSummaryPrompt} onSaved={load} />
            <DashboardEntitiesSection />
          </ProductGroup>

          <ProductGroup product="investment_workflow" values={visValues} onFeatureChange={handleFeatureChange} onToggled={load}>
            <DealScreeningSection
              thesis={settings.dealThesis}
              prompt={settings.dealScreeningPrompt}
              intakeEnabled={settings.dealIntakeEnabled}
              defaultVehicleId={settings.dealsDefaultVehicleId}
              hasSubmissionToken={settings.hasSubmissionToken}
              onSaved={load}
            />
            <DealResearchSettings />
            <KnownReferrersSection />
            <Section title="AI">
              <p className="text-xs text-muted-foreground mb-3">
                AI provider and model for the key deal features: the inbound email classifier, deal screening, and inbound portfolio extraction.
              </p>
              <DefaultsEditor embedded section="features" />
            </Section>
            <MemoAgentSection />
            <AffinityConnect />
          </ProductGroup>

          <ProductGroup
            product="lp_reporting"
            values={visValues}
            onFeatureChange={handleFeatureChange}
            onToggled={load}
            accessRowsBefore={{ lp_portal: <LpPortalRow enabled={settings.lpPortalEnabled} onSaved={load} /> }}
          />

          <ProductGroup product="fund_operations" values={visValues} onFeatureChange={handleFeatureChange} onToggled={load}>
            <Section title="Fund Operations">
              <p className="text-xs text-muted-foreground mb-3">
                Fund accounting, GP economics and carry, and compliance are configured on the fund
                status page, not here.
              </p>
              <Link href="/funds/status" className="text-xs underline underline-offset-2 hover:text-foreground">
                Go to fund status
              </Link>
            </Section>
          </ProductGroup>
        </AdminSectionContext.Provider>
      )}

    </div>
    <AnalystPanel />
    </div>
    </div>
  )
}

// ──────────────────────────── Profile ────────────────────────────

// ──────────────────────────── Notification Preferences ────────────────────────────

// ──────────────────────────── Claude Key ────────────────────────────

// ──────────────────────────── AI Providers ────────────────────────────

// ──────────────────────────── Inbound Email ────────────────────────────

// ──────────────────────────── Google Connection (shared) ────────────────────────────

// ──────────────────────────── Storage ────────────────────────────

// ──────────────────────────── Outbound Email ────────────────────────────

// ──────────────────────────── Senders ────────────────────────────

// ──────────────────────────── Shared ────────────────────────────
//
// GroupHeader / Section / AdminSectionContext now live in components/settings/section.tsx,
// so the settings cards that live in their own files can render with the same admin chrome
// instead of a bare <Card>. They are imported at the top of this file.
