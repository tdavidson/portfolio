// Pure metadata for the LP PORTAL and LP OUTREACH agent tools: who can sign in to the investor
// portal, the invites that get them there, email to LPs, the portal's two switches, and proposed
// capital calls. NO server imports (the Settings key UI lists these). Handlers live in
// lp-portal-tools.ts; the logic they share with the web routes is lib/lps/portal-access.ts,
// lib/lps/outreach.ts and lib/accounting/proposed-calls.ts.
//
// Everything that grants portal access, sends email to LPs, or changes the portal switches is
// admin-only (lib/access/admin-only.ts ADMIN_ONLY_TOOLS), as on the LP Portal page: from a chat it
// is staged and an admin approves it; from a member's API key it is refused. The reads are admin-
// only too, as their routes are (the handlers check). Every email tool has a preview that sends
// nothing, and its description tells the assistant to show it and get an explicit yes first.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const PORTAL = { domain: 'lp' as const, accessDomain: 'lp_relations' as const, accessFeature: 'lp_portal' as const }
const CAPITAL = { domain: 'lp' as const, accessDomain: 'lp_capital' as const }

const INVESTOR = { type: 'string', description: 'The LP investor: its id, or its name (matched case-insensitively). lp_list_investors lists them.' }
const ACCOUNT = { type: 'string', description: 'The portal account: its lp_account_id, or its email. lp_portal_accounts lists them.' }
const VEHICLE = { type: 'string', description: 'The vehicle (portfolio_group). Optional when the fund has one, or you see only one.' }
const PREVIEW_FIRST =
  'Call it first with preview: true, show the person the recipients and the email, and only after they explicitly say yes call it again without preview.'

const PROPOSAL_FIELDS = {
  total: { type: 'number', description: 'The amount called, in the vehicle\'s currency.' },
  purposes: {
    type: 'array',
    description: 'What the call is for. The amounts should add up to total.',
    items: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['investment', 'management_fee', 'fund_expense', 'other'] },
        amount: { type: 'number' },
        description: { type: 'string', description: 'e.g. "Series A in Acme"' },
        basis: { type: 'string', description: 'How the amount was worked out, e.g. "2% of commitments for Q3".' },
        date: { type: 'string', description: 'YYYY-MM-DD, when the purpose applies' },
      },
      required: ['category', 'amount'],
    },
  },
  notice_date: { type: 'string', description: 'YYYY-MM-DD: the date on the notice.' },
  due_date: { type: 'string', description: 'YYYY-MM-DD: when the money is due.' },
  notice_period_days: { type: 'integer', description: 'The notice period the LPA states, if the person said; the vehicle\'s stored term is checked too.' },
  notice_period_basis: { type: 'string', enum: ['calendar', 'business'] },
  description: { type: 'string', description: 'A line for the notice body. Built from the purposes when absent.' },
  stated_partners: {
    type: 'array',
    description: 'LP figures the request itself stated, checked against the register (never used for the split).',
    items: {
      type: 'object',
      properties: { lp: { type: 'string' }, commitment: { type: 'number' }, share_pct: { type: 'number' } },
      required: ['lp'],
    },
  },
}

export const LP_PORTAL_TOOL_MANIFEST: AgentToolMeta[] = [
  // ── Portal accounts and invites ──────────────────────────────────────────────────────────
  {
    name: 'lp_portal_accounts',
    description:
      'Who can sign in to the LP portal: every portal account linked to an investor in this fund, with its status ' +
      '(invited, active, disabled), when it last signed in, and when an invite was last emailed and whether it failed. ' +
      'Also whether the portal and the investor connector are switched on. Admin only.',
    scope: 'read',
    ...PORTAL,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lp_portal_invite',
    description:
      'Invite one LP to the portal: creates (or reuses) their portal account for the email, links it to the investor, and emails ' +
      'the invite from the fund\'s outbound provider. An account that is already active is linked without an email. Admin only. ' +
      PREVIEW_FIRST + ' For many LPs at once use lp_portal_invite_bulk.',
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: {
        investor: INVESTOR,
        email: { type: 'string' },
        display_name: { type: 'string' },
        preview: { type: 'boolean', description: 'Return the invite email and whether it would be sent, and change nothing.' },
      },
      required: ['investor', 'email'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_portal_invite_bulk',
    description:
      'Invite many LPs at once. Two modes. mode "missing" (the easy one): every LP investor in the fund, or in the named vehicles, ' +
      'that has a contact email on file (or one notice email across its entities) and no portal account yet; investors with no ' +
      'usable address are listed so the person can add one with lp_update_profile. mode "rows": a sheet of { name, email, ' +
      'display_name?, authorized_emails? }, matched to investors by name, creating any that do not exist, as the LP Portal page\'s ' +
      'bulk import does. Always call it first with commit: false (the default): it writes and emails nothing and returns who would ' +
      'be created, linked and emailed, and the invite email. Show the person that list and the email, and only after they ' +
      'explicitly say yes call it again with commit: true. Admin only.',
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['missing', 'rows'], description: 'Default "missing" when no rows are given.' },
        vehicles: { type: 'array', items: { type: 'string' }, description: 'mode "missing": only LPs with a position in these vehicles. Default: the whole fund.' },
        rows: {
          type: 'array',
          description: 'mode "rows": up to 2000.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The investor\'s name.' },
              email: { type: 'string' },
              display_name: { type: 'string' },
              authorized_emails: { type: 'array', items: { type: 'string' }, description: 'Advisors to invite as authorized users for this investor.' },
            },
            required: ['name', 'email'],
          },
        },
        commit: { type: 'boolean', description: 'false (default): preview only. true: create, link and email.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_portal_account_status',
    description:
      'Disable an LP\'s portal account (they and their authorized users lose the portal at their next request, and stop receiving ' +
      'LP emails) or re-enable it. Re-enabling an account that never finished signing up puts it back to invited. Admin only.',
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: { account: ACCOUNT, status: { type: 'string', enum: ['active', 'disabled'] } },
      required: ['account', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_portal_resend_invite',
    description:
      'Email the portal invite again to an account that is invited but has not signed up. Refused for an active or disabled account. ' +
      'Admin only. ' + PREVIEW_FIRST,
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: { account: ACCOUNT, preview: { type: 'boolean', description: 'Return the email that would go out, and send nothing.' } },
      required: ['account'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_portal_unlink',
    description:
      'Remove a portal account\'s link to an investor, so it no longer sees that investor. Pass link_id (the id lp_portal_accounts ' +
      'returns), or account and investor. The account itself stays. Admin only.',
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: { link_id: { type: 'string' }, account: ACCOUNT, investor: INVESTOR },
      additionalProperties: false,
    },
  },

  // ── Authorized users (advisors) ──────────────────────────────────────────────────────────
  {
    name: 'lp_authorized_users',
    description:
      'The authorized users (an LP\'s advisors, family office, accountant) who have delegated, read-only portal access to an ' +
      'investor, acting for that investor\'s LP. Optionally for one investor. Admin only.',
    scope: 'read',
    ...PORTAL,
    inputSchema: { type: 'object', properties: { investor: INVESTOR }, additionalProperties: false },
  },
  {
    name: 'lp_authorized_user_add',
    description:
      'Give someone delegated, read-only portal access to one investor and email them an invite (none if they already have an ' +
      'active portal login). The investor\'s LP must have been invited first. Admin only. ' + PREVIEW_FIRST,
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: {
        investor: INVESTOR,
        email: { type: 'string' },
        display_name: { type: 'string' },
        preview: { type: 'boolean', description: 'Return the invite email and whether it would be sent, and change nothing.' },
      },
      required: ['investor', 'email'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_authorized_user_remove',
    description: 'Revoke an authorized user\'s access to an investor. Pass the id lp_authorized_users returns. Admin only.',
    scope: 'write',
    ...PORTAL,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },

  // ── Email to LPs ─────────────────────────────────────────────────────────────────────────
  {
    name: 'lp_announce',
    description:
      'Email an announcement to chosen LPs, or all of them: a plain message with nothing attached (a close, a change of address, ' +
      'a heads-up before a call). Each investor\'s portal login is To, their authorized users Cc; it also appears in each ' +
      'investor\'s portal messages. Only LPs with a portal account can be reached. Admin only. ' + PREVIEW_FIRST +
      ' The preview returns the exact To and Cc addresses, the subject as sent, and the rendered HTML.',
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Up to 200 characters; the fund\'s name is put in front.' },
        body: { type: 'string', description: 'The message, plain text.' },
        investors: {
          description: '"all" (default) or a list of investors by id or name.',
          oneOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'string' } }],
        },
        preview: { type: 'boolean', description: 'Return the recipients and the email, and send nothing.' },
      },
      required: ['subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_send_item_recipients',
    description:
      'Who a portal item can be emailed to: the investors a snapshot, letter or uploaded document is shared with, and whether the ' +
      'portal is on (a link only works when it is). Admin only.',
    scope: 'read',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['snapshot', 'letter', 'document'] }, id: { type: 'string' } },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_send_item',
    description:
      'Email a portal item (a snapshot, a letter, or an uploaded document) to LPs it is shared with, as a secure portal link, ' +
      'as an attachment, or both. A snapshot is attached as each recipient\'s own statement PDF (only their investors), a letter ' +
      'as its PDF, a document as the uploaded file, exactly as the LP Portal page sends them. Authorized users are Cc\'d. Only ' +
      'investors the item is shared with are emailed. Admin only. ' + PREVIEW_FIRST +
      ' The preview returns the exact To and Cc addresses, the subject, the rendered HTML and the attachment\'s file name. ' +
      'A recipient whose PDF could not be rendered is not emailed (never sent without it): the result lists them in failures ' +
      'and why in attachment_errors.',
    scope: 'write',
    ...PORTAL,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['snapshot', 'letter', 'document'] },
        id: { type: 'string', description: 'The snapshot, letter or document id.' },
        investors: { type: 'array', items: { type: 'string' }, description: 'Investors by id or name. Default: everyone the item is shared with.' },
        subject: { type: 'string', description: 'Default "<fund>: <item title>".' },
        message: { type: 'string', description: 'A note above the link.' },
        delivery: { type: 'string', enum: ['link', 'attachment', 'both'], description: 'Default link. attachment: the PDF or file only (works with the portal off); both: link and attachment.' },
        preview: { type: 'boolean', description: 'Return the recipients and the email, and send nothing.' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },

  // ── The portal's switches ────────────────────────────────────────────────────────────────
  {
    name: 'lp_portal_settings',
    description:
      'Turn the LP portal on or off, and the investor connector (investors connecting their own assistant to their portal, which ' +
      'works only while the portal is on). Only the switches given change; returns both as they now stand. lp_portal_accounts ' +
      'shows them without changing anything. Admin only.',
    scope: 'write',
    domain: 'lp',
    accessDomain: 'admin',
    inputSchema: {
      type: 'object',
      properties: {
        portal_enabled: { type: 'boolean', description: 'The LP portal.' },
        investor_connector_enabled: { type: 'boolean', description: 'Investors may connect an assistant to their own portal.' },
      },
      additionalProperties: false,
    },
  },

  // ── Proposed capital calls ───────────────────────────────────────────────────────────────
  {
    name: 'lp_proposed_calls',
    description:
      'Proposed capital calls: drafts a person reviews before a call is issued. With id, one proposal re-checked against today\'s ' +
      'records (each partner\'s line, what is missing, and any warning or blocker). Without, the list, newest first.',
    scope: 'read',
    ...CAPITAL,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        id: { type: 'string' },
        status: { type: 'string', enum: ['proposed', 'approved', 'discarded'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lp_proposed_call_propose',
    description:
      'Propose a capital call for review: the total and what it is for. The split comes from the register (pro rata by commitment); ' +
      'the result shows each partner\'s line and anything missing or wrong. Nothing is issued: an admin approves it with ' +
      'lp_proposed_call_approve. Admin only.',
    scope: 'write',
    ...CAPITAL,
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, ...PROPOSAL_FIELDS },
      required: ['total'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_proposed_call_revise',
    description: 'Change an open proposed capital call. Only the fields given change; the checks run again. Admin only.',
    scope: 'write',
    ...CAPITAL,
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, id: { type: 'string' }, ...PROPOSAL_FIELDS },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_proposed_call_discard',
    description: 'Discard an open proposed capital call. Admin only.',
    scope: 'write',
    ...CAPITAL,
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lp_proposed_call_approve',
    description:
      'Approve a proposed capital call: re-checks it against today\'s records and issues the call (each partner\'s line, advances ' +
      'applied). Show the person lp_proposed_calls with the id first and get an explicit yes. If it has warnings, approving needs ' +
      'acknowledge: true, after the person has accepted them. Then, as the app\'s Approve button does, it publishes each LP\'s ' +
      'notice to their portal (no email) and returns noticesPublished, noticesReused and publishErrors. If publishing fails ' +
      'after the call is issued, the result says so (publishFailed) with the capitalCallId: the call stands, and calling this ' +
      'again with the same id retries the notices without issuing it twice. Admin only.',
    scope: 'write',
    ...CAPITAL,
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, id: { type: 'string' }, acknowledge: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]
