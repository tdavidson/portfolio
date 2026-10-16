// The tier above write: operations only an admin may perform, on every surface.
//
// A write grant lets a member work in an area: post entries, record investments, edit a plan. Some
// changes are a different kind of thing. They delete what other work hangs on, undo the books,
// move money, tell LPs something, or change the fund's structure, and the firm wants one of a few
// named people behind each. Before this, anyone with Fund accounting write could void posted
// entries, reopen closed periods, issue capital calls, declare distributions and finalize K-1s.
//
// One list, read by three gates, so the web, the API and MCP cannot disagree:
//   * the middleware (proxy.ts) for /api routes, by route key, method and, where the route
//     multiplexes several operations on one method, the request body's `action`;
//   * the agent dispatcher (lib/agent/dispatch.ts) for tool calls. A non-admin with write may
//     still PROPOSE one from chat: it is staged, and only an admin can approve it;
//   * the pending-actions service, which refuses a non-admin approver for these.
//
// A rule that needs the database to decide (voiding a POSTED entry, where voiding a draft is just
// discarding it) is checked in its handler with `adminOnlyDenial`, and listed in HANDLER_CHECKED so
// the test can see it is not forgotten.

import type { FundRole } from './effective'

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface AdminOnlyRule {
  route: string
  method: Method
  /** For a route that multiplexes on its body: true when THIS request is the admin-only one. */
  when?: (body: any) => boolean
  /** What is being done, in the words the refusal uses. */
  label: string
}

const action = (...names: string[]) => (body: any) => names.includes(String(body?.action ?? ''))

export const ADMIN_ONLY_ROUTES: AdminOnlyRule[] = [
  // ── Delete what other records hang on ──────────────────────────────────────
  { route: 'api/companies/[id]', method: 'DELETE', label: 'delete a company' },
  { route: 'api/lps/investors', method: 'DELETE', label: 'delete an LP investor' },
  { route: 'api/lps/entities', method: 'DELETE', label: 'delete an LP entity' },
  { route: 'api/lps/investments', method: 'DELETE', label: 'delete an LP investment' },
  { route: 'api/accounting/commitments', method: 'DELETE', label: 'delete a commitment' },
  { route: 'api/accounting/positions', method: 'DELETE', label: 'delete an LP position' },
  { route: 'api/accounting/closings', method: 'DELETE', label: 'delete a closing' },
  { route: 'api/lps/documents', method: 'DELETE', label: 'delete an LP document' },
  { route: 'api/lps/snapshots', method: 'DELETE', label: 'delete an LP report' },
  { route: 'api/accounting/vehicle-gp-links', method: 'DELETE', label: 'remove a GP link' },
  { route: 'api/accounting/cutover', method: 'DELETE', label: 'undo a cutover' },
  // Each handler also checks the role itself; listed here so the web, the API and MCP agree
  // (diligence_delete_deal, remove_member and merge_vehicles in ADMIN_ONLY_TOOLS below).
  { route: 'api/diligence/[id]', method: 'DELETE', label: 'delete a diligence deal' },
  { route: 'api/settings/members/[id]', method: 'DELETE', label: 'remove a team member' },
  // PATCH multiplexes: only a body with `mergeIntoId` is a merge; a rename or a logo is not.
  { route: 'api/vehicles', method: 'PATCH', when: body => !!body?.mergeIntoId, label: 'merge entities' },

  // ── Undo the books ─────────────────────────────────────────────────────────
  { route: 'api/accounting/journal', method: 'PATCH', when: action('unpost', 'reverse'), label: 'unpost or reverse a posted entry' },
  { route: 'api/accounting/periods', method: 'POST', when: action('reopen'), label: 'reopen a closed period' },

  // ── Move money ─────────────────────────────────────────────────────────────
  { route: 'api/accounting/capital-calls', method: 'POST', when: action('issue'), label: 'issue a capital call' },
  { route: 'api/accounting/proposed-calls', method: 'POST', when: action('approve'), label: 'approve a capital call notice' },
  // Drafting a call is an admin's job too; members with LP capital access can view proposals.
  { route: 'api/accounting/proposed-calls', method: 'POST', when: action('propose', 'revise', 'discard'), label: 'propose, revise or discard a capital call' },
  { route: 'api/accounting/distributions', method: 'POST', when: action('declare'), label: 'declare a distribution' },

  // ── Tell LPs something ─────────────────────────────────────────────────────
  { route: 'api/accounting/lp-statement/publish', method: 'POST', label: 'publish LP statements' },
  { route: 'api/accounting/notices/publish', method: 'POST', label: 'publish notices to LPs' },
  { route: 'api/lps/snapshots/[id]/share', method: 'POST', label: 'share an LP report' },
  { route: 'api/lps/snapshots/[id]/share', method: 'DELETE', label: 'unshare an LP report' },
  { route: 'api/lp-letters/[id]/share', method: 'POST', label: 'share an LP letter' },
  { route: 'api/lp-letters/[id]/share', method: 'DELETE', label: 'unshare an LP letter' },
  { route: 'api/lps/live-report/share', method: 'POST', label: 'share the live LP report' },
  { route: 'api/lps/send', method: 'POST', label: 'send to LPs' },
  { route: 'api/lps/announce', method: 'POST', label: 'announce to LPs' },

  // ── Tax ────────────────────────────────────────────────────────────────────
  { route: 'api/accounting/k1-packages', method: 'POST', when: action('finalize', 'amend'), label: 'finalize or amend K-1s' },
  { route: 'api/accounting/k1-deliveries', method: 'POST', when: action('deliver'), label: 'deliver K-1s to LPs' },
  { route: 'api/accounting/tax-year', method: 'POST', when: action('reopen'), label: 'reopen a closed tax year' },

  // ── Structure: who the partners are, and how the economics split ───────────
  { route: 'api/vehicles', method: 'POST', label: 'create a vehicle' },
  { route: 'api/accounting/commitments', method: 'POST', label: 'add a commitment' },
  { route: 'api/accounting/closings', method: 'POST', label: 'add a closing' },
  { route: 'api/accounting/waterfall-terms', method: 'PUT', label: 'change waterfall terms' },
  // The LPA's capital call notice period: every call is checked against it.
  { route: 'api/accounting/vehicle-settings', method: 'PATCH', when: body => body?.callNoticeDays !== undefined || body?.callNoticeBasis !== undefined, label: 'change the LPA notice period' },
  { route: 'api/accounting/gp-economics', method: 'PUT', label: 'change GP economics' },
  { route: 'api/accounting/gp-economics', method: 'POST', label: 'change GP economics' },
  { route: 'api/accounting/gp-economics', method: 'DELETE', label: 'change GP economics' },

  // ── Lock what the firm decided ─────────────────────────────────────────────
  { route: 'api/diligence/[id]/drafts/[draftId]/finalize', method: 'POST', label: 'finalize a memo' },
]

/** Rules a handler checks itself, because the database decides them. Named so a test can see them. */
export const HANDLER_CHECKED = {
  voidPostedEntry: 'void a posted entry',
} as const

/** Agent tools that are admin-only: the same operations as the routes above, reached from chat. */
export const ADMIN_ONLY_TOOLS: Record<string, { label: string; when?: (input: any) => boolean }> = {
  add_partner: { label: 'add a partner and commitment' },
  diligence_finalize_memo: { label: 'finalize a memo' },
  // The Investors page lets only an admin change the register's investors and entities, and the
  // commitments page only an admin add a commitment (ADMIN_ONLY_ROUTES above).
  lp_create_investor: { label: 'add an LP investor' },
  lp_update_investor: { label: 'change an LP investor' },
  lp_create_entity: { label: 'add an LP entity' },
  lp_update_entity: { label: 'change an LP entity' },
  lp_record_commitment: { label: 'add a commitment' },
  // As the letter's share route (ADMIN_ONLY_ROUTES above): what an LP sees in their portal.
  lp_share_letter: { label: 'share an LP letter' },
  // The LP Portal page's actions (lib/agent/lp-portal-tools.ts). Every one is admin-only on the web:
  // the invites, authorized-users and send routes check the role in their handler, announce is in
  // ADMIN_ONLY_ROUTES above, and the portal switches are admin fields on /api/settings. They grant an
  // outsider access to fund data or email LPs, so a member can only propose them, from chat.
  lp_portal_invite: { label: 'invite an LP to the portal' },
  lp_portal_invite_bulk: { label: 'invite LPs to the portal' },
  lp_portal_account_status: { label: 'change an LP\'s portal access' },
  lp_portal_resend_invite: { label: 'resend an LP portal invite' },
  lp_portal_unlink: { label: 'remove an LP\'s portal link' },
  lp_authorized_user_add: { label: 'grant an authorized user portal access' },
  lp_authorized_user_remove: { label: 'revoke an authorized user' },
  lp_announce: { label: 'announce to LPs' },
  lp_send_item: { label: 'send to LPs' },
  lp_portal_settings: { label: 'change the LP portal settings' },
  // As the proposed-calls route (ADMIN_ONLY_ROUTES above): approving issues the call, and proposing,
  // revising and discarding one are admin-only too. Members can view proposals.
  lp_proposed_call_propose: { label: 'propose, revise or discard a capital call' },
  lp_proposed_call_revise: { label: 'propose, revise or discard a capital call' },
  lp_proposed_call_discard: { label: 'propose, revise or discard a capital call' },
  lp_proposed_call_approve: { label: 'approve a capital call notice' },

  // The destructive tools (lib/agent/destructive-tools-manifest.ts): offered only with
  // AGENT_DESTRUCTIVE_ACTIONS=true and always staged, so this is who may APPROVE them. The same
  // operations, with the same labels, as the routes above.
  delete_company: { label: 'delete a company' },
  lp_delete_investor: { label: 'delete an LP investor' },
  lp_delete_entity: { label: 'delete an LP entity' },
  lp_delete_commitment: { label: 'delete a commitment' },
  lp_merge_investors: { label: 'merge LP investors' },
  delete_lp_positions: { label: 'delete an LP position' },
  diligence_delete_deal: { label: 'delete a diligence deal' },
  remove_member: { label: 'remove a team member' },
  merge_vehicles: { label: 'merge entities' },
  unpost_entry: { label: 'unpost or reverse a posted entry' },
  reverse_entry: { label: 'unpost or reverse a posted entry' },
  void_entry: { label: HANDLER_CHECKED.voidPostedEntry },
  // Not a destructive tool (always offered), but admin-only like the Periods page's Reopen.
  reopen_period: { label: 'reopen a closed period' },

  // As api/lps/documents and its upload-url, which only an admin may call: recording an LP document
  // is what shows it in LPs' portals. The URL tool runs directly from a chat, so its handler checks too.
  lp_document_upload_url: { label: 'upload an LP document' },
  lp_add_document: { label: 'publish an LP document' },
}

/** Analyst write actions that are admin-only to approve (lib/pending-actions/registry.ts). */
export const ADMIN_ONLY_ACTIONS: Record<string, string> = {
  issue_capital_call: 'issue a capital call',
  publish_call_notices: 'publish notices to LPs',
}

/** Does this route need the body to decide? Then the middleware has to read it. */
export function adminRuleNeedsBody(route: string, method: string): boolean {
  return ADMIN_ONLY_ROUTES.some(r => r.route === route && r.method === method.toUpperCase() && !!r.when)
}

/**
 * The admin-only rule this request falls under, or undefined. `body` is the parsed JSON body, or
 * `UNREADABLE` when the route needed it and it could not be parsed: then any body-dependent rule
 * on the route applies, because a request we cannot read is not one we can clear.
 */
export const UNREADABLE = Symbol('unreadable body')
export function adminOnlyRule(route: string, method: string, body?: unknown): AdminOnlyRule | undefined {
  const m = method.toUpperCase()
  return ADMIN_ONLY_ROUTES.find(r => r.route === route && r.method === m && (!r.when || body === UNREADABLE || r.when(body)))
}

export function adminOnlyToolLabel(tool: string, input: unknown): string | undefined {
  const rule = ADMIN_ONLY_TOOLS[tool]
  return rule && (!rule.when || rule.when(input)) ? rule.label : undefined
}

/** The refusal, the same words on every surface. */
export function adminOnlyMessage(label: string): string {
  return `Only an admin can ${label}.`
}

/** For handler-checked rules: a message when this caller may not, null when they may. */
export function adminOnlyDenial(role: FundRole | string | null | undefined, label: string): string | null {
  return role === 'admin' ? null : adminOnlyMessage(label)
}
