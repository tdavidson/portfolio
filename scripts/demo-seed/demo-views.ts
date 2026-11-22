/**
 * Save the demo fund's custom views: a few shared layouts, so /views in the demo (and the demo
 * MCP connection's list_custom_views) has something to open beyond the starters.
 *
 *   npx tsx --env-file=.env.local scripts/demo-seed/demo-views.ts            # resolve each view as the viewer, save nothing
 *   npx tsx --env-file=.env.local scripts/demo-seed/demo-views.ts --save     # and save them, shared
 *   npx tsx --env-file=.env.local scripts/demo-seed/demo-views.ts --remove   # delete them again
 *
 * Owned by the demo agent account (scripts/demo-agent-account.ts), the demo fund's one member:
 * the viewer can't save a view, and the fund has no admin. Saving is by name, so rerunning
 * replaces each view rather than adding a copy. The dry run loads every block as the DEMO viewer
 * (DEMO_EMAIL), so a block that would render empty or refused in the demo shows up here first.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY: custom_views is service-role only (20261120000000_custom_views.sql).
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { loadAccessContext } from '@/lib/access/effective'
import { resolveView } from '@/lib/custom-views/resolve'
import { parseViewSpec } from '@/lib/custom-views/spec'
import { deleteView, listViews, saveView } from '@/lib/custom-views/store'

const DEMO_FUND_NAME = process.env.DEMO_FUND_NAME ?? 'Hemrock Ventures'
const AGENT_EMAIL = process.env.DEMO_AGENT_EMAIL ?? 'demo-agent@hemrock.invalid'
const VIEWER_EMAIL = process.env.DEMO_EMAIL ?? process.env.DEMO_USER_EMAIL ?? 'hello@hemrock.com'

const src = (tool: string, dataset: string, query: Record<string, unknown> = {}, computed?: { as: string; formula: string }[]) =>
  ({ tool, dataset, query, ...(computed ? { computed } : {}) })
const sum = (column: string, as = column) => ({ fn: 'sum', column, as })
const count = (as: string) => ({ fn: 'count', as })

/** Generic wording only: no company, investor or figure is named in a spec. */
export const DEMO_VIEWS: { name: string; spec: Record<string, unknown> }[] = [
  {
    name: 'Capital call reconciliation',
    spec: {
      title: 'Capital call reconciliation',
      description: 'Each call\'s amount against what has been received, investors who say they have wired but are not yet matched, and what is overdue.',
      params: ['vehicle'],
      blocks: [
        { id: 'amount', type: 'kpi', label: 'Called', span: 3, format: 'currency', value: 'amount', source: src('query_lps', 'capital_call_lines', { aggregates: [sum('amount')] }) },
        { id: 'funded', type: 'kpi', label: 'Received', span: 3, format: 'currency', value: 'funded', source: src('query_lps', 'capital_call_lines', { aggregates: [sum('funded')] }) },
        { type: 'kpi', label: 'Outstanding', span: 3, format: 'currency', value: 'outstanding', source: src('query_lps', 'capital_call_lines', { aggregates: [sum('outstanding')] }) },
        { type: 'kpi', label: 'Share received', span: 3, formula: 'funded / amount * 100', format: 'percent' },
        {
          type: 'column', label: 'Called and received by investor', span: 12, format: 'currency', x: 'lp', y: 'called', measures: ['received'], stack: 'grouped',
          source: src('query_lps', 'capital_call_lines', { group_by: ['lp'], aggregates: [sum('amount', 'called'), sum('funded', 'received')], order_by: [{ column: 'called', direction: 'desc' }] }),
        },
        {
          type: 'table', label: 'Unmatched: still owed', span: 12, totals: true,
          source: src('query_lps', 'capital_call_lines', {
            columns: ['lp', 'vehicle', 'call_number', 'due_date', 'amount', 'funded', 'outstanding', 'says_wired', 'overdue'],
            where: [{ column: 'outstanding', op: 'gt', value: 0 }],
            order_by: [{ column: 'due_date', direction: 'asc' }],
          }),
          columns: [
            { column: 'lp', label: 'Investor' }, 'vehicle', { column: 'call_number', label: 'Call' }, { column: 'due_date', label: 'Due', format: 'date' },
            { column: 'amount', format: 'currency' }, { column: 'funded', label: 'Received', format: 'currency' },
            { column: 'outstanding', format: 'currency', tone: 'sign' }, { column: 'says_wired', label: 'Says wired' }, 'overdue',
          ],
        },
      ],
    },
  },
  {
    name: 'Mark freshness',
    spec: {
      title: 'Mark freshness',
      description: 'How old each active position\'s mark is and where it came from, oldest first, for the quarter-end valuation review.',
      params: ['vehicle', 'as_of'],
      blocks: [
        {
          type: 'kpi', label: 'Active positions', span: 4, format: 'number', value: 'positions',
          source: src('query_portfolio', 'positions', { where: [{ column: 'status', op: 'eq', value: 'active' }], aggregates: [count('positions')] }),
        },
        {
          type: 'kpi', label: 'Marks older than 180 days', span: 4, format: 'number', value: 'stale',
          source: src('query_portfolio', 'positions', { where: [{ column: 'status', op: 'eq', value: 'active' }, { column: 'mark_age_days', op: 'gt', value: 180 }], aggregates: [count('stale')] }),
        },
        {
          type: 'kpi', label: 'Fair value on stale marks', span: 4, format: 'currency', value: 'fair_value',
          source: src('query_portfolio', 'positions', { where: [{ column: 'status', op: 'eq', value: 'active' }, { column: 'mark_age_days', op: 'gt', value: 180 }], aggregates: [sum('fair_value')] }),
        },
        {
          type: 'pie', label: 'Fair value by mark source', span: 6, format: 'currency', x: 'last_mark_source', y: 'fair_value',
          source: src('query_portfolio', 'positions', { where: [{ column: 'status', op: 'eq', value: 'active' }], group_by: ['last_mark_source'], aggregates: [sum('fair_value')], order_by: [{ column: 'fair_value', direction: 'desc' }] }),
        },
        {
          type: 'bar', label: 'Mark age in days', span: 6, format: 'number', x: 'company', y: 'mark_age_days',
          source: src('query_portfolio', 'positions', { columns: ['company', 'mark_age_days'], where: [{ column: 'status', op: 'eq', value: 'active' }], order_by: [{ column: 'mark_age_days', direction: 'desc' }], limit: 10 }),
        },
        {
          type: 'table', label: 'Active positions, oldest mark first', span: 12,
          source: src('query_portfolio', 'positions', {
            columns: ['company', 'company_id', 'stage', 'fair_value', 'moic', 'last_mark_date', 'last_mark_source', 'mark_age_days'],
            where: [{ column: 'status', op: 'eq', value: 'active' }],
            order_by: [{ column: 'mark_age_days', direction: 'desc' }],
          }),
          columns: [
            { column: 'company', link: 'company' }, 'stage', { column: 'fair_value', label: 'Fair value', format: 'currency' },
            { column: 'moic', label: 'MOIC', format: 'multiple' }, { column: 'last_mark_date', label: 'Last mark', format: 'date' },
            { column: 'last_mark_source', label: 'Source' }, { column: 'mark_age_days', label: 'Age (days)', format: 'number' },
          ],
        },
      ],
    },
  },
  {
    name: 'Cash and deployment',
    spec: {
      title: 'Cash and deployment',
      description: 'Cash at each month end, what went into companies and came back by quarter, and the latest investment activity.',
      params: ['vehicle', 'as_of'],
      blocks: [
        {
          type: 'line', label: 'Cash at month end', span: 6, format: 'currency', x: 'month', y: 'ending',
          source: src('query_funds', 'cash_by_month', { columns: ['month', 'ending'], order_by: [{ column: 'month', direction: 'asc' }] }),
        },
        {
          type: 'column', label: 'Capital called and invested by year', span: 6, format: 'currency', x: 'month_year', y: 'called', measures: ['deployed'], stack: 'grouped',
          source: src('query_funds', 'cash_by_month', { group_by: ['month:year'], aggregates: [sum('called'), sum('invested')], order_by: [{ column: 'month_year', direction: 'asc' }] },
            // Investments leave the account, so the cash dataset holds them as negatives.
            [{ as: 'deployed', formula: '0 - invested' }]),
        },
        {
          type: 'table', label: 'Latest investment activity', span: 12,
          source: src('query_portfolio', 'transactions', {
            columns: ['date', 'company', 'company_id', 'vehicle', 'type', 'round', 'invested', 'proceeds'],
            where: [{ column: 'type', op: 'neq', value: 'unrealized_gain_change' }],
            order_by: [{ column: 'date', direction: 'desc' }], limit: 15,
          }),
          columns: [
            { column: 'date', format: 'date' }, { column: 'company', link: 'company' }, 'vehicle', 'type', 'round',
            { column: 'invested', format: 'currency' }, { column: 'proceeds', format: 'currency' },
          ],
        },
      ],
    },
  },
  {
    name: 'Partner capital roll-forward',
    spec: {
      title: 'Partner capital roll-forward',
      description: 'Each partner\'s capital account from contributions to ending balance: fees, expenses, gains and carry, for the quarter-end LP tie-out.',
      params: ['vehicle', 'as_of'],
      blocks: [
        { type: 'kpi', label: 'Contributions', span: 3, format: 'currency', value: 'contributions', source: src('query_lps', 'capital_accounts', { aggregates: [sum('contributions')] }) },
        { type: 'kpi', label: 'Management fees', span: 3, format: 'currency', value: 'management_fees', source: src('query_lps', 'capital_accounts', { aggregates: [sum('management_fees')] }) },
        { type: 'kpi', label: 'Unrealized gains', span: 3, format: 'currency', value: 'unrealized_gains', source: src('query_lps', 'capital_accounts', { aggregates: [sum('unrealized_gains')] }) },
        { type: 'kpi', label: 'Ending capital', span: 3, format: 'currency', value: 'ending', source: src('query_lps', 'capital_accounts', { aggregates: [sum('ending')] }) },
        {
          type: 'table', label: 'Capital accounts', span: 12, totals: true,
          source: src('query_lps', 'capital_accounts', {
            columns: ['partner', 'contributions', 'distributions', 'management_fees', 'expenses', 'realized_gains', 'unrealized_gains', 'carried_interest', 'ending'],
            order_by: [{ column: 'ending', direction: 'desc' }],
          }),
          columns: [
            'partner',
            { column: 'contributions', format: 'currency' }, { column: 'distributions', format: 'currency' },
            { column: 'management_fees', label: 'Fees', format: 'currency', tone: 'sign' }, { column: 'expenses', format: 'currency', tone: 'sign' },
            { column: 'realized_gains', label: 'Realized', format: 'currency', tone: 'sign' }, { column: 'unrealized_gains', label: 'Unrealized', format: 'currency', tone: 'sign' },
            { column: 'carried_interest', label: 'Carry', format: 'currency', tone: 'sign' }, { column: 'ending', label: 'Ending', format: 'currency' },
          ],
        },
      ],
    },
  },
]

async function userId(admin: any, email: string): Promise<string> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const id = data?.users?.find((u: { email?: string }) => u.email === email)?.id
  if (!id) throw new Error(`No user ${email}.${email === AGENT_EMAIL ? ' Run scripts/demo-agent-account.ts first.' : ''}`)
  return id
}

async function main() {
  const save = process.argv.includes('--save')
  const remove = process.argv.includes('--remove')
  const admin = createAdminClient() as any

  const { data: fund } = await admin.from('funds').select('id').eq('name', DEMO_FUND_NAME).maybeSingle()
  if (!fund) throw new Error(`No "${DEMO_FUND_NAME}" fund.`)
  const fundId = fund.id as string
  const owner = await userId(admin, AGENT_EMAIL)

  if (remove) {
    const names = new Set(DEMO_VIEWS.map(v => v.name.toLowerCase()))
    for (const v of await listViews(admin, fundId, owner)) {
      if (v.kind === 'mine' && names.has(v.name.toLowerCase())) { await deleteView(admin, fundId, owner, v.id); console.log(`deleted ${v.name}`) }
    }
    return
  }

  // Resolve as the viewer, as the demo will: the agent's grants are wider than what visitors see.
  const viewer = await userId(admin, VIEWER_EMAIL)
  const access = await loadAccessContext(admin, fundId, viewer, 'viewer')
  let problems = 0
  for (const v of DEMO_VIEWS) {
    const spec = parseViewSpec(v.spec)
    const payload = await resolveView({ admin, fundId, userId: viewer, access }, spec, {}, { id: null })
    console.log(`\n${v.name}`)
    for (const b of payload.data.blocks) {
      const n = b.rows?.length ?? b.points?.length ?? b.dots?.length
      const empty = b.type === 'kpi' ? b.value == null : n === 0
      const state = b.status !== 'ok' ? `!! ${b.status}: ${b.message ?? ''}` : empty ? '!! empty' : ''
      if (state) problems++
      const shown = b.type === 'kpi' ? `value=${b.value}` : `${n} rows`
      console.log(`  ${b.type.padEnd(7)} ${b.label.padEnd(42)} ${state || shown}`)
    }
  }
  if (!save) { console.log(`\n${problems} empty or refused blocks. Dry run: pass --save to save.`); return }
  for (const v of DEMO_VIEWS) {
    const saved = await saveView(admin, fundId, owner, { name: v.name, spec: v.spec, shared: true })
    console.log(`saved ${saved.name}  /views/${saved.id}`)
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
