// Pure metadata for the AUDIT tools: reading the automatic log of outside firms (audit_log), turning
// it on or off (audit_settings), and the optional notes filed into it (file_to_record, read_record). NO server imports (the Settings key UI lists these). Handlers live in record-tools.ts; the
// logic they share with the web route is lib/records.
//
// An MCP server sees tool calls, not the conversation. file_to_record is how the conversation's
// outcome becomes the fund's: a summary, a decision, a memo, a transcript excerpt. Each record sits
// in one area (accounting, tax, compliance ...) and the tools' domain is that area (`areaInput`):
// reading and filing both need read on it, so an auditor files into accounting, a tax preparer
// into tax. Filing runs directly from a chat, since it adds a note and changes nothing else.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { RECORD_AREAS, RECORD_KINDS, RECORD_SUBJECTS } from '@/lib/records/areas'

const BASE = { domain: 'portfolio' as const, areaInput: true as const }
const AREA = {
  type: 'string', enum: [...RECORD_AREAS],
  description: 'The area of the fund the record belongs to, e.g. accounting for a journal review, tax for a K-1 question, compliance for a filing.',
}
const ENTITY = { type: 'string', description: 'The entity (fund vehicle): its id or name. list_vehicles lists them. Optional when you work in only one.' }

export const RECORD_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'file_to_record',
    description:
      'File a note into the fund\'s Audit log: what was concluded, decided or said in this session, so the fund keeps it after the chat ends. ' +
      'Optional: the Audit log already records every change automatically; a note adds the why. ' +
      'Use it at the end of a working session (a journal review, a reconciliation, a tax or compliance question) or when the person asks you to ' +
      '"note this", "file this" or "keep a record". Write the body as a standalone note someone at the fund can read later: what was looked at, ' +
      'what was found, what was decided and what is still open, with the ids or amounts that matter. Show the person the title and body and ' +
      'file it once they agree. Records cannot be edited or deleted; a correction is a new record. Needs read access to the area.',
    scope: 'write',
    runsDirectly: true,
    ...BASE,
    inputSchema: {
      type: 'object',
      properties: {
        area: AREA,
        entity: ENTITY,
        kind: { type: 'string', enum: [...RECORD_KINDS], description: 'summary (default) for a session summary; decision, memo, transcript or note.' },
        title: { type: 'string', description: 'A short title, under 200 characters, e.g. "Q3 journal review: two reclasses proposed".' },
        body: { type: 'string', description: 'The record itself, in plain text or Markdown.' },
        subject_type: { type: 'string', enum: [...RECORD_SUBJECTS], description: 'When the record is about one thing: what kind of thing.' },
        subject_id: { type: 'string', description: 'Its id. Give it with subject_type.' },
      },
      required: ['area', 'title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'audit_log',
    description:
      'The fund\'s Audit log: what each outside firm (fund administrator, auditor, tax preparer, compliance vendor) did, grouped by firm, ' +
      'newest first. Logged automatically while Audit is on: every change through the web app, an assistant (MCP) or the API, each day ' +
      'someone connected over MCP or the API, and any note filed with file_to_record (open one with read_record). Kept after an ' +
      'engagement ends. Someone on an engagement sees only their own firm. Also says whether Audit is shown to members, admins only, or off.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'records',
    accessFeature: 'audit',
    inputSchema: {
      type: 'object',
      properties: {
        firm: { type: 'string', description: 'One firm (engagement): its name or id. Omit for every firm you can see.' },
        since: { type: 'string', description: 'YYYY-MM-DD. Default: 90 days ago.' },
        until: { type: 'string', description: 'YYYY-MM-DD. Default: today.' },
        limit: { type: 'integer', description: 'Entries per firm, up to 1000; 200 by default.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'audit_settings',
    description:
      'Turn Audit on or off, for an admin: members (on, each member sees it subject to their access grant), admins (on, admins only) or ' +
      'off (nothing is logged for it and nobody sees it; what was logged is kept). The same switch as Settings, under Portfolio Reporting.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'admin',
    inputSchema: {
      type: 'object',
      properties: { visibility: { type: 'string', enum: ['members', 'admins', 'off'] } },
      required: ['visibility'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_record',
    description: 'One note filed into the Audit log, with its body. audit_log lists them.',
    scope: 'read',
    ...BASE,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The note\'s record id, from audit_log.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]
