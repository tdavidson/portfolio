import { createAdminClient } from '@/lib/supabase/admin'
import { hasCredential } from '@/lib/credentials/env'
import { accessMap, canWriteAnywhere, effectiveAccess, hasAccess } from '@/lib/access/effective'
import { credentialKindOf, isRestrictedCredential } from '@/lib/ai/analyst/types'
import { DOMAINS } from '@/lib/access/domains'
import { domainForFeature } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureKey } from '@/lib/types/features'
import { API_VERSION, SERVER_VERSION } from '@/lib/api-v1/constants'
import { resolveV1Principal, V1PrincipalError } from '@/lib/api-v1/principal'
import { requestId, v1Error, v1Json } from '@/lib/api-v1/response'

// Authenticated and per-request by construction: it reads the caller's bearer token. Saying so
// explicitly keeps `next build` from probing it as a static route and logging the bailout.
/** Safe, human-facing names. The provider key is an internal identifier; this is what a person reads. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
}

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const id = requestId()
  const admin = createAdminClient()
  try {
    const principal = await resolveV1Principal(admin, req)
    const [
      { data: member, error: memberError },
      { data: fund, error: fundError },
      { data: settings, error: settingsError },
    ] = await Promise.all([
      admin.from('fund_members').select('display_name').eq('fund_id', principal.fundId).eq('user_id', principal.userId).maybeSingle(),
      admin.from('funds').select('name').eq('id', principal.fundId).maybeSingle(),
      admin.from('fund_settings')
        .select('default_ai_provider, claude_api_key_encrypted, openai_api_key_encrypted')
        .eq('fund_id', principal.fundId).maybeSingle(),
    ])
    if (memberError) throw new Error(memberError.message)
    if (fundError) throw new Error(fundError.message)
    if (settingsError) throw new Error(settingsError.message)
    if (!fund) return v1Error('FUND_NOT_FOUND', 'Fund not found.', 404, id)

    const enabledFeatures = (Object.keys(DEFAULT_FEATURE_VISIBILITY) as FeatureKey[]).filter(feature => {
      const domain = domainForFeature(feature)
      return domain ? effectiveAccess(principal.access, domain, feature) !== 'none' : false
    })
    const availableAnalystScopes = [
      effectiveAccess(principal.access, 'portfolio') !== 'none' ? 'portfolio' : null,
      effectiveAccess(principal.access, 'accounting') !== 'none' ? 'funds' : null,
      effectiveAccess(principal.access, 'accounting') !== 'none' ? 'accounting' : null,
      effectiveAccess(principal.access, 'lp_capital') !== 'none' ? 'lps' : null,
      effectiveAccess(principal.access, 'diligence') !== 'none' ? 'diligence' : null,
    ].filter((value): value is string => value !== null)

    // What the app may show about the model answering its questions. A NAME and whether one is
    // configured at all — never the key, never the encrypted key, never which env var holds it.
    // A fund with no provider configured is a real state the app has to render: chat will fail,
    // and saying so up front beats a mystery error on the first message.
    const configured = (settings?.default_ai_provider ?? 'anthropic') === 'openai'
      ? hasCredential(settings, 'openai')
      : hasCredential(settings, 'anthropic')
    const aiProvider = {
      displayName: PROVIDER_DISPLAY_NAMES[settings?.default_ai_provider ?? 'anthropic'] ?? 'AI provider',
      configured,
    }

    // Derived here so the app does not have to reimplement the resolver to grey out a button.
    // NOT authorization: every write re-checks live access at the moment it runs, and a demo
    // credential is refused by the pending-action service regardless of what this said.
    const restricted = isRestrictedCredential(principal)
    const canWrite = principal.scopes.includes('write')
    const canStageActions = !restricted && canWrite && canWriteAnywhere(principal.access)
    const canApproveActions = !restricted && canWrite &&
      DOMAINS.some(domain => hasAccess(principal.access, domain, 'write'))

    return v1Json({
      user: { id: principal.userId, displayName: member?.display_name ?? null },
      fund: { id: principal.fundId, name: fund.name },
      role: principal.role,
      credentialKind: credentialKindOf(principal),
      isDemo: restricted,
      access: accessMap(principal.access),
      enabledFeatures,
      availableAnalystScopes,
      aiProvider,
      canStageActions,
      canApproveActions,
      serverVersion: SERVER_VERSION,
      apiVersion: API_VERSION,
    }, { requestId: id })
  } catch (error) {
    if (error instanceof V1PrincipalError) return v1Error(error.code, error.message, error.status, id)
    console.error(`[api-v1] ${id} GET /me failed`, error)
    return v1Error('INTERNAL_ERROR', 'The request could not be completed.', 500, id)
  }
}

