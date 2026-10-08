import type { PageContext } from './context'
import { loadDashboardPage } from '@/app/(app)/dashboard/load'
import { loadCompanyPage } from '@/app/(app)/companies/[id]/load'
import { loadCompanyUpdatesPage } from '@/app/(app)/company-updates/load'
import { loadEmailPage } from '@/app/(app)/emails/[id]/load'
import { loadInteractionsPage } from '@/app/(app)/interactions/load'
import { loadDealsPage } from '@/app/(app)/deals/load'
import { loadDealPage } from '@/app/(app)/deals/[id]/load'
import { loadDiligencePage } from '@/app/(app)/diligence/load'
import { loadDiligenceDealPage } from '@/app/(app)/diligence/[id]/load'
import { loadDiligenceQaPage } from '@/app/(app)/diligence/[id]/qa/load'
import { loadMemoDraftPage } from '@/app/(app)/diligence/[id]/drafts/[draftId]/load'

/**
 * Every server page that loads data, with how to enumerate the URLs it serves for one fund.
 *
 * scripts/demo-snapshot.ts walks this as the demo fund's viewer and writes each loader's result
 * under its URL into demo-widget/data/pages.json; the widget's route table (demo-widget/routes.tsx)
 * mounts the page's view with that result. A page added to the app without an entry here still
 * works in the app and simply has no data in the demo — demo-widget/routes.test.ts says which.
 */
export interface PageLoaderEntry {
  /** Concrete URLs for this fund, e.g. `/companies/<id>` for each company. */
  hrefs: (ctx: PageContext) => Promise<string[]>
  /** The loader, given the URL's params; null means the page would 404 or redirect. */
  load: (ctx: PageContext, params: Record<string, string>) => Promise<unknown>
}

const one = (href: string) => async () => [href]

async function ids(ctx: PageContext, table: string, filter: (q: any) => any = q => q): Promise<string[]> {
  const { data } = await filter((ctx.admin as any).from(table).select('id').eq('fund_id', ctx.page.fundId))
  return ((data as { id: string }[] | null) ?? []).map(r => r.id)
}

export const PAGE_LOADERS: Record<string, PageLoaderEntry> = {
  '/dashboard': { hrefs: one('/dashboard'), load: ctx => loadDashboardPage(ctx) },
  '/companies/:id': {
    hrefs: async ctx => (await ids(ctx, 'companies', q => q.in('holding_type', ['company', 'fund', 'crypto']))).map(id => `/companies/${id}`),
    load: (ctx, p) => loadCompanyPage(ctx, { id: p.id }),
  },
  '/company-updates': { hrefs: one('/company-updates'), load: ctx => loadCompanyUpdatesPage(ctx) },
  '/emails/:id': {
    hrefs: async ctx => (await ids(ctx, 'inbound_emails', q => q.order('received_at', { ascending: false }).limit(50))).map(id => `/emails/${id}`),
    load: (ctx, p) => loadEmailPage(ctx, { id: p.id }),
  },
  '/interactions': { hrefs: one('/interactions'), load: ctx => loadInteractionsPage(ctx) },
  '/deals': { hrefs: one('/deals'), load: ctx => loadDealsPage(ctx) },
  '/deals/:id': {
    hrefs: async ctx => (await ids(ctx, 'inbound_deals')).map(id => `/deals/${id}`),
    load: (ctx, p) => loadDealPage(ctx, { id: p.id }),
  },
  '/diligence': { hrefs: one('/diligence'), load: ctx => loadDiligencePage(ctx) },
  '/diligence/:id': {
    hrefs: async ctx => (await ids(ctx, 'diligence_deals')).map(id => `/diligence/${id}`),
    load: (ctx, p) => loadDiligenceDealPage(ctx, { id: p.id }),
  },
  '/diligence/:id/qa': {
    hrefs: async ctx => (await ids(ctx, 'diligence_deals')).map(id => `/diligence/${id}/qa`),
    load: (ctx, p) => loadDiligenceQaPage(ctx, { id: p.id }),
  },
  '/diligence/:id/drafts/:draftId': {
    hrefs: async ctx => {
      const { data } = await (ctx.admin as any).from('diligence_memo_drafts').select('id, deal_id').eq('fund_id', ctx.page.fundId)
      return ((data as { id: string; deal_id: string }[] | null) ?? []).map(d => `/diligence/${d.deal_id}/drafts/${d.id}`)
    },
    load: (ctx, p) => loadMemoDraftPage(ctx, { id: p.id, draftId: p.draftId }),
  },
}

/** Match a concrete href against a pattern like `/companies/:id`; the params, or null. */
export function matchPattern(pattern: string, href: string): Record<string, string> | null {
  const a = pattern.split('/'), b = href.split('?')[0].split('/')
  if (a.length !== b.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return null
  }
  return params
}
