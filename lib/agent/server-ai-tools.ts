// Handlers for the SERVER-AI tools (server-ai-tools-manifest.ts). Each calls the lib function the
// web button calls, after the same per-person rate limit, and refuses on a fund with no key.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { visibleCompanyIds } from '@/lib/access/scope'
import { serverAIRefusal } from '@/lib/ai/server-ai'
import { generateCompanySummary } from '@/lib/companies/summary'
import { parsePortfolioImport } from '@/lib/portfolio/ai-import'
import { rateLimit } from '@/lib/rate-limit'
import { unwrap } from '@/lib/service-outcome'
import { requireUser } from './deals-tools'
import { resolveCompany } from './portfolio-tools'

async function refuseWithoutKey(ctx: AgentToolContext, tool: string) {
  const refusal = await serverAIRefusal(ctx.admin, ctx.fundId, tool)
  if (refusal) throw new Error(refusal)
}

/** The web buttons' own limits (10 per 5 minutes per person), shared with them. */
async function limit(key: string) {
  const limited = await rateLimit({ key, limit: 10, windowSeconds: 300 })
  if (limited) throw new Error('Too many AI requests in the last few minutes. Wait a little and try again.')
}

export const SERVER_AI_HANDLERS: Record<string, AgentToolHandler> = {
  company_generate_summary: async (ctx: AgentToolContext, input: any) => {
    await refuseWithoutKey(ctx, 'company_generate_summary')
    const company = await resolveCompany(ctx.admin, ctx.fundId, String(input?.company ?? ''), ctx.access)
    await limit(`ai-summary:${requireUser(ctx.userId)}`)
    const provider = input?.provider === 'anthropic' || input?.provider === 'openai' ? input.provider : undefined
    const out = unwrap(await generateCompanySummary(ctx.admin, ctx.access, company.id, { provider }))
    return { company: company.name, ...out, saved: out.generated_at !== null }
  },

  portfolio_import_preview: async (ctx: AgentToolContext, input: any) => {
    await refuseWithoutKey(ctx, 'portfolio_import_preview')
    const userId = requireUser(ctx.userId)
    await limit(`import:${userId}`)
    const parsed = unwrap(await parsePortfolioImport(ctx.admin, ctx.fundId, userId, input?.text))

    // Which rows are companies the caller already has, matched by name as the web import matches.
    const visible = await visibleCompanyIds(ctx.admin, ctx.access)
    const { data: existing } = await (ctx.admin as any)
      .from('companies').select('id, name').eq('fund_id', ctx.fundId).eq('holding_type', 'company')
    const byName = new Map(((existing ?? []) as { id: string; name: string }[])
      .filter(c => visible === null || visible.includes(c.id))
      .map(c => [c.name.trim().toLowerCase(), c]))

    const companies = parsed.companies.map(c => {
      const name = typeof c?.name === 'string' ? c.name.trim() : ''
      const match = name ? byName.get(name.toLowerCase()) : undefined
      return {
        ...c,
        match: match ? { existingCompanyId: match.id, existingName: match.name } : null,
        action: !name ? 'skip: no name'
          : match ? 'existing company: record its metric values'
          : visible === null ? 'new company: create_company, then its metric values'
          : 'not one of your companies: an admin must add it to one of your entities first',
      }
    })
    return {
      written: false,
      companies,
      counts: {
        companies: companies.length,
        existing: companies.filter(c => c.match).length,
        new: companies.filter(c => !c.match && c.action.startsWith('new')).length,
        metricValues: companies.reduce((n, c) => n + (c.metrics ?? []).reduce((m, x) => m + (x.historical_values?.length ?? 0), 0), 0),
      },
      next:
        'Nothing has been written. Show the person this proposal and confirm it. Then apply it: create_company for each new ' +
        'company (with its stage, industry, overview, founders, why_invested, contact_emails, tags), and record_metric_value ' +
        'for each historical value of a metric the company tracks (company_metrics lists them). Put the changes in one ' +
        'stage_run so they are approved together.',
    }
  },
}
