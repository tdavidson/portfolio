// What the query tools can ask about: each dataset's columns and the access it needs. Pure
// metadata, NO server imports (the tool manifest and the Settings key UI read it). The loaders
// live in datasets.ts.
//
// A dataset's gate is the access of the named tool its rows come from, so a query can never show
// more than that tool would; the query handler checks it before loading.

import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { Column } from './engine'

export interface DatasetMeta {
  name: string
  description: string
  columns: Column[]
  gate: { domain: Domain; feature?: FeatureKey }
  /** The named tool whose rows these are. */
  source: string
  /** Needs a vehicle (optional when the fund has one). */
  perVehicle?: true
}

export const QUERY_CATALOG: Record<string, DatasetMeta[]> = {
  query_portfolio: [
    {
      name: 'positions',
      description: 'One row per holding (companies and fund holdings) as of a date: invested, remaining cost, fair value, realized proceeds, gross MOIC, and when it was last marked and by what. For "which holdings have current marks", use the mark_status tool.',
      gate: { domain: 'portfolio' },
      source: 'portfolio_summary',
      columns: [
        { name: 'company', type: 'string' }, { name: 'company_id', type: 'string' },
        { name: 'status', type: 'string', description: 'active, exited, written-off' },
        { name: 'stage', type: 'string' }, { name: 'industry', type: 'list' },
        { name: 'invested', type: 'number' }, { name: 'cost', type: 'number', description: 'Cost still held' },
        { name: 'fair_value', type: 'number' }, { name: 'unrealized', type: 'number' }, { name: 'realized', type: 'number' },
        { name: 'moic', type: 'number' }, { name: 'pct_of_portfolio', type: 'number', description: 'Share of total fair value, in percent' },
        { name: 'holding_type', type: 'string', description: 'company, fund or digital_asset' },
        { name: 'last_mark_date', type: 'date', description: 'Date of the latest mark of any kind, on or before the as-of date' },
        { name: 'last_mark_source', type: 'string', description: 'nav_statement, nav (a value change booked from a manager NAV), manual, round or price' },
        { name: 'last_nav_statement_date', type: 'date', description: 'As-of date of the latest manager NAV statement, if any' },
        { name: 'last_nav_statement_nav', type: 'number', description: 'The NAV that statement reported' },
        { name: 'mark_age_days', type: 'number', description: 'Days from last_mark_date to the as-of date' },
      ],
    },
    {
      name: 'companies',
      description: 'Every portfolio company with its status, stage, industries and the vehicles that hold it.',
      gate: { domain: 'portfolio' },
      source: 'list_companies',
      columns: [
        { name: 'company', type: 'string' }, { name: 'company_id', type: 'string' }, { name: 'status', type: 'string' },
        { name: 'stage', type: 'string' }, { name: 'industry', type: 'list' }, { name: 'vehicles', type: 'list' },
      ],
    },
    {
      name: 'transactions',
      description: 'Every investment transaction: investments, follow-ons, marks, conversions and exits, with round, price and proceeds.',
      gate: { domain: 'portfolio', feature: 'investments' },
      source: 'list_investments',
      columns: [
        { name: 'date', type: 'date' }, { name: 'company', type: 'string' }, { name: 'company_id', type: 'string' },
        { name: 'vehicle', type: 'string' }, { name: 'type', type: 'string', description: 'investment, proceeds, unrealized_gain_change, round_info, …' },
        { name: 'round', type: 'string' }, { name: 'security', type: 'string' },
        { name: 'invested', type: 'number' }, { name: 'shares', type: 'number' }, { name: 'share_price', type: 'number' },
        { name: 'postmoney', type: 'number' }, { name: 'proceeds', type: 'number' }, { name: 'ownership_pct', type: 'number' },
        { name: 'holding_type', type: 'string', description: 'company, fund or digital_asset' },
        { name: 'mark_change', type: 'number', description: 'The signed value change a mark row booked (unrealized_value_change). Summed per fund holding it is its unrealized gain' },
        { name: 'mark_source', type: 'string', description: 'On mark rows: nav_statement, nav, manual, round or price' },
      ],
    },
    {
      name: 'kpis',
      description: 'Every reported KPI value for the portfolio: company, metric, period and value.',
      gate: { domain: 'portfolio' },
      source: 'company_metrics',
      columns: [
        { name: 'company', type: 'string' }, { name: 'company_id', type: 'string' }, { name: 'metric', type: 'string' },
        { name: 'unit', type: 'string' }, { name: 'period', type: 'string', description: 'The period label, e.g. Q3 2026' },
        { name: 'year', type: 'number' }, { name: 'quarter', type: 'number' }, { name: 'month', type: 'number' },
        { name: 'value', type: 'number' }, { name: 'value_text', type: 'string' },
      ],
    },
  ],
  query_lps: [
    {
      name: 'lp_positions',
      description: "Each LP's position in each vehicle, derived from the books as of a date: commitment, called, paid in, distributions, NAV, DPI, RVPI, TVPI and IRR.",
      gate: { domain: 'lp_capital' },
      source: 'lp_live_report',
      columns: [
        { name: 'investor', type: 'string' }, { name: 'entity', type: 'string' }, { name: 'vehicle', type: 'string' },
        { name: 'commitment', type: 'number' }, { name: 'called_capital', type: 'number' }, { name: 'paid_in_capital', type: 'number' },
        { name: 'unfunded', type: 'number', description: 'Commitment less called capital' },
        { name: 'distributions', type: 'number' }, { name: 'nav', type: 'number' }, { name: 'total_value', type: 'number' },
        { name: 'dpi', type: 'number' }, { name: 'rvpi', type: 'number' }, { name: 'tvpi', type: 'number' }, { name: 'irr', type: 'number' },
        { name: 'paid_in_pct', type: 'number', description: 'Paid in as a percent of commitment' },
      ],
    },
    {
      name: 'capital_call_lines',
      description: "One row per LP per capital call in a vehicle: amount called, funded, outstanding, due date, and whether it's overdue or the LP says they wired it.",
      gate: { domain: 'lp_capital' },
      source: 'lp_capital_calls',
      perVehicle: true,
      columns: [
        { name: 'vehicle', type: 'string' }, { name: 'call_number', type: 'number' }, { name: 'call_date', type: 'date' },
        { name: 'due_date', type: 'date' }, { name: 'lp', type: 'string' }, { name: 'amount', type: 'number' },
        { name: 'funded', type: 'number' }, { name: 'outstanding', type: 'number' }, { name: 'status', type: 'string' },
        { name: 'overdue', type: 'boolean' }, { name: 'funded_on', type: 'date' }, { name: 'says_wired', type: 'boolean' },
      ],
    },
    {
      name: 'capital_accounts',
      description: "Each partner's capital account in one vehicle, inception to the as-of date, from the books: contributions, distributions, fees, expenses, gains, carried interest and ending capital. Carry recipients are combined unless the member sees GP economics.",
      gate: { domain: 'lp_capital' },
      source: 'capital_accounts',
      perVehicle: true,
      columns: [
        { name: 'partner', type: 'string' },
        { name: 'contributions', type: 'number' }, { name: 'distributions', type: 'number' },
        { name: 'management_fees', type: 'number' }, { name: 'expenses', type: 'number' }, { name: 'operating_income', type: 'number' },
        { name: 'realized_gains', type: 'number' }, { name: 'unrealized_gains', type: 'number' }, { name: 'fx_translation', type: 'number' },
        { name: 'transfers', type: 'number' }, { name: 'carried_interest', type: 'number' }, { name: 'unclassified', type: 'number' },
        { name: 'ending', type: 'number', description: 'Ending capital (the partner\'s NAV)' },
      ],
    },
  ],
  query_funds: [
    {
      name: 'fund_performance',
      description: 'One row per vehicle, net to the LPs, from the books as of a date: committed, called, unfunded, distributed, NAV, DPI, RVPI, TVPI, net LP IRR and the carry accrued to the GP; gross_* figures are the whole fund (every partner, before carry).',
      gate: { domain: 'accounting' },
      source: 'fund_performance',
      columns: [
        { name: 'vehicle', type: 'string' },
        { name: 'committed', type: 'number' }, { name: 'called', type: 'number' }, { name: 'unfunded', type: 'number' },
        { name: 'distributed', type: 'number' }, { name: 'nav', type: 'number' },
        { name: 'dpi', type: 'number' }, { name: 'rvpi', type: 'number' }, { name: 'tvpi', type: 'number' },
        { name: 'net_lp_irr', type: 'number', description: 'Net LP IRR, in percent' },
        { name: 'carry_accrued', type: 'number', description: 'Carried interest accrued to the GP' },
        { name: 'gross_nav', type: 'number', description: 'Whole-fund NAV, before carry' },
        { name: 'gross_tvpi', type: 'number', description: 'Whole-fund TVPI, before carry' },
        { name: 'basis', type: 'string', description: 'books, mixed, or imported balances' },
      ],
    },
    {
      name: 'pnl_by_month',
      description: "One vehicle's posted income and expenses, one row per account per month, for the 36 months to the as-of date. amount is positive for both; net is income positive and expenses negative, so a sum of net is net income.",
      gate: { domain: 'accounting' },
      source: 'forecast_series',
      perVehicle: true,
      columns: [
        { name: 'month', type: 'date', description: 'First day of the month; group as month:quarter or month:year' },
        { name: 'account_code', type: 'string' }, { name: 'account_name', type: 'string' },
        { name: 'type', type: 'string', description: 'income or expense' },
        { name: 'amount', type: 'number' }, { name: 'net', type: 'number' },
        { name: 'status', type: 'string', description: 'actual, or actual_unclosed for a month not yet closed' },
      ],
    },
    {
      name: 'cash_by_month',
      description: "One vehicle's cash, one row per month for the 36 months to the as-of date: opening, movement and ending cash, and the movement by what moved it.",
      gate: { domain: 'accounting' },
      source: 'forecast_series',
      perVehicle: true,
      columns: [
        { name: 'month', type: 'date' }, { name: 'opening', type: 'number' }, { name: 'movement', type: 'number' }, { name: 'ending', type: 'number' },
        { name: 'operating', type: 'number' }, { name: 'invested', type: 'number' }, { name: 'proceeds', type: 'number' },
        { name: 'called', type: 'number' }, { name: 'distributed', type: 'number' }, { name: 'borrowed', type: 'number' }, { name: 'repaid', type: 'number' },
        { name: 'status', type: 'string' },
      ],
    },
    {
      name: 'forecast_by_month',
      description: "One vehicle's forecast: actuals through the cutoff, then its active plan (a rolling forecast before a budget), one row per account per month from 12 months before the as-of date to 24 after. status says which months are projected.",
      gate: { domain: 'accounting' },
      source: 'forecast_series',
      perVehicle: true,
      columns: [
        { name: 'plan', type: 'string' }, { name: 'month', type: 'date' },
        { name: 'account_code', type: 'string' }, { name: 'account_name', type: 'string' },
        { name: 'type', type: 'string', description: 'income or expense' },
        { name: 'amount', type: 'number' }, { name: 'net', type: 'number' },
        { name: 'status', type: 'string', description: 'actual, actual_unclosed, forecast or mixed' },
      ],
    },
  ],
  query_deals: [
    {
      name: 'inbound_deals',
      description: 'The inbound deal pipeline: company, founder, source, thesis fit, stage, industry, raise and status.',
      gate: { domain: 'dealflow' },
      source: 'deals_list_inbound',
      columns: [
        { name: 'company', type: 'string' }, { name: 'founder', type: 'string' }, { name: 'intro_source', type: 'string' },
        { name: 'referrer', type: 'string' }, { name: 'thesis_fit', type: 'string' }, { name: 'stage', type: 'string' },
        { name: 'industry', type: 'string' }, { name: 'raise', type: 'string' }, { name: 'status', type: 'string' },
        { name: 'in_diligence', type: 'boolean' }, { name: 'created_at', type: 'date' },
      ],
    },
  ],
  query_diligence: [
    {
      name: 'diligence_deals',
      description: 'Deals in diligence: name, sector, stage, status, memo stage and when each was opened.',
      gate: { domain: 'diligence' },
      source: 'diligence_list_deals',
      columns: [
        { name: 'name', type: 'string' }, { name: 'sector', type: 'string' }, { name: 'stage', type: 'string' },
        { name: 'status', type: 'string' }, { name: 'memo_stage', type: 'string' }, { name: 'created_at', type: 'date' },
      ],
    },
  ],
  query_ledger: [
    {
      name: 'journal_lines',
      description: "Every posted journal line in one vehicle's books: date, account, debit, credit and memo.",
      gate: { domain: 'accounting' },
      source: 'list_journal',
      perVehicle: true,
      columns: [
        { name: 'date', type: 'date' }, { name: 'entry_id', type: 'string' }, { name: 'memo', type: 'string' },
        { name: 'source', type: 'string', description: 'What produced the entry: manual, capital_call, bank, …' },
        { name: 'account_code', type: 'string' }, { name: 'account_name', type: 'string' },
        { name: 'account_type', type: 'string', description: 'asset, liability, equity, income, expense' },
        { name: 'debit', type: 'number' }, { name: 'credit', type: 'number' },
        { name: 'amount', type: 'number', description: 'Signed: debit positive, credit negative' },
        { name: 'lp', type: 'string', description: 'The partner a capital line belongs to' },
      ],
    },
  ],
}
