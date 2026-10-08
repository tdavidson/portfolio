import type { FeatureKey, FeatureVisibility, FeatureVisibilityMap } from '@/lib/types/features'

export interface Sender {
  id: string
  email: string
  label: string | null
  created_at: string
}

export interface SettingsData {
  fundId: string
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  signInLogo: string | null
  signInTitle: string | null
  postmarkInboundAddress: string
  postmarkWebhookToken: string
  hasClaudeKey: boolean
  claudeModel: string
  hasOpenAIKey: boolean
  openaiModel: string
  defaultAIProvider: string
  hasOpenRouterKey: boolean
  openrouterModel: string
  openrouterBaseUrl: string
  retainResolvedReviews: boolean
  resolvedReviewsTtlDays: number | null
  senders: Sender[]
  googleDriveConnected: boolean
  googleDriveFolderId: string | null
  googleDriveFolderName: string | null
  hasGoogleCredentials: boolean
  googleClientId: string
  fileStorageProvider: string | null
  aiSummaryPrompt: string | null
  outboundEmailProvider: string | null
  asksEmailProvider: string | null
  approvalEmailSubject: string | null
  approvalEmailBody: string | null
  systemEmailFromName: string | null
  systemEmailFromAddress: string | null
  hasResendKey: boolean
  hasPostmarkServerToken: boolean
  inboundEmailProvider: string | null
  mailgunInboundDomain: string
  hasMailgunSigningKey: boolean
  hasMailgunApiKey: boolean
  mailgunSendingDomain: string
  analyticsFathomSiteId: string | null
  analyticsGaMeasurementId: string | null
  analyticsCustomHeadScript: string | null
  disableUserTracking: boolean
  currency: string
  featureVisibility: Record<string, string>
  displayName: string
  isAdmin: boolean
  appVersion: string
  updateAvailable: boolean
  dealThesis: string | null
  dealScreeningPrompt: string | null
  dealIntakeEnabled: boolean
  dealsDefaultVehicleId: string | null
  hasSubmissionToken: boolean
  lpPortalEnabled: boolean
}

export type Saved = () => void
