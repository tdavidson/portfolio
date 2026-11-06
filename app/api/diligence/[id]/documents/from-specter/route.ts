import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMcpServerForUser, getMcpConnectionStatus } from '@/lib/mcp-client/connections'
import { getStageProvider } from '@/lib/memo-agent/stage-provider'
import { logAIUsage } from '@/lib/ai/usage'
import { enqueueIngestForDocuments } from '@/lib/diligence/enqueue-ingest'
import { compileSpecterProfile, profileFileName, saveProfileToDataRoom } from '@/lib/specter/profile'

/**
 * "Save Specter profile": look the deal's company up in Specter with the CALLER's own sign-in,
 * write a profile, and add it to the deal's data room, queued for ingest like any upload.
 *
 * GET says whether the caller can use it (connected, and the fund's provider is Claude).
 */

export const maxDuration = 120

async function member() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, fundId: (membership as any).fund_id as string, userId: user.id }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  await props.params
  const guard = await member()
  if ('error' in guard) return guard.error
  const status = await getMcpConnectionStatus(guard.admin, guard.fundId, guard.userId, 'specter')
  const { provider } = await getStageProvider(guard.admin, guard.fundId, 'research')
  return NextResponse.json({
    connected: status.enabled && status.connected,
    supported: provider.supportsToolLoop === true,
  })
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const guard = await member()
  if ('error' in guard) return guard.error
  const { admin, fundId, userId } = guard

  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id, name')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const dealName = (deal as any).name as string

  const body = await req.json().catch(() => ({}))
  const query = (typeof body.query === 'string' ? body.query.trim() : '').slice(0, 200) || dealName

  const { provider, model, providerType } = await getStageProvider(admin, fundId, 'research')
  if (!provider.supportsToolLoop) {
    return NextResponse.json({ error: 'Specter profiles need Claude as the fund’s AI provider.' }, { status: 400 })
  }
  const server = await getMcpServerForUser(admin, userId, 'specter')
  if (!server) {
    return NextResponse.json(
      { error: 'Connect your Specter account in Settings first, or reconnect it.', needs_connection: true },
      { status: 400 },
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  let profile
  try {
    profile = await compileSpecterProfile({ provider, model, server, query, dealName, today })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Specter lookup failed' }, { status: 502 })
  }
  logAIUsage(admin, { fundId, provider: providerType, model, feature: 'diligence_specter_profile', usage: profile.loop.usage })

  if (!profile.markdown) {
    return NextResponse.json({ error: `Couldn’t find that company in Specter. ${profile.notFound ?? ''}`.trim(), not_found: true }, { status: 404 })
  }

  const fileName = profileFileName(profile.companyName, query, today)
  let documentId: string
  try {
    documentId = await saveProfileToDataRoom(admin, { fundId, dealId: params.id, userId, fileName, markdown: profile.markdown })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Save failed' }, { status: 500 })
  }

  // A document that isn't ingested is invisible to the memo agent.
  const ingest = await enqueueIngestForDocuments(admin, { fundId, dealId: params.id, documentIds: [documentId], enqueuedBy: userId })

  return NextResponse.json({
    document_id: documentId,
    file_name: fileName,
    company: profile.companyName,
    ingest_queued: ingest.enqueued,
    specter_lookups: profile.loop.toolCalls.filter(c => c.server === 'specter' && !c.isError).map(c => c.name),
  })
}
