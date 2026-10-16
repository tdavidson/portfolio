import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

// Destructive admin changes from chat and the API: deletes, merges, and undoing posted books.
//
// Each wraps the function its web route calls (lib/agent/destructive-tools.ts), carries
// `destructive: true` and is admin-only (lib/access/admin-only.ts). They are offered only when the
// deployment sets AGENT_DESTRUCTIVE_ACTIONS=true, and then every call is STAGED for an admin's
// approval, whatever the credential (lib/agent/destructive.ts). The staged preview says what the
// change would remove (lib/agent/destructive-tools.ts, DESTRUCTIVE_PREVIEWS).
//
// Reopening a closed period is NOT here: it is an ordinary admin-only ledger tool
// (lib/accounting/agent-tools-manifest.ts), always offered and staged for an admin from chat. Its
// staged preview still lives in DESTRUCTIVE_PREVIEWS (lib/agent/destructive-tools.ts).
//
// Deliberately absent: deleting all fund data (irreversible, one click in Settings with a typed
// confirmation), LP closings and the LP-snapshot cutover.

/** The sentence every description ends with. */
const STAGED =
  ' DESTRUCTIVE: always staged as a pending action, from any connection or key, and applied only when an admin approves it ' +
  '(in the app under Approvals, or from an admin\'s own chat with approve_action on their explicit yes). ' +
  'Show the person the staged preview, which says what would be removed, before they decide.'

const REASON = { type: 'string', description: 'Why, in a sentence. Recorded in the audit trail with who approved it.' }

/** Tools on ONE entity's books: the registry injects `vehicle` (bindLedger). */
export const DESTRUCTIVE_LEDGER_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'unpost_entry',
    description:
      'Unpost a posted journal entry back to draft, so it can be edited and posted again. A reason is required. Refused in a closed ' +
      'period (reopen it first) and for either half of a live investment reversal pair. If the entry recorded investment ' +
      'transactions, those transactions are deleted (and re-created only when the draft is posted again); that part cannot be undone. ' +
      'Find the entry id with list_journal.' + STAGED,
    scope: 'write',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['entry_id', 'reason'],
      properties: {
        entry_id: { type: 'string', description: 'The posted journal entry id.' },
        reason: REASON,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reverse_entry',
    description:
      'Reverse a posted journal entry with a dated contra-entry: the original stays posted and a new entry with every line flipped is ' +
      'written on reverse_date. Use it for an entry in a closed period. A reason is required; the reversal date must be on or after the ' +
      'original and in an open period. Lands as a draft unless post is true. Posting it deletes the investment transactions the ' +
      'original recorded; that cannot be undone, and an entry can be reversed only once.' + STAGED,
    scope: 'write',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['entry_id', 'reverse_date', 'reason'],
      properties: {
        entry_id: { type: 'string', description: 'The posted journal entry id.' },
        reverse_date: { type: 'string', description: 'YYYY-MM-DD, on or after the original, in an open period.' },
        post: { type: 'boolean', description: 'Post the reversal at once. Default false: it lands as a draft to post with post_drafts.' },
        reason: REASON,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'void_entry',
    description:
      'Void a posted journal entry: it stays in the journal marked void and stops counting in every balance, and a bank row pointing ' +
      'at it is set to ignored. A reason is required. Refused in a closed period (use reverse_entry there). The investment ' +
      'transactions the entry recorded are deleted, and a void entry cannot be posted again: that cannot be undone. ' +
      'A draft is refused, alone or in a run: discard drafts with discard_drafts, which needs no admin.' + STAGED,
    scope: 'write',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['entry_id', 'reason'],
      properties: {
        entry_id: { type: 'string', description: 'The posted journal entry id.' },
        reason: REASON,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_lp_positions',
    description:
      'Delete a whole dated set of LP positions (one as-of column) from a capital-tracking vehicle: every LP\'s commitment, called ' +
      'capital, distributions and NAV on that date. The positions are the vehicle\'s capital record, so this cannot be undone; the ' +
      'set has to be imported or typed again.' + STAGED,
    scope: 'write',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['as_of_date'],
      properties: {
        as_of_date: { type: 'string', description: 'YYYY-MM-DD: the as-of date of the set to delete.' },
      },
      additionalProperties: false,
    },
  },
]

/** Fund-scoped tools: each names what it changes and resolves it itself. */
export const DESTRUCTIVE_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'delete_company',
    description:
      'Delete a portfolio company (or digital asset) for every entity, with its documents, notes, metrics and updates. Refused while ' +
      'it has investment transactions (delete them with delete_investment first) or its accounts carry ledger postings. Cannot be ' +
      'undone: the company and everything filed under it are gone, and its uploaded files are removed from storage.' + STAGED,
    scope: 'write',
    domain: 'portfolio',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: { company: { type: 'string', description: 'Company name or id.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_delete_investor',
    description:
      'Delete an LP investor from the register. Its legal entities, shared reports and letters, and LP documents go with it as the ' +
      'database decides; the preview lists the entities and whether any has ledger activity. Cannot be undone. To combine two ' +
      'records of the same investor, use lp_merge_investors instead.' + STAGED,
    scope: 'write',
    domain: 'lp',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['investor'],
      properties: { investor: { type: 'string', description: 'Investor name or id.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_delete_entity',
    description:
      'Delete an LP legal entity. Refused while it has ledger activity (capital postings or capital-call lines): reverse or reassign ' +
      'those first. Cannot be undone; re-adding it makes a new entity with a new id.' + STAGED,
    scope: 'write',
    domain: 'lp',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['lp'],
      properties: { lp: { type: 'string', description: 'LP entity name or id.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_delete_commitment',
    description:
      'Delete a wrongly entered commitment event. A transfer deletes BOTH legs, so the fund\'s total commitment cannot drift. A reason ' +
      'is required, and the deleted event is kept whole in the audit trail. For a wrong date, amount or memo, use lp_correct_commitment ' +
      'instead. Cannot be undone except by recording the event again. Find event ids with lp_commitments.' + STAGED,
    scope: 'write',
    domain: 'lp',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['event_id', 'reason'],
      properties: {
        vehicle: { type: 'string', description: 'The vehicle (optional when the fund has one).' },
        event_id: { type: 'string', description: 'The commitment event id from lp_commitments.' },
        reason: REASON,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_merge_investors',
    description:
      'Merge one LP investor into another: every legal entity of `from` moves to `into`, then `from` is deleted. Cannot be undone: the ' +
      'entities would have to be moved back one by one and the deleted investor re-created.' + STAGED,
    scope: 'write',
    domain: 'lp',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['from', 'into'],
      properties: {
        from: { type: 'string', description: 'The investor to merge away (name or id). It is deleted.' },
        into: { type: 'string', description: 'The investor that keeps its record and receives the entities (name or id).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'diligence_delete_deal',
    description:
      'Delete a diligence deal room with everything in it: data-room documents, memo drafts, notes, checklist, attention items, Q&A ' +
      'and agent sessions. Cannot be undone; the preview counts what would go. To close a deal without deleting it, set its status ' +
      'with diligence_update_deal.' + STAGED,
    scope: 'write',
    domain: 'diligence',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['deal'],
      properties: { deal: { type: 'string', description: 'Deal name, alias or id.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'remove_member',
    description:
      'Remove a team member from the fund: their membership and every entity grant. Not yourself, and not an admin. Their access ends ' +
      'at once; this cannot be undone, and re-adding them is a new invitation that starts with no grants.' + STAGED,
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'admin',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['member'],
      properties: { member: { type: 'string', description: 'The member\'s email address, or their membership or user id.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'merge_vehicles',
    description:
      'Merge one vehicle (entity) into another, e.g. a backfilled duplicate "Acme SPV" into "Acme SPV LP": its LP, portfolio and ' +
      'compliance rows (keyed by name), notes, deals, staged actions and members\' grants move to `into`, `from` is deleted, and its ' +
      'name becomes an alias of `into`. Its OWN BOOKS DO NOT MOVE: journal entries, chart of accounts, periods and bank rows keyed ' +
      'to `from` are deleted with it, so merge only a duplicate whose books are empty (the preview counts them). Cannot be undone: ' +
      'there is no un-merge.' + STAGED,
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    destructive: true,
    inputSchema: {
      type: 'object',
      required: ['from', 'into'],
      properties: {
        from: { type: 'string', description: 'The vehicle to merge away (name or id). It is deleted.' },
        into: { type: 'string', description: 'The vehicle that keeps its name and receives everything (name or id).' },
      },
      additionalProperties: false,
    },
  },
]
