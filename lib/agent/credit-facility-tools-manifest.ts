// Pure metadata for the CREDIT FACILITY tools: a vehicle's subscription line or other borrowing, and
// the ILPA performance data that reads it. NO server imports (the Settings key UI lists these).
// Handlers live in credit-facility-tools.ts.
//
// All of them are on ONE vehicle's books, so they bind as ledger tools: the dispatcher resolves the
// vehicle with the caller's access and injects it.
//
//   credit_facilities        → each facility, its balance, what is left and every row; writes nothing
//   ilpa_performance         → the ILPA Performance Template data through a date; writes nothing
//   set_credit_facility      → add or change a facility, always staged
//   record_facility_event    → a draw, repayment, interest payment or fee, always staged
//   remove_facility_event    → take a row off the register, always staged
//
// The mechanics are in lib/accounting/credit-facility.ts and lib/lp-templates/performance-load.ts.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

export const CREDIT_FACILITY_PROPERTIES = {
  id: { type: 'string', description: 'The facility to change (credit_facilities lists them). Leave out to add a new one.' },
  name: { type: 'string', description: 'What the fund calls it, for example "Subscription line".' },
  kind: {
    type: 'string', enum: ['subscription', 'nav', 'other'],
    description: 'subscription = secured by the partners\' uncalled commitments (the only kind the ILPA "without facility" returns adjust for). nav = secured by the portfolio. Default subscription.',
  },
  lender: { type: 'string', description: 'The lender.' },
  commitmentAmount: { type: 'number', exclusiveMinimum: 0, description: 'The facility size. Draws beyond it are refused.' },
  openedOn: { type: 'string', description: 'YYYY-MM-DD.' },
  maturesOn: { type: 'string', description: 'YYYY-MM-DD.' },
  rateDescription: { type: 'string', description: 'The rate in words, for example "SOFR + 2.25%, 0.25% unused fee".' },
  notes: { type: 'string' },
  explanation: { type: 'string', description: 'Why, for the approver: the credit agreement, with its section.' },
} as const

export const FACILITY_EVENT_PROPERTIES = {
  facilityId: { type: 'string', description: 'The facility (credit_facilities lists them). May be left out when the vehicle has only one.' },
  type: { type: 'string', enum: ['draw', 'repayment', 'interest', 'fee'] },
  date: { type: 'string', description: 'YYYY-MM-DD.' },
  amount: { type: 'number', exclusiveMinimum: 0 },
  purpose: {
    type: 'string', enum: ['investment', 'management_fee', 'fund_expense', 'working_capital'],
    description: 'What a draw paid for. Draws only; default investment. A repayment takes the purposes of the draws it retires, oldest first.',
  },
  callId: { type: 'string', description: 'The capital call whose proceeds paid this repayment, interest or fee (lp_capital_calls lists them). Linking interest to its call is what keeps it out of the ILPA "without facility" returns.' },
  entryId: { type: 'string', description: 'An entry already on the books for this movement (from the bank feed or by hand). The row links it instead of posting a second one; the entry must move the loan or interest account by the amount, on the date.' },
  memo: { type: 'string' },
  explanation: { type: 'string', description: 'Why, for the approver.' },
} as const

export const CREDIT_FACILITY_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'credit_facilities',
    description:
      "A vehicle's credit facilities (subscription lines and other borrowing): each one's kind, lender, size and dates, " +
      'what is drawn, repaid and outstanding, interest and fees paid, what is left to draw, and every draw, repayment, ' +
      'interest payment and fee with its purpose, the call that paid it and its entry. Writes nothing.',
    scope: 'read',
    accessDomain: 'lp_capital',
    inputSchema: { type: 'object', properties: { asOf: { type: 'string', description: 'YYYY-MM-DD. Default today.' } } },
  },
  {
    name: 'ilpa_performance',
    description:
      "A vehicle's returns as the ILPA Performance Template (Granular Methodology, v. 1.1) states them, through a date: " +
      'net and gross IRR and multiple, with and without the subscription facility; gross IRR and MOIC of the realized, ' +
      'unrealized and total portfolio; and every cash flow of the fee-paying limited partners typed by ILPA transaction ' +
      'type, with notes on what was assumed. Writes nothing. The same data downloads as a spreadsheet from the fund ' +
      "performance page. Its net returns are the fee-paying partners' only: an investor letter's net figures are the " +
      "administrator's, recorded with record_fund_figures; its gross portfolio IRR and MOIC are the letter brief's gross figures.",
    scope: 'read',
    accessDomain: 'accounting',
    inputSchema: { type: 'object', properties: { asOf: { type: 'string', description: 'YYYY-MM-DD. Default: the last quarter end.' } } },
  },
  {
    name: 'set_credit_facility',
    description:
      'Ask for a credit facility to be added to a vehicle, or an existing one changed: its name, kind (subscription, nav, ' +
      'other), lender, size, dates and rate. Always staged: a person with LP capital write approves it. Nothing is posted.',
    scope: 'write',
    accessDomain: 'lp_capital',
    stagesAs: 'set_credit_facility',
    inputSchema: { type: 'object', required: ['name'], additionalProperties: false, properties: { ...CREDIT_FACILITY_PROPERTIES } },
  },
  {
    name: 'record_facility_event',
    description:
      'Ask for a draw, repayment, interest payment or fee on a credit facility to be recorded. It posts the entry (a draw ' +
      'is Dr cash / Cr loan payable, a repayment the reverse, interest and fees Dr interest expense / Cr cash, allocated ' +
      'to the partners), or links an entry already on the books (entryId) instead. Always staged: the approver sees the ' +
      'balance before and after.',
    scope: 'write',
    accessDomain: 'lp_capital',
    stagesAs: 'record_facility_event',
    inputSchema: { type: 'object', required: ['type', 'date', 'amount'], additionalProperties: false, properties: { ...FACILITY_EVENT_PROPERTIES } },
  },
  {
    name: 'remove_facility_event',
    description:
      'Ask for a row to be taken off a credit facility register (credit_facilities lists their ids). A row that posted ' +
      'its own entry needs that entry voided first, with a reason; a linked row comes off and its entry stays. Always staged.',
    scope: 'write',
    accessDomain: 'lp_capital',
    stagesAs: 'remove_facility_event',
    inputSchema: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string', description: 'The row (credit_facilities lists them).' }, explanation: { type: 'string' } },
    },
  },
]
