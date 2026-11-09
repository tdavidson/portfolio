// Pure metadata for the HOLDING agent tools: a holding's name and kind, moving a transaction to the
// right holding, and a fund holding's register (terms, capital notices, NAV statements). NO server
// imports. Handlers live in holding-tools.ts; merging two holdings is a destructive tool
// (destructive-tools-manifest.ts merge_companies).
//
// Fund-scoped like the portfolio tools: `vehicle` names the entity a register row belongs to and is
// resolved in the handler, never injected.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const COMPANY = { type: 'string', description: 'Company id, or the company name (matched case-insensitively).' }
const HOLDING = { type: 'string', description: 'The fund holding\'s id or name.' }
const VEHICLE = {
  type: 'string',
  description: 'The entity that holds the fund (its name). Optional when the holding\'s register or ledger already names exactly one.',
}
const DATE = { type: 'string', description: 'YYYY-MM-DD' }

const LIST = (what: string) => ({ type: 'array', items: { type: 'string' }, description: what })

/**
 * update_company's input, shared with the chat's staged `update_company` action
 * (lib/pending-actions/registry.ts) so the two take the same fields.
 */
export const UPDATE_COMPANY_PROPERTIES: Record<string, unknown> = {
  company: COMPANY,
  name: { type: 'string', description: 'The new name.' },
  status: { type: 'string', enum: ['active', 'exited', 'written-off'] },
  contact_emails: LIST('Replace every contact email with these. Contact emails are the addresses its updates come from, so emailed updates match it.'),
  add_contact_emails: LIST('Add these contact emails, keeping the existing ones.'),
  remove_contact_emails: LIST('Remove these contact emails.'),
  aliases: LIST('Replace every alias with these.'),
  add_aliases: LIST('Add these aliases, keeping the existing ones.'),
  remove_aliases: LIST('Remove these aliases.'),
  vehicles: LIST('Replace the entities that hold it with these (by name; each must already exist). Entities you cannot see are kept.'),
  add_vehicles: LIST('Add these entities as holders.'),
  remove_vehicles: LIST('Remove these entities as holders.'),
  tags: LIST('Replace every tag with these.'),
  add_tags: LIST('Add these tags.'),
  remove_tags: LIST('Remove these tags.'),
  industry: LIST('Replace its industries with these.'),
  add_industry: LIST('Add these industries.'),
  remove_industry: LIST('Remove these industries.'),
  stage: { type: 'string', description: 'E.g. "Seed", "Series A". Empty clears it.' },
  country: { type: 'string', description: 'Where it is based; the Schedule of Investments groups by it. Empty clears it.' },
  founded_year: { type: 'integer' },
  overview: { type: 'string', description: 'What the company does. Empty clears it.' },
  founders: { type: 'string', description: 'Empty clears it.' },
  why_invested: { type: 'string', description: 'Empty clears it.' },
  current_update: { type: 'string', description: 'The latest news on the company. Empty clears it.' },
  notes: { type: 'string', description: 'The free-text notes field on the record (not a team note: add_company_note). Empty clears it.' },
}

export const UPDATE_COMPANY_DESCRIPTION =
  'Change a holding\'s record (company, fund holding or digital asset): its name, status, contact emails, aliases, tags, ' +
  'industry, stage, country, founded year, overview, founders, why invested, current update, notes and the entities that ' +
  'hold it. Only the fields ' +
  'passed change. For a list, `<list>` replaces it and `add_<list>` / `remove_<list>` change the one there. A rename also ' +
  'renames the holding\'s own chart accounts that still carry the old name ("Investment — <name>" and the rest). Aliases ' +
  'and contact emails are what imports and emailed updates match it by. Changing the entities that hold it does not move ' +
  'its transactions (move_investment does).'

export const HOLDING_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'update_company',
    description: UPDATE_COMPANY_DESCRIPTION,
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: UPDATE_COMPANY_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: 'set_holding_type',
    description:
      'Change what kind of holding a record is: company or fund (a fund the entity invests in as an LP, with a register of terms, ' +
      'capital notices and NAV statements). Its transactions and ledger accounts are unchanged. A fund holding with notices or NAV ' +
      'statements cannot become a company until those are changed and the register cleared (clear_fund_register). Digital assets ' +
      'are changed on the company page.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      required: ['company', 'holding_type'],
      properties: {
        company: COMPANY,
        holding_type: { type: 'string', enum: ['company', 'fund'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'move_investment',
    description:
      'Move a recorded portfolio transaction to another holding: a payment booked against the wrong company or fund. Its journal ' +
      'entry is retracted and re-derived on the other holding\'s accounts, so cash and every other account stay as they were. ' +
      'Refused for a transaction in a closed period, one the fund register owns (move the notice instead), and either end of a ' +
      'SAFE/note conversion. To combine two records of the same holding, use merge_companies.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'transaction_id', 'to_company'],
      properties: {
        company: { type: 'string', description: 'The holding the transaction is on now (id or name).' },
        transaction_id: { type: 'string', description: 'The transaction id, from list_investments.' },
        to_company: { type: 'string', description: 'The holding it belongs to (id or name).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'transfer_cost',
    description:
      'Move cost basis from one holding to another inside one entity, with no cash and no gain: a note rolled into another ' +
      'holding, cost reallocated between two records, an in-kind exchange at cost. Posts ONE journal entry, Dr Investment — ' +
      'target / Cr Investment — source, recorded as a cost transfer: the source\'s invested capital and cost go down with ' +
      'nothing realized (no proceeds, no gain, MOIC and IRR unaffected by it), and the target\'s cost starts on the date. ' +
      'Refused when the source carries less cost than the amount on that date, or the period is closed. A sale for cash is ' +
      'record_investment (proceeds); an entry already booked this way but showing proceeds is convert_to_cost_transfer.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'to_company', 'amount', 'date', 'vehicle'],
      properties: {
        company: { type: 'string', description: 'The holding the cost leaves (id or name).' },
        to_company: { type: 'string', description: 'The holding the cost moves to (id or name).' },
        amount: { type: 'number', description: 'The cost moved, in the fund\'s currency. Positive.' },
        date: DATE,
        vehicle: { type: 'string', description: 'The entity that holds both (its name).' },
        memo: { type: 'string', description: 'Optional memo for the journal entry.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'convert_to_cost_transfer',
    description:
      'Fix a cost transfer that was read as an exit plus a purchase. Given a posted journal entry whose only lines are a credit ' +
      'to one holding\'s investment account and an equal debit to another\'s (no cash, no gain), replace the proceeds row on ' +
      'the source and the investment row on the target that were adopted from it with one cost transfer. The journal entry ' +
      'and the trial balance are not changed; the source stops reporting proceeds. Refused for any other shape (a real exit ' +
      'stays proceeds), an entry already converted, a closed period, or rows the fund register or a conversion points at. ' +
      'dry_run: true describes the change without making it.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['entry_id'],
      properties: {
        entry_id: { type: 'string', description: 'The journal entry id (list_journal or query_ledger give it).' },
        vehicle: { type: 'string', description: 'The entry\'s entity (its name). Optional; needed only by a member scoped to some entities.' },
        dry_run: { type: 'boolean', description: 'Describe the change without making it.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_fund_terms',
    description:
      'Set a fund holding\'s terms on one entity: the commitment (which unfunded is derived from), and optionally the commitment ' +
      'date, manager, vintage, fund size, strategy, geography, final close and term end. Creates the terms when there are none. ' +
      'Only the fields passed change.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        commitment: { type: 'number', description: 'The entity\'s commitment to the fund.' },
        commitment_date: DATE,
        manager_name: { type: 'string' },
        vintage_year: { type: 'integer' },
        fund_size: { type: 'number' },
        strategy: { type: 'string' },
        geography: { type: 'string' },
        final_close_date: DATE,
        term_end_date: DATE,
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_fund_notice',
    description:
      'Record a capital call or distribution notice a fund holding sent this entity. Pass transaction_id to LINK it to the ' +
      'investment (call) or proceeds (distribution) transaction already on the books for that payment: nothing is booked again, and ' +
      'the transaction must be this holding\'s, on this entity, for the same amount. Without transaction_id the notice is BOOKED: its ' +
      'transaction and journal entry are made, as Confirm on the holding page does. A call\'s purposes (investments, fees, expenses) ' +
      'and a distribution\'s character (return of capital, realized gain, income) must add up to the amount; a call defaults to all ' +
      'investments. A distribution with no return of capital or gain stated is split by cost recovery against the cost the holding ' +
      'still carries (a linked transaction booked otherwise is re-booked to match, its next mark keeping the holding\'s value). ' +
      'Once recorded, the transaction is changed from the notice (update_fund_notice), not the company page.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'kind', 'event_date', 'amount'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        kind: { type: 'string', enum: ['call', 'distribution'] },
        event_date: { type: 'string', description: 'The notice\'s date (YYYY-MM-DD); for a linked notice, usually the payment\'s date.' },
        amount: { type: 'number', description: 'The notice amount, positive for both kinds.' },
        transaction_id: { type: 'string', description: 'The transaction already on the books for this payment (list_investments).' },
        due_date: DATE,
        notice_number: { type: 'string' },
        description: { type: 'string' },
        purpose_investments: { type: 'number' },
        purpose_fees: { type: 'number' },
        purpose_expenses: { type: 'number' },
        char_return_of_capital: { type: 'number' },
        char_realized_gain: { type: 'number' },
        char_income: { type: 'number' },
        recallable_amount: { type: 'number', description: 'The part of a distribution the fund may call again.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_fund_notice',
    description:
      'Correct a capital call or distribution notice already in a fund holding\'s register (the notice ids are in the register; ' +
      'list_investments shows the transaction a notice owns). Change its date, amount, a call\'s purposes or a distribution\'s ' +
      'character (return of capital, realized gain, income), and its number, description, due date or recallable amount. Only ' +
      'the fields passed change, and a call\'s purposes or a distribution\'s character must still add up to the amount. A ' +
      'confirmed notice re-books the transaction it owns, retracting and re-drafting its journal entry, and re-books the ' +
      'holding\'s NAV statements from that date so its value stays at the manager\'s NAV. This is how a register-owned ' +
      'transaction is corrected; update_investment refuses one. Refused when the entry is in a closed period.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: HOLDING,
        event_id: { type: 'string', description: 'The notice\'s id. Give this or transaction_id.' },
        transaction_id: { type: 'string', description: 'The transaction the notice owns (list_investments), to find the notice by.' },
        event_date: DATE,
        amount: { type: 'number', description: 'The notice amount, positive for both kinds.' },
        due_date: DATE,
        notice_number: { type: 'string' },
        description: { type: 'string' },
        purpose_investments: { type: 'number' },
        purpose_fees: { type: 'number' },
        purpose_expenses: { type: 'number' },
        char_return_of_capital: { type: 'number' },
        char_realized_gain: { type: 'number' },
        char_income: { type: 'number' },
        recallable_amount: { type: 'number', description: 'The part of a distribution the fund may call again.' },
        recalculate_character: {
          type: 'boolean',
          description: 'Work a distribution\'s return of capital and gain out again by cost recovery. They are anyway when its amount or date changes and no character is passed.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'recalculate_fund_distributions',
    description:
      'Work out again the return of capital on every distribution a fund holding paid one entity, by cost recovery: a ' +
      'distribution returns capital until the cost the holding still carries is gone, and the rest is realized gain; income a ' +
      'notice states stays income. Oldest first, each against the corrected ones before it. Every distribution that differs is ' +
      're-booked (a register notice re-books its transaction; any other proceeds transaction is edited), and the next mark is ' +
      'adjusted by the same amount so the holding keeps its value. dry_run lists what would change without changing it.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        dry_run: { type: 'boolean', description: 'List what would change; change nothing.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_nav_statement',
    description:
      'Record a manager NAV statement for a fund holding: its NAV as of a date, as the holding page\'s Manager NAV statements do. ' +
      'Saving books a mark for the difference between the NAV and what the ledger carries on that date (none when they already ' +
      'agree), and a statement for the same holding, entity and date replaces the earlier one. The result says what was booked.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      required: ['company', 'as_of_date', 'reported_nav'],
      properties: {
        company: HOLDING,
        vehicle: VEHICLE,
        as_of_date: { type: 'string', description: 'The manager\'s valuation date (YYYY-MM-DD), not when it arrived.' },
        reported_nav: { type: 'number', description: 'This entity\'s NAV in the fund on that date.' },
        basis: { type: 'string', enum: ['final', 'preliminary', 'estimate'] },
        received_date: DATE,
        reported_contributions: { type: 'number', description: 'The manager\'s since-inception contributions, for tying out.' },
        reported_distributions: { type: 'number', description: 'The manager\'s since-inception distributions, for tying out.' },
        reported_unfunded: { type: 'number', description: 'The manager\'s unfunded commitment, for tying out.' },
      },
      additionalProperties: false,
    },
  },
]
