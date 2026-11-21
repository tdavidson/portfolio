// Handlers for reading a holding's files (company-document-tools-manifest.ts). The holding resolves
// with the member's access, then lib/companies/holding-documents.ts reads only that holding's rows
// in the active fund.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { listHoldingDocuments, readHoldingDocument } from '@/lib/companies/holding-documents'
import { resolveCompany } from './portfolio-tools'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export const COMPANY_DOCUMENT_HANDLERS: Record<string, AgentToolHandler> = {
  list_company_documents: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const company = await resolveCompany(admin, fundId, str(input?.company), access)
    const out = await listHoldingDocuments(admin, { fundId, companyId: company.id }, {
      source: input?.source,
      query: input?.query,
      uploadedAfter: input?.uploaded_after,
      uploadedBefore: input?.uploaded_before,
      limit: input?.limit,
      cursor: input?.cursor,
    })
    return { company: company.name, companyId: company.id, ...out }
  },

  read_company_document: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const company = await resolveCompany(admin, fundId, str(input?.company), access)
    const out = await readHoldingDocument(admin, { fundId, companyId: company.id }, str(input?.document), {
      pages: typeof input?.pages === 'string' ? input.pages : undefined,
      offset: input?.offset,
      downloadUrl: input?.download_url !== false,
    })
    return { company: company.name, ...out }
  },
}
