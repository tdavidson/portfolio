// `whoami`: what a connection is and what it can reach, in one call.
//
// An assistant that is unsure what it may do, or that just had a call refused, asks this first. The
// answer is built from the same access context every tool is gated on (effectiveAccess), so it never
// claims more than a call would be allowed.

import type { AgentToolContext } from '@/lib/accounting/agent-tools'
import { effectiveAccess, type AccessContext, type AccessLevel } from '@/lib/access/effective'
import { DOMAINS, DOMAIN_META } from '@/lib/access/domains'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { loadBranding } from '@/lib/mcp-apps/branding'
import { APP_VERSION } from '@/lib/version'

const LEVEL_WORDS: Record<Exclude<AccessLevel, 'none'>, string> = {
  read: 'read',
  propose: 'propose (changes wait for approval)',
  write: 'edit',
}

export interface WhoamiAnswer {
  fund: string | null
  deployment: { origin: string | null; version: string }
  member: { email: string | null; role: string; admin: boolean }
  credential: {
    kind: 'chat assistant (OAuth)' | 'API key' | 'unknown'
    canChange: boolean | null
    note: string
  }
  access: Array<{ area: string; level: string }>
  noAccess: string[]
  entities: 'all' | string[]
  next: string
}

/** The member's level in every area, in the order the access grid shows them. */
export function accessByArea(access: AccessContext): { granted: WhoamiAnswer['access']; none: string[] } {
  const granted: WhoamiAnswer['access'] = []
  const none: string[] = []
  for (const domain of DOMAINS) {
    const level = effectiveAccess(access, domain)
    const area = DOMAIN_META[domain].label
    if (level === 'none') none.push(area)
    else granted.push({ area, level: LEVEL_WORDS[level] })
  }
  return { granted, none }
}

export function credentialSummary(credential: AgentToolContext['credential']): WhoamiAnswer['credential'] {
  if (!credential) return { kind: 'unknown', canChange: null, note: 'The credential type is not known for this call.' }
  if (credential.kind === 'assistant') {
    return {
      kind: 'chat assistant (OAuth)',
      canChange: credential.canWrite,
      note: credential.canWrite
        ? 'Approved to read and change. Most changes are staged and wait for a person to approve them; anything sent to LPs or moving money needs an admin.'
        : 'Approved as read only: tools that change anything are not offered. Reconnect and choose read and change to make changes.',
    }
  }
  return {
    kind: 'API key',
    canChange: credential.canWrite,
    note: credential.canWrite
      ? 'A read-and-write key: changes run at once, except the ones that always wait for a person (LP sends and capital calls). Admin-only changes are refused, since a key has no one to ask.'
      : 'A read-only key: changes are refused.',
  }
}

export async function whoami(ctx: AgentToolContext): Promise<WhoamiAnswer> {
  const [branding, scope, user] = await Promise.all([
    loadBranding(ctx.admin, ctx.fundId).catch(() => ({ fundName: null })),
    entityScopeFor(ctx.admin, ctx.access),
    ctx.userId
      ? ctx.admin.auth.admin.getUserById(ctx.userId).then(r => r.data?.user ?? null).catch(() => null)
      : Promise.resolve(null),
  ])
  const { granted, none } = accessByArea(ctx.access)
  const isAdmin = ctx.access.role === 'admin'
  return {
    fund: branding.fundName ?? null,
    deployment: { origin: ctx.origin ?? null, version: APP_VERSION },
    member: { email: user?.email ?? null, role: ctx.access.role, admin: isAdmin },
    credential: credentialSummary(ctx.credential),
    access: granted,
    noAccess: none,
    entities: scope.vehicleNames === null ? 'all' : scope.vehicleNames,
    next: 'For what to ask or open, call show_home (or help where the host cannot draw it). To work in another fund, list_funds and use_fund.',
  }
}
