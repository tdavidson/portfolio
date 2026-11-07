/**
 * The investor connector's tools (app/api/portal/mcp): an LP's own portal, for an assistant.
 *
 * Every tool is a thin call into lib/portal/service.ts, the same functions the web portal's routes
 * call, with a principal already narrowed to the one fund the connection was made for
 * (lib/portal/principal.ts). So the connector can show nothing, and change nothing, the LP couldn't
 * on the web, and every view, download, acknowledgment and message lands in the same LP access log,
 * marked as coming through MCP.
 *
 * The tools that act for the LP need the `write` scope they agreed to on the consent screen:
 * acknowledging a capital call wire, messaging the fund, and asking the fund to change their record
 * or give someone access (change requests, which change nothing until the fund approves them). Uploads (onboarding documents) stay on
 * the web: a file is not something to hand an assistant.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  acknowledgeCapitalCall, portalDocumentUrl, portalLetterShare, portalDocuments, portalLetter, portalLetters, portalMessages,
  portalNotices, portalOnboarding, portalOverview, portalStatementFunds, PortalError, sendPortalMessage, type LpPrincipal,
} from './service'
import { linkNote, reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import {
  myChangeRequests, portalRecord, requestAuthorizedUser, requestProfileChange, withdrawChangeRequest,
} from '@/lib/lps/change-requests'
import { loadBranding } from '@/lib/mcp-apps/branding'
import type { LpPayload, LpRow } from '@/lib/mcp-apps/payload'

export interface PortalToolContext {
  admin: SupabaseClient
  principal: LpPrincipal
  /** The fund this connection is bound to. */
  fundId: string
  origin: string
}

export interface PortalTool {
  name: string
  title: string
  description: string
  scope: 'read' | 'write'
  /** The result is a dashboard payload, drawn by the fund connector's own view (lib/mcp-apps). */
  ui?: boolean
  inputSchema: Record<string, unknown>
  run(ctx: PortalToolContext, args: Record<string, unknown>): Promise<unknown>
}

/**
 * The investor's position as the LP capital dashboard: one row per vehicle they hold, from the same
 * published statement as portal_overview. The view is the fund connector's, so it carries the fund's
 * colours; it needs no other tool, since every row is already the investor's own.
 */
async function positionDashboard(ctx: PortalToolContext): Promise<LpPayload | { available: false; reason: string }> {
  const [overview, branding] = await Promise.all([portalOverview(ctx.admin, ctx.principal), loadBranding(ctx.admin, ctx.fundId)])
  if (!overview.hasData) return { available: false, reason: 'The fund has not published a capital statement to you yet.' }
  const investor = overview.investorName ?? 'You'
  const n = (v: number | null) => v ?? 0
  const rows: LpRow[] = overview.vehicles.map(v => ({
    investor, entity: investor, vehicle: v.name,
    commitment: v.commitment, paidIn: n(v.called), distributions: n(v.distributed), nav: n(v.nav),
    dpi: v.dpi, rvpi: null, tvpi: v.tvpi, irr: null,
  }))
  const t = overview.totals
  return {
    view: 'lps',
    title: 'Your position',
    subtitle: overview.asOfDate ? `As of ${overview.asOfDate}` : null,
    args: {},
    generatedAt: new Date().toISOString(),
    branding: { ...branding, currency: overview.currency || branding.currency },
    data: {
      asOf: overview.asOfDate, vehicle: 'all',
      rows,
      totals: { commitment: t.commitment, paidIn: n(t.called), distributions: n(t.distributed), nav: n(t.nav), dpi: t.dpi, rvpi: null, tvpi: t.tvpi },
    },
  }
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false }

/** Letters are GP-authored HTML; an assistant wants the words. */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  return html
    .replace(/<\s*(br|\/p|\/tr|\/h\d|\/li)\s*\/?>/gi, '\n')
    .replace(/<\s*\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const PORTAL_TOOLS: PortalTool[] = [
  {
    name: 'portal_home',
    title: 'Investor portal home',
    description:
      'Start here. What this connection can show and do for the investor, and a short summary of their position. ' +
      'Call it when the user asks for help, says hi, or is unsure what to ask.',
    scope: 'read',
    inputSchema: noArgs,
    async run(ctx) {
      const [overview, notices] = await Promise.all([portalOverview(ctx.admin, ctx.principal), portalNotices(ctx.admin, ctx.principal)])
      const open = notices.filter(n => n.kind === 'capital_call' && n.status !== 'settled')
      return {
        investor: overview.investorName,
        position: overview.hasData ? overview : 'The fund has not published a capital statement to you yet.',
        openCapitalCalls: open.length,
        youCanAsk: [
          'How is my investment doing? (portal_overview, or show_my_position for a dashboard)',
          'Get my capital account statement (statement_pdf)',
          'Show me the latest letter (list_letters, read_letter, letter_pdf)',
          'What documents has the fund shared? (list_documents, get_document)',
          'Do I owe a capital call? (list_capital_notices)',
          "Tell the fund I've wired it (acknowledge_capital_call)",
          'Message the fund (send_message, list_messages)',
          'What paperwork is outstanding? (onboarding_status)',
          'Update my address or signatories (my_record, then request_record_change)',
          'Give my accountant access (request_authorized_user)',
          'Where do my requests stand? (my_change_requests)',
        ],
      }
    },
  },
  {
    name: 'portal_overview',
    title: 'My position',
    description: "The investor's commitment, paid-in capital, distributions and NAV, in total and by vehicle, from the capital statement the fund has published to them.",
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalOverview(ctx.admin, ctx.principal),
  },
  {
    name: 'show_my_position',
    title: 'My position (dashboard)',
    description:
      "Show the investor's position as an interactive dashboard in the conversation: commitment, paid-in, distributions, " +
      'NAV, DPI and TVPI, in total and by vehicle. Use it when the user asks to see or show their investment. ' +
      'A host that cannot draw it gets the same figures as text.',
    scope: 'read',
    ui: true,
    inputSchema: noArgs,
    run: ctx => positionDashboard(ctx),
  },
  {
    name: 'statement_pdf',
    title: 'Capital account statement (PDF)',
    description:
      "A download link for the investor's live capital account statement as a PDF. The link works for one hour; " +
      'give it to the user as a link, and ask again for a fresh one later.',
    scope: 'read',
    inputSchema: noArgs,
    async run(ctx) {
      const funds = await portalStatementFunds(ctx.admin, ctx.principal)
      if (!funds.includes(ctx.fundId)) return { available: false, reason: 'The fund has not published a capital statement to you yet.' }
      const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId: ctx.principal.userId, kind: 'portal_statement', args: {} })
      return { available: true, url: reportLinkUrl(ctx.origin, token), expiresAt, note: linkNote('The link works for one hour.') }
    },
  },
  {
    name: 'list_letters',
    title: 'Letters',
    description: 'The quarterly letters the fund has shared with the investor, newest first, with when they last read each.',
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalLetters(ctx.admin, ctx.principal),
  },
  {
    name: 'read_letter',
    title: 'Read a letter',
    description: 'The full text of one shared letter, by the id from list_letters.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { letter_id: { type: 'string', description: 'From list_letters.' } }, required: ['letter_id'], additionalProperties: false },
    async run(ctx, args) {
      const letter = await portalLetter(ctx.admin, ctx.principal, String(args.letter_id ?? ''))
      return {
        id: letter.id,
        period: letter.period_label,
        text: letter.full_draft,
        portfolioTable: htmlToText(letter.portfolio_table_html),
        companyNarratives: letter.company_narratives,
      }
    },
  },
  {
    name: 'letter_pdf',
    title: 'Letter (PDF)',
    description: 'A download link for one shared letter as a PDF, by the id from list_letters. The link works for one hour.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { letter_id: { type: 'string', description: 'From list_letters.' } }, required: ['letter_id'], additionalProperties: false },
    async run(ctx, args) {
      const letterId = String(args.letter_id ?? '')
      // Checked now so the assistant hears "not shared" in the conversation, and again at the click.
      const share = await portalLetterShare(ctx.admin, ctx.principal, letterId)
      if (share.fundId !== ctx.fundId) throw new PortalError(404, 'Not found')
      const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId: ctx.principal.userId, kind: 'portal_letter', args: { letter: letterId } })
      return { url: reportLinkUrl(ctx.origin, token), expiresAt, note: linkNote('The link works for one hour. For the letter as text, use read_letter.') }
    },
  },
  {
    name: 'list_documents',
    title: 'Documents',
    description: 'Documents the fund has shared with the investor (fund-wide and their own), newest first.',
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalDocuments(ctx.admin, ctx.principal),
  },
  {
    name: 'get_document',
    title: 'Get a document',
    description: 'A download link for one shared document, by the id from list_documents. The link works for one hour.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { document_id: { type: 'string', description: 'From list_documents.' } }, required: ['document_id'], additionalProperties: false },
    async run(ctx, args) {
      const doc = await portalDocumentUrl(ctx.admin, ctx.principal, String(args.document_id ?? ''), { ttlSeconds: 60 * 60 })
      return { title: doc.title, fileName: doc.fileName, url: doc.url }
    },
  },
  {
    name: 'list_capital_notices',
    title: 'Capital calls and distributions',
    description:
      "Every capital call and distribution for the investor, with the amount, what's been settled, what's outstanding, " +
      "the due date, and whether they've already told the fund they wired it.",
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalNotices(ctx.admin, ctx.principal),
  },
  {
    name: 'list_messages',
    title: 'Messages',
    description: "The investor's messages with the fund, oldest first, including the fund's announcements and replies.",
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalMessages(ctx.admin, ctx.principal),
  },
  {
    name: 'onboarding_status',
    title: 'Onboarding paperwork',
    description:
      'What onboarding paperwork the fund still needs from each of the investor\'s entities, and the status of each item. ' +
      'Documents are uploaded in the investor portal on the web, not here.',
    scope: 'read',
    inputSchema: noArgs,
    async run(ctx) {
      const r = await portalOnboarding(ctx.admin, ctx.principal)
      return { entities: r.entities, uploadIn: `${ctx.origin}/portal/onboarding` }
    },
  },
  {
    name: 'acknowledge_capital_call',
    title: "Tell the fund I've wired a capital call",
    description:
      "Records the investor's word that they've wired a capital call, on the line from list_capital_notices. " +
      "It's their acknowledgment, not a settlement: the call settles when the fund's books show the money. " +
      'Confirm the call, the date wired and any reference with the user before calling.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        line_id: { type: 'string', description: 'lineId of the capital call, from list_capital_notices.' },
        wired_on: { type: 'string', description: 'The date wired, YYYY-MM-DD.' },
        reference: { type: 'string', description: 'The bank reference, if any.' },
        note: { type: 'string', description: 'Anything else for the fund.' },
      },
      required: ['line_id'],
      additionalProperties: false,
    },
    run: (ctx, args) => acknowledgeCapitalCall(ctx.admin, ctx.principal, { lineId: args.line_id, wiredOn: args.wired_on, reference: args.reference, note: args.note }),
  },
  {
    name: 'send_message',
    title: 'Message the fund',
    description: "Sends the fund a message in the investor's name, to their portal inbox and by email to the fund's admins. Show the user the message and confirm before sending.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string' }, message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
    run: (ctx, args) => sendPortalMessage(ctx.admin, ctx.principal, { subject: args.subject, message: args.message }),
  },
  {
    name: 'my_record',
    title: 'My investor record',
    description:
      "The investor's record as the fund holds it: each entity's type, jurisdiction, address, notice email and signatories, and " +
      "the investor's contact details. Use it before request_record_change, to show what is on file. canRequest is false for an " +
      'authorized user, whose access is read-only.',
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalRecord(ctx.admin, ctx.principal),
  },
  {
    name: 'my_change_requests',
    title: 'My change requests',
    description: 'Changes this investor has asked the fund for, newest first, with whether each is pending, approved, rejected or withdrawn.',
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => myChangeRequests(ctx.admin, ctx.principal),
  },
  {
    name: 'request_record_change',
    title: 'Ask the fund to change my record',
    description:
      "Asks the fund to change one entity's record or the investor's contact details. Nothing changes until someone at the fund " +
      'approves it. Send only the fields that change. Show the user the change and confirm before calling.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'The entity id, from my_record.' },
        entity: {
          type: 'object',
          description: 'Entity fields to change: entity_type, formation_jurisdiction, address_line1, address_line2, city, region, ' +
            'postal_code, country, notice_email, signatories [{ name, title?, email? }] (the full list).',
        },
        contact: { type: 'object', description: 'Contact details to change: contact_name, contact_email, contact_phone.' },
        note: { type: 'string', description: 'Anything the fund should know, such as why.' },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    run: (ctx, args) => requestProfileChange(ctx.admin, ctx.principal, args),
  },
  {
    name: 'request_authorized_user',
    title: 'Ask the fund to give someone access',
    description:
      'Asks the fund to give someone (an advisor, an accountant) read-only portal access to act for this investor. The fund ' +
      'invites them once an admin approves. Confirm the name and email with the user before calling.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Their email address.' },
        name: { type: 'string', description: 'Their name.' },
        investor_id: { type: 'string', description: 'Which investor record, from my_record, when there is more than one.' },
        note: { type: 'string', description: 'Who they are, for the fund.' },
      },
      required: ['email'],
      additionalProperties: false,
    },
    run: (ctx, args) => requestAuthorizedUser(ctx.admin, ctx.principal, args),
  },
  {
    name: 'withdraw_change_request',
    title: 'Withdraw a change request',
    description: 'Withdraws one of the investor\'s pending change requests, by id from my_change_requests.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (ctx, args) => withdrawChangeRequest(ctx.admin, ctx.principal, args.id),
  },
]

export function getPortalTool(name: unknown): PortalTool | undefined {
  return PORTAL_TOOLS.find(t => t.name === name)
}

/** The tools a token with this scope may call. A read-only connection is never shown the write tools. */
export function portalToolsFor(scope: string): PortalTool[] {
  const canWrite = scope.split(/\s+/).includes('write')
  return PORTAL_TOOLS.filter(t => t.scope === 'read' || canWrite)
}
