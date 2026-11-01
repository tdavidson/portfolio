// Pure metadata for the FUND RECORDS tools: filing what was concluded in a session, and finding it
// again. NO server imports (the Settings key UI lists these). Handlers live in record-tools.ts; the
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
      'File a record with the fund: what was concluded, decided or said in this session, so the fund keeps it after the chat ends. ' +
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
    name: 'list_records',
    description:
      'Records the fund has filed that you may see, newest first, without their bodies: who filed each, when, through which door ' +
      '(web, API or MCP), in which area and entity. Filter by area, entity, subject or text. Read one with read_record. ' +
      'Check here before redoing work someone has already concluded.',
    scope: 'read',
    ...BASE,
    inputSchema: {
      type: 'object',
      properties: {
        area: AREA,
        entity: ENTITY,
        subject_type: { type: 'string', enum: [...RECORD_SUBJECTS] },
        subject_id: { type: 'string' },
        query: { type: 'string', description: 'Words to find in the title or body.' },
        limit: { type: 'integer', description: 'Up to 200; 50 by default.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_record',
    description: 'One filed record, with its body.',
    scope: 'read',
    ...BASE,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The record id, from list_records.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]
