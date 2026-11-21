// Pure metadata for reading a holding's FILES: the Documents page's uploads and the files attached
// to its company updates. NO server imports (the Settings key UI lists these). Handlers live in
// company-document-tools.ts; adding a file is add_company_document (upload-tools-manifest.ts).
//
// Read scope, never staged, gated like the holding page's Documents section
// (api/companies/[id]/documents: the portfolio domain). The holding resolves with the member's
// entities, so another fund's holding, or one outside their entities, is simply not found.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const COMPANY = { type: 'string', description: 'The holding (company, fund holding or digital asset): its id, or its name.' }
const DATE = { type: 'string', description: 'YYYY-MM-DD' }

export const COMPANY_DOCUMENT_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'list_company_documents',
    description:
      'List a holding\'s files, newest first: the documents on its Documents page and the files attached to its company ' +
      'updates. Each row has the id, source (document or update, with update_id), filename, content type, size, sha256 (of ' +
      'the stored bytes), text_sha256 (of the normalised extracted text), when and by whom it was uploaded and through what ' +
      '(web, mcp, api or email), scan_status (clean, pending, removed) and text_status (extracted, text_only, none, pending), ' +
      'and the page count. Use it BEFORE uploading to spot a file already on file: a matching sha256 or text_sha256 is the ' +
      'same document, whatever its name. Read one with read_company_document. Not for an entity\'s governing documents ' +
      '(list_entity_documents) or inbound mail never filed to a holding (inbox_read).',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: COMPANY,
        source: { type: 'string', enum: ['documents', 'updates', 'all'], description: 'Default all.' },
        query: { type: 'string', description: 'Words to find in the filename or the extracted text.' },
        uploaded_after: { ...DATE, description: 'Only files uploaded on or after this date (YYYY-MM-DD).' },
        uploaded_before: { ...DATE, description: 'Only files uploaded on or before this date (YYYY-MM-DD).' },
        limit: { type: 'integer', description: 'Rows per page. Default 50, at most 200.' },
        cursor: { type: 'string', description: 'nextCursor from the previous page.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_company_document',
    description:
      'Read one of a holding\'s files (a Documents file or a company update\'s attachment) by its id from ' +
      'list_company_documents: its metadata, its extracted text (the text the app searches and summarises; an uploaded PDF\'s ' +
      'text layer is read from the file) and a signed link to download the original, valid for 15 minutes. Up to 100,000 ' +
      'characters per call: when truncated is true, call again with offset set to nextOffset. pages narrows a PDF to a range ' +
      'such as "1-3". A file the virus scan removed, or one kept as text only, has no download link.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      required: ['company', 'document'],
      properties: {
        company: COMPANY,
        document: { type: 'string', description: 'The document id from list_company_documents.' },
        pages: { type: 'string', description: 'Optional page range for a PDF, e.g. "1-3" or "2,5".' },
        offset: { type: 'integer', description: 'Character offset to continue a truncated read (nextOffset).' },
        download_url: { type: 'boolean', description: 'Return a short-lived download link for the original. Default true.' },
      },
      additionalProperties: false,
    },
  },
]
