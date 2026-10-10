// What each fund-level feature switch is called and does.
//
// Lives here, not in the settings page, because TWO surfaces need it: the Feature visibility
// cards, and the access grid — which lists the switches feeding each domain column so the two
// vocabularies on that page have a bridge. Deliberately NOT in lib/types/features.ts: that one is
// imported by the edge middleware, and UI copy has no business in the edge bundle.

import type { FeatureKey } from '@/lib/types/features'

export const FEATURE_META: Record<FeatureKey, { label: string; description: string; href: string }> = {
  interactions: { label: 'Interactions', description: 'Track emails, intros, and meetings with portfolio companies', href: '/support#interactions' },
  investments: { label: 'Investments', description: 'Fund investments, ownership, and round details per company', href: '/support#investments' },
  notes: { label: 'Notes', description: 'Internal team notes and comments on companies', href: '/support#notes' },
  lp_letters: { label: 'LP Letters', description: 'Generate and manage quarterly LP update letters', href: '/support#lp-letters' },
  imports: { label: 'Imports', description: 'Bulk import companies and metrics from CSV files', href: '/support#import' },
  asks: { label: 'Asks', description: 'Track and send portfolio company requests to your network', href: '/support#asks' },
  lps: { label: 'LPs', description: 'Investor-level report cards with consolidated performance across fund vehicles', href: '/support#lps' },
  lp_tracking: { label: 'LP Capital Accounts', description: 'Per-vehicle limited-partner capital detail, separate from funds capital accounts if used.', href: '/support#lps' },
  lp_portal: { label: 'LP Documents and Sharing', description: 'The LPs Documents page and the Share with LPs controls on LP letters. Requires LP Portal.', href: '/support#lps' },
  lp_activity: { label: 'LP Activity Log', description: 'The LPs Activity page, showung which LPs and authorized users logged in, viewed, or downloaded. Requires LP portal.', href: '/support#lps' },
  compliance: { label: 'Compliance', description: 'Track regulatory deadlines, filings, and compliance workflows', href: '/support#compliance' },
  deals: { label: 'Deals', description: 'Inbound deal pitches screened against your fund thesis', href: '/support#deals' },
  diligence: { label: 'Diligence', description: 'Pre-investment record-keeping and AI-assisted memo drafting', href: '/support#diligence' },
  accounting: { label: 'Accounting', description: 'Shows the double-entry books — journal, bank, capital accounts, schedule of investments, statements and the close. Every entity keeps its books whether or not this is on: investments and capital calls post as they are recorded.', href: '/support#accounting' },
  gp_economics: { label: 'GP economics', description: 'Carry terms, carry accrued and paid per partner, per-deal carry, and GP entity ownership. Split out of Accounting so someone can reconcile the bank without seeing the partners’ carry.', href: '/support#accounting' },
  management_company: { label: 'Management company', description: 'The firm\u2019s own operating books \u2014 cash, payroll and compensation, the quarterly management-fee cycle, and intercompany balances with the funds it manages. Its own access grant, because a manco ledger carries salaries that appear nowhere in a fund\u2019s books.', href: '/support#management-company' },
  budgeting: { label: 'Forecast', description: 'Monthly budgets, rolling forecasts and actual-versus-plan variance per vehicle, built from the posted ledger. Forecasts never post to the books. Needs Accounting on.', href: '/support#accounting' },
  tax_reporting: { label: 'Tax reporting', description: 'Schedule K-1 packages per vehicle and tax year, the partner allocation behind them, and delivery to the LP portal. Derived from the capital accounts, so it needs Accounting on.', href: '/support#accounting' },
}
