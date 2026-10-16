// Pure metadata for the LP REPORTING agent tools. NO server imports (the Settings key UI
// lists these). Handlers live in lp-tools.ts.
//
// THE THING TO UNDERSTAND BEFORE READING THESE: the fund has TWO producers of LP figures,
// with identical row shapes and different meanings.
//
//   • A SNAPSHOT (`lp_snapshots` + `lp_investments`) is a frozen, hand-imported
//     spreadsheet: what the administrator reported as of a date. Immutable by convention.
//   • The LIVE report is derived from the books on demand, as of any date, and is never
//     written down.
//
// They can disagree, and when they do that disagreement is itself the interesting fact —
// it is a reconciliation break. So no tool here quietly picks one for you: `lp_snapshot`
// reads the stored figures, `lp_live_report` derives them, and `lp_reconcile_snapshot`
// diffs the two. A single `get_lp_numbers` tool would have to choose, and would be wrong
// half the time without saying so.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const VEHICLE = { type: 'string', description: 'The vehicle (portfolio_group) — e.g. the fund or an SPV. Use list_vehicles to see them.' }
const LP = { type: 'string', description: 'LP entity id, or the investor/entity name (matched case-insensitively).' }

export const LP_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'lp_list_snapshots',
    description: 'List the stored LP snapshots — each is a frozen set of LP figures as of a date, as reported by the administrator.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lp_snapshot',
    description:
      'Pull the LP figures held in a stored snapshot: per investor and vehicle — commitment, called, paid-in, distributions, NAV, ' +
      'DPI, RVPI, TVPI, IRR. These are the STORED numbers as imported. For what the books say right now, use lp_live_report.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'string', description: 'Snapshot id or name. Omit for the most recent snapshot.' },
        lp: { type: 'string', description: 'Optional: only this investor or entity.' },
        vehicle: { type: 'string', description: 'Optional: only this vehicle.' },
      },
    },
  },
  {
    name: 'lp_live_report',
    description:
      'LP positions derived LIVE from the ledger as of a date (default today): commitment, called, paid-in, distributions, NAV, ' +
      'DPI, RVPI, TVPI, IRR per investor and vehicle. This is computed from the books, not from a stored snapshot, so it reflects ' +
      'everything posted to date. Associate/GP vehicles are exploded into their members.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        as_of: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Defaults to today.' },
        lp: { type: 'string', description: 'Optional: only this investor or entity.' },
        vehicle: { type: 'string', description: 'Optional: only this vehicle.' },
      },
    },
  },
  {
    name: 'lp_reconcile_snapshot',
    description:
      'Diff a stored snapshot against what the ledger says live, as of the snapshot date. Surfaces every LP whose figures differ, ' +
      'plus rows present in one and not the other. This is the tool for "do our books agree with what the administrator reported".',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: { snapshot: { type: 'string', description: 'Snapshot id or name. Omit for the most recent.' } },
    },
  },
  {
    name: 'lp_capital_summary',
    description:
      "Per-LP capital position in one vehicle straight from the books: commitment, called, funded, outstanding (uncalled), " +
      'unfunded receivable, and capital-account ending balance.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE }, required: ['vehicle'] },
  },
  {
    name: 'lp_statement',
    description:
      'One LP\'s capital-account statement in a vehicle: the roll-forward (beginning, contributions, distributions, fees, expenses, ' +
      'gains, carry, ending) in three columns (the period, year to date, inception to date), the commitment summary ' +
      '(commitment, capital called per column, remaining to be called, ownership, ending capital), and the period\'s transactions ' +
      'with a running balance.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: LP,
        start: { type: 'string', description: 'Optional period start (YYYY-MM-DD). Omit for since-inception.' },
        end: { type: 'string', description: 'Optional period end (YYYY-MM-DD).' },
      },
      required: ['vehicle', 'lp'],
    },
  },
  {
    name: 'lp_statement_pdf',
    description:
      'A download link to one LP\'s capital account statement as a PDF — the same document the app produces: ' +
      'the roll-forward for the period and since inception, ownership, and the contributions and distributions. ' +
      'Use when the user asks for the statement as a file, to send, or to download. The link works for an hour; ' +
      'give it to the user as a link. Call this again every time the document is asked for — never re-share a link ' +
      'from earlier in the conversation, which has likely expired. A statement is per LP entity and per vehicle.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: LP,
        period: { type: 'string', enum: ['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd'], description: 'The statement period. Default last_quarter. Or pass start and end.' },
        start: { type: 'string', description: 'Custom period start (YYYY-MM-DD).' },
        end: { type: 'string', description: 'Custom period end (YYYY-MM-DD).' },
      },
      required: ['vehicle', 'lp'],
    },
  },
  {
    name: 'lp_report_card_pdf',
    description:
      'A download link to an investor\'s LP report card as a PDF: their positions across every vehicle aggregated — ' +
      'commitment, paid-in, distributions, NAV, DPI, TVPI and IRR per vehicle and in total — on current figures. ' +
      'Use when the user asks for an investor\'s report, report card or summary as a file. The link works for an hour; ' +
      'give it to the user as a link. Call this again every time the document is asked for — never re-share a link ' +
      'from earlier in the conversation, which has likely expired.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: { investor: { type: 'string', description: 'The investor (or one of their entities), by name or id.' } },
      required: ['investor'],
    },
  },
  {
    name: 'lp_capital_calls',
    description: 'The capital calls issued in a vehicle: date, description, total, and each LP\'s share.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE }, required: ['vehicle'] },
  },
  {
    name: 'issue_capital_call',
    description:
      'Ask for a fund-wide capital call to be issued in a vehicle, split across its partners pro-rata by commitment. ' +
      'Always staged, from any connection: an admin reviews the preview (each partner\'s share, the purposes, the due date ' +
      'against the LPA notice period) and approves it in the app. Give the purposes with amounts that add up to total, and ' +
      'a dueDate only if the user stated one. Once issued, preview_call_notices and publish_call_notices put the notices in ' +
      'the partners\' portals.',
    scope: 'write',
    domain: 'lp',
    accessDomain: 'lp_capital',
    stagesAs: 'issue_capital_call',
    // The pending action's own schema (lib/pending-actions/registry.ts), with the vehicle required
    // here because a non-ledger tool must declare it; registry.test.ts keeps the two in step.
    inputSchema: {
      type: 'object',
      required: ['vehicle', 'callDate', 'total'],
      properties: {
        vehicle: VEHICLE,
        callDate: { type: 'string', description: 'YYYY-MM-DD.' },
        description: { type: 'string' },
        total: { type: 'number', description: 'Fund-wide amount to split pro-rata by commitment.' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD the capital is due. Never assumed: omit it if the user gave none.' },
        purposes: {
          type: 'array',
          description: 'What the call is for, with amounts that add up to total. Shown on each LP notice.',
          items: {
            type: 'object',
            required: ['category', 'amount'],
            properties: {
              category: { type: 'string', enum: ['investment', 'management_fee', 'fund_expense', 'other'] },
              amount: { type: 'number' },
              description: { type: 'string' },
              basis: { type: 'string', description: 'Management fee: rate, base and period, as the user stated them. Never invented.' },
              date: { type: 'string', description: 'YYYY-MM-DD the money is needed for this purpose, e.g. a closing.' },
            },
          },
        },
        noticePeriodDays: { type: 'number', description: "The LPA notice period the user stated. The vehicle's recorded term is checked as well." },
        noticePeriodBasis: { type: 'string', enum: ['calendar', 'business'] },
        statedPartners: {
          type: 'array',
          description: 'LP figures the user stated (a commitment, or a % of the fund). Checked against the register and flagged when they differ; never used for the split.',
          items: {
            type: 'object',
            required: ['lp'],
            properties: {
              lp: { type: 'string', description: 'LP entity id or name.' },
              commitment: { type: 'number' },
              sharePct: { type: 'number', description: 'Percent of the fund, 0 to 100.' },
            },
          },
        },
      },
    },
  },
  {
    name: 'preview_call_notices',
    description:
      "What publishing an issued capital call's notices would do, before anything goes out: each partner's amount and share " +
      'from the register, whether their portal already holds the notice, who can open it, a link to each notice as a DRAFT PDF, ' +
      'and what is missing or wrong (wire instructions, a due date inside the LPA notice period, partners with no portal account). ' +
      'Show the user all of it. Only if they confirm, call publish_call_notices with the previewToken.',
    scope: 'read',
    domain: 'lp',
    accessDomain: 'lp_relations',
    accessFeature: 'lp_portal',
    inputSchema: {
      type: 'object',
      required: ['vehicle', 'callId'],
      properties: {
        vehicle: VEHICLE,
        callId: { type: 'string', description: 'The issued capital call, from lp_capital_calls.' },
        lpEntityIds: { type: 'array', items: { type: 'string' }, description: 'Only these partners. Omit for every partner on the call.' },
      },
    },
  },
  {
    name: 'publish_call_notices',
    description:
      "Ask for an issued capital call's notices to be published to the partners' LP portals. Call preview_call_notices first, " +
      'show the user what it returns, and call this only after they confirm, with its previewToken. Always staged, from any ' +
      'connection. An admin approves it: from their chat with approve_action, only on their explicit yes to the staged change, ' +
      'or in the app, opening the notices and confirming twice. Approving returns published, reused and errors. A script\'s ' +
      'key cannot approve it. It emails no one.',
    scope: 'write',
    domain: 'lp',
    accessDomain: 'lp_relations',
    accessFeature: 'lp_portal',
    stagesAs: 'publish_call_notices',
    inputSchema: {
      type: 'object',
      required: ['vehicle', 'callId', 'previewToken'],
      properties: {
        vehicle: VEHICLE,
        callId: { type: 'string', description: 'The issued capital call.' },
        lpEntityIds: { type: 'array', items: { type: 'string' }, description: 'Only these partners, as previewed. Omit for every partner.' },
        previewToken: { type: 'string', description: 'The previewToken preview_call_notices returned for exactly these notices.' },
      },
    },
  },
  {
    name: 'lp_list_investors',
    description:
      'The fund\'s LPs. An investor (a person, family or institution) may hold through several legal entities; the positions are ' +
      'keyed on the entities, and this returns both levels so you can roll up correctly.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // ---- The LP register's records. Writes: staged for approval from a chat, like every other write.
  // Investors and entities need an admin, as on the Investors page; profiles and corrections need
  // write on LP capital. Each runs the web route's own function (lib/lps/records.ts).
  {
    name: 'lp_commitments',
    description:
      'The commitment history of a vehicle: every increase, decrease and transfer, with its id, date, amount and memo, and each ' +
      'partner\'s commitment as of a date. Use the ids with lp_correct_commitment.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: { type: 'string', description: 'Optional: only this LP entity.' },
        as_of: { type: 'string', description: 'Optional: commitments as of this date (YYYY-MM-DD). Default today.' },
      },
      required: ['vehicle'],
    },
  },
  {
    name: 'lp_create_investor',
    description: 'Add an investor (a person, family or institution) to the LP register. Add their legal entities with lp_create_entity. Admin only.',
    scope: 'write',
    domain: 'lp',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'lp_update_investor',
    description: 'Rename an investor, or set the investor it rolls up to (parent). Admin only.',
    scope: 'write',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        investor: { type: 'string', description: 'The investor, by name or id.' },
        name: { type: 'string', description: 'The new name.' },
        parent: { type: 'string', description: 'The parent investor by name or id, or an empty string to clear it.' },
      },
      required: ['investor'],
    },
  },
  {
    name: 'lp_create_entity',
    description: 'Add a legal entity (the subscribing vehicle: a trust, an LLC, an IRA) under an investor. Commitments are recorded against entities. Admin only.',
    scope: 'write',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        investor: { type: 'string', description: 'The investor it belongs to, by name or id.' },
        entity_name: { type: 'string' },
      },
      required: ['investor', 'entity_name'],
    },
  },
  {
    name: 'lp_update_entity',
    description: 'Rename an LP entity, or move it to another investor. Admin only.',
    scope: 'write',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        lp: LP,
        name: { type: 'string', description: 'The new entity name.' },
        investor: { type: 'string', description: 'The investor to move it to, by name or id.' },
      },
      required: ['lp'],
    },
  },
  {
    name: 'lp_update_profile',
    description:
      'Update an LP entity\'s profile (the facts subscription documents are filled from) and its investor\'s relationship contact. ' +
      'Only the fields given change.',
    scope: 'write',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        lp: LP,
        entity: {
          type: 'object',
          description: 'Entity facts: entity_type, formation_jurisdiction, address_line1, address_line2, city, region, postal_code, country, ' +
            'notice_email, signatories [{ name, title?, email? }], profile_notes, onboarding_excluded.',
        },
        contact: {
          type: 'object',
          description: 'The investor\'s relationship contact: contact_name, contact_email, contact_phone.',
        },
      },
      required: ['lp'],
    },
  },
  {
    name: 'lp_record_commitment',
    description:
      'Record a change to an LP\'s commitment in a vehicle after their admission: an increase (positive amount), a decrease ' +
      '(negative), or a transfer from another LP (from_lp, positive amount). For a new partner use add_partner. Admin only.',
    scope: 'write',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: LP,
        effective_date: { type: 'string', description: 'YYYY-MM-DD' },
        amount: { type: 'number' },
        from_lp: { type: 'string', description: 'For a transfer: the LP entity the commitment moves from.' },
        memo: { type: 'string' },
      },
      required: ['vehicle', 'lp', 'effective_date', 'amount'],
    },
  },
  {
    name: 'lp_correct_commitment',
    description:
      'Correct a recorded commitment event\'s date, amount or memo (its id from lp_commitments). Changing an amount needs a reason; ' +
      'a transfer\'s amount cannot be changed here.',
    scope: 'write',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        event_id: { type: 'string' },
        effective_date: { type: 'string', description: 'YYYY-MM-DD' },
        amount: { type: 'number' },
        memo: { type: 'string' },
        reason: { type: 'string', description: 'Why, required to change an amount. Kept in the audit trail.' },
      },
      required: ['vehicle', 'event_id'],
    },
  },
]
