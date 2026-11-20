// Pure metadata for the QUERY tools: questions no named tool answers ("LPs under 50% paid in",
// "fair value by industry", "legal fees by quarter"), answered by filtering, grouping and
// aggregating a dataset's rows. NO server imports (the Settings key UI lists these).
//
// One tool per area, so each is listed and gated with that area's access, and each dataset's rows
// come from a named tool's own scoped loader (query/catalog.ts, query/datasets.ts). Nothing here
// writes, and nothing reads a table the named tools don't.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { QUERY_CATALOG, type DatasetMeta } from './query/catalog'
import { querySchema } from './query/engine'

const AREA: Record<string, { domain: NonNullable<AgentToolMeta['domain']>; accessDomain?: AgentToolMeta['accessDomain']; label: string }> = {
  query_portfolio: { domain: 'portfolio', label: 'the portfolio: positions, companies, investment transactions and KPIs' },
  query_lps: { domain: 'lp', label: "LPs: each partner's position, capital account and capital call lines" },
  // The books' fund-level figures, as fund_performance and forecast_series read them: gated like them.
  query_funds: { domain: 'portfolio', accessDomain: 'accounting', label: "the funds' performance and financials: net LP figures per vehicle, monthly P&L and cash, and the forecast" },
  query_deals: { domain: 'deals', label: 'the inbound deal pipeline' },
  query_diligence: { domain: 'diligence', label: 'deals in diligence' },
  query_ledger: { domain: 'ledger', label: "one vehicle's posted journal lines" },
}

function describe(sets: DatasetMeta[]): string {
  return sets.map(d => `${d.name}: ${d.description} Columns: ${d.columns.map(c => `${c.name} (${c.type})`).join(', ')}.`).join(' ')
}

export const QUERY_TOOL_MANIFEST: AgentToolMeta[] = Object.entries(QUERY_CATALOG).map(([name, sets]) => {
  const area = AREA[name]
  const columns = [...new Set(sets.flatMap(d => d.columns.map(c => c.name)))]
  return {
    name,
    description:
      `Ask a question of ${area.label} that no other tool answers: filter, group (dates by month, quarter or year), ` +
      'aggregate (count, sum, average, median, min, max) and sort. Rows are exactly what the matching named tool would show ' +
      `this member. Prefer a named tool when one answers the question. Datasets — ${describe(sets)}`,
    scope: 'read' as const,
    domain: area.domain,
    ...(area.accessDomain ? { accessDomain: area.accessDomain } : {}),
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: sets.map(d => d.name), description: sets.length === 1 ? 'Optional: there is one.' : 'Which dataset to query.' },
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group). Narrows most datasets; required for per-vehicle ones when the fund has more than one.' },
        as_of: { type: 'string', description: 'As-of date (YYYY-MM-DD) for datasets measured at a date. Default today.' },
        ...querySchema(columns),
      },
      ...(sets.length > 1 ? { required: ['dataset'] } : {}),
    },
  }
})
