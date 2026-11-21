// The work a person's own assistant does when the fund has no server AI key (lib/ai/keyless.ts):
// the inbox of emailed updates the pipeline saved but could not read, scans waiting for OCR, and
// saving what the assistant wrote. Spread into the portfolio manifest, so they gate and dispatch
// exactly like the other portfolio tools.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const EMAIL = { type: 'string', description: 'The email id, from inbox_waiting.' }

export const KEYLESS_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'inbox_waiting',
    description:
      'Company updates that arrived by email (or were submitted from chat) and are waiting for you: this fund has no server AI key, ' +
      'so the app saved them without reading them. Read each with inbox_read, record its figures with record_metric_value ' +
      '(and notes with add_company_note), then mark it with inbox_done.',
    scope: 'read',
    domain: 'portfolio',
    // The mailbox: closed with the Inbound page when an admin makes it "Admins only".
    accessFeature: 'inbound',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '1-50, default 20.' } } },
  },
  {
    name: 'inbox_read',
    description:
      'One waiting update in full: sender, subject, body and the text of each attachment. A scanned PDF or an image has no text ' +
      'here; say so rather than guessing at it.',
    scope: 'read',
    domain: 'portfolio',
    // The mailbox: closed with the Inbound page when an admin makes it "Admins only".
    accessFeature: 'inbound',
    inputSchema: {
      type: 'object',
      properties: { email: EMAIL, max_chars: { type: 'number', description: 'Character budget for the text (2000-60000; default 30000).' } },
      required: ['email'],
    },
  },
  {
    name: 'inbox_done',
    description:
      'Mark a waiting update as handled, once its figures are recorded: files it under the company, so it shows on the company\'s ' +
      'updates and leaves the waiting list. Pass recorded: 0 when there was nothing to record.',
    scope: 'write',
    domain: 'portfolio',
    // The mailbox: closed with the Inbound page when an admin makes it "Admins only".
    accessFeature: 'inbound',
    inputSchema: {
      type: 'object',
      properties: {
        email: EMAIL,
        company: { type: 'string', description: 'Company id, or the company name.' },
        recorded: { type: 'number', description: 'How many metric values you recorded from it.' },
      },
      required: ['email', 'company'],
    },
  },
  {
    name: 'ocr_waiting',
    description:
      'Scanned PDF pages and images in company updates that are waiting for you to read them: this fund has no server AI key ' +
      'to transcribe them with. For each, look at it with ocr_page and save what it says with ocr_save_text.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '1-50, default 20.' } } },
  },
  {
    name: 'ocr_page',
    description:
      'One waiting scanned page or image, as an image for you to read. For a PDF, name the page (ocr_waiting lists the pages ' +
      'that need reading); an image has one page.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: { artifact: { type: 'string', description: 'The artifact id, from ocr_waiting.' }, page: { type: 'number' } },
      required: ['artifact'],
    },
  },
  {
    name: 'ocr_save_text',
    description:
      'Save your transcription of a waiting scan: the visible text, VERBATIM, in reading order, tables as rows with cells ' +
      'separated by " | ", numbers exactly as printed. No summary or commentary. For a PDF send pages: [{ page, text }] for every ' +
      'page you read; for an image send text. It then becomes searchable with get_updates.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string' },
        text: { type: 'string', description: 'For an image.' },
        pages: {
          type: 'array',
          items: { type: 'object', properties: { page: { type: 'number' }, text: { type: 'string' } }, required: ['page', 'text'] },
          description: 'For a PDF.',
        },
      },
      required: ['artifact'],
    },
  },
  {
    name: 'company_save_summary',
    description:
      'Save a summary you wrote of a portfolio company (from company_detail, company_metrics and get_updates) as its AI summary, ' +
      'shown on the company page: how a fund with no server AI key gets one. Plain prose; name the period it covers.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company id, or the company name.' },
        summary: { type: 'string' },
        period: { type: 'string', description: 'The period it covers, e.g. "Q3 2026".' },
      },
      required: ['company', 'summary'],
    },
  },
]
