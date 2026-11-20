// Pure metadata for the ALLOCATION TERMS tools: how a vehicle divides each kind of allocation among
// its partners. NO server imports (the Settings key UI lists these). Handlers live in
// allocation-terms-tools.ts.
//
// Ledger tools, gated like the route (accounting). Carried-interest terms are GP economics: the
// handlers read and write them only for a caller who holds gp_economics, as the route's GET does.
//
//   allocation_terms     → api/accounting/allocation-terms (GET)
//   set_allocation_terms → api/accounting/allocation-terms (POST action=term / action=basis);
//                          staged for assistant credentials

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

export const ALLOCATION_CATEGORIES = [
  'management_fee', 'partnership_expense', 'organizational_expense', 'realized_gain', 'valuation', 'income', 'carried_interest',
] as const

export const ALLOCATION_TERMS_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'allocation_terms',
    description:
      "A vehicle's allocation terms: its allocation basis (commitment or capital balance) and, for each partner, their " +
      'commitment and their terms per category (whether they take part, a weight override, a rate override). In an ' +
      "associate or GP entity, the carried_interest weights are the members' carry points, which the look-through and " +
      'the close split carry by, while capital follows ownership. Carried-interest terms need GP economics read.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...ALLOCATION_CATEGORIES], description: 'Only this category. Omit for all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_allocation_terms',
    description:
      "Set partners' allocation terms in one category, all or none (an unknown partner refuses the whole call), and/or " +
      "the vehicle's allocation basis. For an associate's carry points: category carried_interest, one term per member " +
      'with participates true and weight = their points (points are normalized, so they need not total 100; a member ' +
      'with no term holds no carry once anyone has points). Partners must already be partners of the vehicle ' +
      '(add_partner first). Only the partners named change. Carried-interest terms need GP economics write. Staged for ' +
      'approval from the assistant.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...ALLOCATION_CATEGORIES], description: 'The category the terms are for.' },
        terms: {
          type: 'array',
          description: 'One per partner.',
          items: {
            type: 'object',
            required: ['partner'],
            properties: {
              partner: { type: 'string', description: 'Partner name or id (allocation_terms lists them).' },
              participates: { type: 'boolean', description: 'Default true.' },
              weight: { type: ['number', 'null'], description: 'Weight override (carry points for carried_interest). Null clears it.' },
              rate: { type: ['number', 'null'], description: 'Rate override as a fraction (0.02 = 2%). Null clears it.' },
              memo: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        basis: { type: 'string', enum: ['commitment', 'capital_balance'], description: "The vehicle's allocation basis." },
      },
      additionalProperties: false,
    },
  },
]
