// Pure metadata for the UPLOAD tools: a file of any size reaches the app without passing through
// the chat. NO server imports (the Settings key UI lists these). Handlers live in upload-tools.ts;
// the pattern and why are in lib/uploads/signed-upload.ts.
//
// Each `*_upload_url` tool mints a short-lived signed URL at a path the server chose; the assistant's
// own environment PUTs the file there; a register tool then takes it in exactly as the web page does
// (the same route logic, now in lib/). The URL tools change no record, so they run directly
// (`runsDirectly`); the register tools are ordinary writes, staged from a chat like any other.
// Each is gated like its web route (lib/access/route-domains.ts):
//
//   diligence_document_upload_url → api/diligence/[id]/documents/upload-url   (then diligence_add_documents)
//   company_document_upload_url   → api/companies/[id]/documents              (then add_company_document)
//   deals_deck_upload_url         → api/deals/manual                          (then deals_create_inbound)
//   company_update_upload_url     → submit_company_update's own gate          (then submit_company_update)
//   email_attachment_upload_url   → api/emails/[id]/attachments               (then add_email_attachment)
//   lp_document_upload_url        → api/lps/documents/upload-url, admin only  (then lp_add_document, admin only)

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

/** Said in every upload-URL tool's description: the file goes from a folder, never through the chat. */
const HOW =
  ' NEVER ask the person to paste or attach the file in chat. Ask them to save it in a folder (for example their ' +
  'data-room folder) and give you its path; then, from your own environment, upload it from there with the returned ' +
  'URL exactly as the result\'s `curl` shows: curl -X PUT -H "Content-Type: <the file\'s type>" -H "x-upsert: false" ' +
  '--data-binary @"<path>" "<uploadUrl>". The result gives the URL\'s expiry (2 hours, one upload), the exact headers ' +
  'and the size limit. When the PUT returns 200, call '

const FILE_PROPS = {
  fileName: { type: 'string', description: 'The file\'s name with its extension, e.g. "Acme - Series A deck.pdf".' },
  sizeBytes: { type: 'number', description: 'The file\'s size in bytes (e.g. from `wc -c`), checked against the limit before the URL is made.' },
  contentType: { type: 'string', description: 'The file\'s MIME type; default from the extension. Send the same value as the PUT\'s Content-Type.' },
}

const UPLOADED = {
  type: 'object',
  properties: {
    storage_path: { type: 'string', description: 'storagePath from the upload-URL tool, after the PUT returned 200.' },
    filename: { type: 'string' },
    content_type: { type: 'string' },
  },
  required: ['storage_path'],
}

export const UPLOADED_FILES_SCHEMA = (tool: string, limit: string) => ({
  type: 'array',
  description: `Files you uploaded with ${tool} (${limit}), as { storage_path, filename, content_type }. Use this for anything over 3 MB, and prefer it for any file on disk.`,
  items: UPLOADED,
})

const DEAL = { type: 'string', description: 'The deal room: its id, or the company name (diligence_list_deals).' }
const COMPANY = { type: 'string', description: 'Company id or name.' }
const EMAIL_OR_DEAL = {
  email: { type: 'string', description: 'The inbound email id (from inbox_waiting, or an Emails page URL).' },
  deal: { type: 'string', description: 'Or an inbound deal (id or company name): its source email gets the attachment.' },
}
const LP = { domain: 'lp' as const, accessDomain: 'lp_relations' as const, accessFeature: 'lp_portal' as const }

export const UPLOAD_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'diligence_document_upload_url',
    description:
      'Start uploading a file of any size up to 100 MB (a deck, a model, a call recording) to a deal room\'s data room: ' +
      'returns a signed upload URL inside the deal\'s folder.' + HOW +
      'diligence_add_documents with the deal and uploaded_files: [{ storage_path, filename, content_type }]. It is then ' +
      'scanned and classified as a browser upload is; run diligence_run_agent with stage "analyze" to read it into evidence.',
    scope: 'write',
    domain: 'diligence',
    runsDirectly: true,
    inputSchema: { type: 'object', properties: { deal: DEAL, ...FILE_PROPS }, required: ['deal', 'fileName'] },
  },
  {
    name: 'company_document_upload_url',
    description:
      'Start uploading a document (up to 20 MB: a board deck, a model, a strategy memo) to a portfolio company\'s Documents: ' +
      'returns a signed upload URL in the company\'s folder.' + HOW +
      'add_company_document. It is then virus-scanned and its text extracted, as on the company page.',
    scope: 'write',
    domain: 'portfolio',
    runsDirectly: true,
    inputSchema: { type: 'object', properties: { company: COMPANY, ...FILE_PROPS }, required: ['company', 'fileName'] },
  },
  {
    name: 'add_company_document',
    description:
      'Register a document uploaded with company_document_upload_url on the company\'s Documents: scanned (an unsafe file ' +
      'is deleted), its text extracted for search and AI summaries, and listed on the company page. Over 10 MB, a file that ' +
      'yields text is kept as its text only, as the company page does.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        storage_path: { type: 'string', description: 'storagePath from company_document_upload_url, after the PUT returned 200.' },
        filename: { type: 'string' },
        content_type: { type: 'string', description: 'e.g. application/pdf; default from the extension.' },
        size_bytes: { type: 'number', description: 'The file\'s size in bytes.' },
      },
      required: ['company', 'storage_path', 'filename'],
    },
  },
  {
    name: 'deals_deck_upload_url',
    description:
      'Start uploading a pitch deck or other file (up to 10 MB each, 10 per deal) for a new inbound deal: returns a signed ' +
      'upload URL.' + HOW +
      'deals_create_inbound with uploaded_files: [{ storage_path, filename, content_type }]. The analyser reads it with ' +
      'the pitch, as it does a file attached to the New deal form.',
    scope: 'write',
    domain: 'deals',
    runsDirectly: true,
    inputSchema: { type: 'object', properties: FILE_PROPS, required: ['fileName'] },
  },
  {
    name: 'company_update_upload_url',
    description:
      'Start uploading a file of a portfolio company\'s update (a quarterly letter, board deck or KPI sheet; PDF, Word, ' +
      'Excel, PowerPoint, CSV, text or image; up to 25 MB, 5 per update): returns a signed upload URL.' + HOW +
      'submit_company_update with uploaded_files: [{ storage_path, filename, content_type }]. It runs the same pipeline ' +
      'as an emailed update.',
    scope: 'write',
    domain: 'portfolio',
    runsDirectly: true,
    inputSchema: { type: 'object', properties: FILE_PROPS, required: ['fileName'] },
  },
  {
    name: 'email_attachment_upload_url',
    description:
      'Start uploading a file (up to 25 MB) to attach to an inbound email, or to an inbound deal\'s source email: ' +
      'returns a signed upload URL in that email\'s folder.' + HOW +
      'add_email_attachment. Reprocess the email in the app if the pipeline should read it.',
    scope: 'write',
    domain: 'portfolio',
    runsDirectly: true,
    inputSchema: { type: 'object', properties: { ...EMAIL_OR_DEAL, ...FILE_PROPS }, required: ['fileName'] },
  },
  {
    name: 'add_email_attachment',
    description:
      'Attach a file uploaded with email_attachment_upload_url to its email: verified, scanned (an unsafe file is deleted) ' +
      'and listed with the email\'s attachments, as the email page\'s Upload document does.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        ...EMAIL_OR_DEAL,
        storage_path: { type: 'string', description: 'storagePath from email_attachment_upload_url, after the PUT returned 200.' },
        filename: { type: 'string' },
        content_type: { type: 'string', description: 'default from the extension' },
        size_bytes: { type: 'number', description: 'The file\'s size in bytes; default what was uploaded.' },
      },
      required: ['storage_path', 'filename'],
    },
  },
  {
    name: 'lp_document_upload_url',
    description:
      'Start uploading a document for the LP portal (a quarterly report, a K-1 cover letter, a side letter; up to 50 MB): ' +
      'returns a signed upload URL in the fund\'s folder. Admin only.' + HOW +
      'lp_add_document, which decides who sees it.',
    scope: 'write',
    ...LP,
    runsDirectly: true,
    inputSchema: { type: 'object', properties: FILE_PROPS, required: ['fileName'] },
  },
  {
    name: 'lp_add_document',
    description:
      'Publish a document uploaded with lp_document_upload_url to the LP portal: every LP (scope "fund"), named investors ' +
      '("investor"), or everyone in an entity ("vehicle"). Scanned before it is recorded, and its text indexed for the ' +
      'portal\'s analyst unless index is false. LPs see it as soon as it is recorded. Admin only.',
    scope: 'write',
    ...LP,
    inputSchema: {
      type: 'object',
      properties: {
        storage_path: { type: 'string', description: 'storagePath from lp_document_upload_url, after the PUT returned 200.' },
        title: { type: 'string', description: 'What LPs see, e.g. "Q3 2026 report".' },
        file_name: { type: 'string' },
        mime_type: { type: 'string', description: 'default from the extension' },
        size_bytes: { type: 'number' },
        scope: { type: 'string', enum: ['fund', 'investor', 'vehicle'], description: 'Who sees it. Default fund (every LP).' },
        investors: { type: 'array', items: { type: 'string' }, description: 'For scope "investor": investor names or ids.' },
        vehicle: { type: 'string', description: 'For scope "vehicle": the entity (portfolio_group) whose investors see it.' },
        category: { type: 'string', description: 'e.g. Reports, Tax, Legal.' },
        doc_date: { type: 'string', description: 'YYYY-MM-DD the document is dated.' },
        index: { type: 'boolean', description: 'false: do not index its text (an onboarding form with identifiers). Default true.' },
      },
      required: ['storage_path', 'title', 'file_name'],
    },
  },
]
