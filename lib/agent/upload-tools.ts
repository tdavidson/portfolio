// Handlers for the UPLOAD tools (upload-tools-manifest.ts): signed upload URLs at server-chosen
// paths, and the register steps, which call the same lib functions as the web routes.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { hasAccess } from '@/lib/access/effective'
import { adminOnlyDenial } from '@/lib/access/admin-only'
import { createDiligenceUploadUrl, MAX_DILIGENCE_DOCUMENT_BYTES } from '@/lib/diligence/service'
import {
  COMPANY_DOCUMENT_BUCKET, COMPANY_TEXT_ONLY_THRESHOLD, MAX_COMPANY_DOCUMENT_BYTES, companyDocumentPath, registerCompanyDocument,
} from '@/lib/companies/documents'
import { EMAIL_ATTACHMENT_BUCKET, MAX_EMAIL_ATTACHMENT_BYTES, emailAttachmentPath, registerEmailAttachment } from '@/lib/emails/attachments'
import { createLpDocumentUploadUrl, MAX_LP_DOCUMENT_BYTES, recordLpDocument } from '@/lib/lps/documents'
import { MAX_DEAL_FILE_BYTES, MAX_DEAL_FILES } from '@/lib/deals/service'
import { MAX_UPDATE_FILES, MAX_STAGED_UPDATE_FILE_BYTES } from '@/lib/company-updates/submit'
import {
  STAGING_BUCKET, checkDeclaredSize, contentTypeFor, mb, mintSignedUpload, signedUploadResult, stagingPath, uploadFileName,
} from '@/lib/uploads/signed-upload'
import { unwrap } from '@/lib/service-outcome'
import { resolveDeal } from './diligence-tools'
import { resolveInboundDeal, requireUser } from './deals-tools'
import { resolveInvestor } from './lp-record-tools'
import { resolveCompany } from './portfolio-tools'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** The size of an object already in storage, from its listing (0 when it is not there). */
async function storedSize(admin: SupabaseClient, bucket: string, path: string): Promise<number> {
  const folder = path.split('/').slice(0, -1).join('/')
  const base = path.split('/').pop()
  const { data } = await (admin as any).storage.from(bucket).list(folder, { search: base ?? undefined, limit: 1 })
  return Number((data?.[0] as any)?.metadata?.size ?? 0)
}

/** The email a call names: by id (this fund's), or an inbound deal's source email (one the caller can see). */
async function resolveEmail(ctx: AgentToolContext, input: any): Promise<{ id: string; subject: string | null }> {
  const { admin, fundId, access } = ctx
  const dealRef = str(input?.deal)
  let emailId = str(input?.email)
  if (!emailId && dealRef) {
    if (!hasAccess(access, 'dealflow', 'write')) throw new Error('You do not have write access to deal flow.')
    const deal = await resolveInboundDeal(admin, fundId, dealRef, access)
    if (!deal.email_id) throw new Error(`${deal.company_name} has no source email to attach to.`)
    emailId = deal.email_id
  }
  if (!emailId) throw new Error('Name the email (email) or the inbound deal (deal).')
  const { data } = await (admin as any).from('inbound_emails').select('id, subject').eq('id', emailId).eq('fund_id', fundId).maybeSingle()
  if (!data) throw new Error(`No email ${emailId} in this fund.`)
  return { id: data.id, subject: data.subject ?? null }
}

export const UPLOAD_HANDLERS: Record<string, AgentToolHandler> = {
  diligence_document_upload_url: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const fileName = uploadFileName(input?.fileName)
    checkDeclaredSize(input?.sizeBytes, MAX_DILIGENCE_DOCUMENT_BYTES)
    const minted = unwrap(await createDiligenceUploadUrl(admin, deal.id, fileName))
    return {
      deal: deal.name,
      ...signedUploadResult({
        signedUrl: minted.signedUrl, storagePath: minted.storagePath, fileName, contentType: input?.contentType,
        maxBytes: MAX_DILIGENCE_DOCUMENT_BYTES,
        next: `After the PUT returns 200, call diligence_add_documents with deal "${deal.name}" and uploaded_files: ` +
          `[{ "storage_path": "${minted.storagePath}", "filename": "${fileName}" }].`,
      }),
    }
  },

  company_document_upload_url: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const company = await resolveCompany(admin, fundId, str(input?.company), access)
    const fileName = uploadFileName(input?.fileName)
    checkDeclaredSize(input?.sizeBytes, MAX_COMPANY_DOCUMENT_BYTES)
    const storagePath = companyDocumentPath(fundId, company.id, fileName)
    return {
      company: company.name,
      ...(await mintSignedUpload(admin, {
        bucket: COMPANY_DOCUMENT_BUCKET, storagePath, fileName, contentType: input?.contentType, maxBytes: MAX_COMPANY_DOCUMENT_BYTES,
        next: `After the PUT returns 200, call add_company_document with company "${company.name}", storage_path "${storagePath}", ` +
          `filename "${fileName}" and size_bytes.`,
      })),
    }
  },

  add_company_document: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const company = await resolveCompany(admin, fundId, str(input?.company), access)
    const filename = uploadFileName(input?.filename)
    const storagePath = str(input?.storage_path)
    let size = Number(input?.size_bytes)
    if (!Number.isFinite(size) || size <= 0) size = await storedSize(admin, COMPANY_DOCUMENT_BUCKET, storagePath)
    if (size > MAX_COMPANY_DOCUMENT_BYTES) throw new Error(`That file is ${mb(size)}; company documents can be up to ${mb(MAX_COMPANY_DOCUMENT_BYTES)}.`)
    const out = unwrap(await registerCompanyDocument(admin, { fundId, userId: requireUser(userId) }, company.id, {
      storagePath,
      filename,
      fileType: str(input?.content_type) || contentTypeFor(filename),
      fileSize: size || null,
      // As the company page: over 10 MB only the extracted text is kept, where there is text.
      textOnly: size > COMPANY_TEXT_ONLY_THRESHOLD,
    }))
    return { company: company.name, filename, added: true, keptAsTextOnly: out.textOnly }
  },

  deals_deck_upload_url: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const fileName = uploadFileName(input?.fileName)
    checkDeclaredSize(input?.sizeBytes, MAX_DEAL_FILE_BYTES)
    const storagePath = stagingPath(fundId, 'deal', fileName)
    return mintSignedUpload(admin, {
      bucket: STAGING_BUCKET, storagePath, fileName, contentType: input?.contentType, maxBytes: MAX_DEAL_FILE_BYTES,
      next: `After the PUT returns 200, call deals_create_inbound with uploaded_files: [{ "storage_path": "${storagePath}", ` +
        `"filename": "${fileName}" }] (up to ${MAX_DEAL_FILES} files).`,
    })
  },

  company_update_upload_url: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const fileName = uploadFileName(input?.fileName)
    checkDeclaredSize(input?.sizeBytes, MAX_STAGED_UPDATE_FILE_BYTES)
    const storagePath = stagingPath(fundId, 'update', fileName)
    return mintSignedUpload(admin, {
      bucket: STAGING_BUCKET, storagePath, fileName, contentType: input?.contentType, maxBytes: MAX_STAGED_UPDATE_FILE_BYTES,
      next: `After the PUT returns 200, call submit_company_update with uploaded_files: [{ "storage_path": "${storagePath}", ` +
        `"filename": "${fileName}" }] (up to ${MAX_UPDATE_FILES} files), naming the company if you know it.`,
    })
  },

  email_attachment_upload_url: async (ctx: AgentToolContext, input: any) => {
    const email = await resolveEmail(ctx, input)
    const fileName = uploadFileName(input?.fileName)
    checkDeclaredSize(input?.sizeBytes, MAX_EMAIL_ATTACHMENT_BYTES)
    const storagePath = emailAttachmentPath(email.id, fileName)
    return {
      email: email.id,
      subject: email.subject,
      ...(await mintSignedUpload(ctx.admin, {
        bucket: EMAIL_ATTACHMENT_BUCKET, storagePath, fileName, contentType: input?.contentType, maxBytes: MAX_EMAIL_ATTACHMENT_BYTES,
        next: `After the PUT returns 200, call add_email_attachment with email "${email.id}", storage_path "${storagePath}" and filename "${fileName}".`,
      })),
    }
  },

  add_email_attachment: async (ctx: AgentToolContext, input: any) => {
    const email = await resolveEmail(ctx, input)
    const filename = uploadFileName(input?.filename)
    const storagePath = str(input?.storage_path)
    let size = Number(input?.size_bytes)
    if (!Number.isFinite(size) || size <= 0) size = await storedSize(ctx.admin, EMAIL_ATTACHMENT_BUCKET, storagePath)
    unwrap(await registerEmailAttachment(ctx.admin, ctx.fundId, email.id, {
      filename, contentType: str(input?.content_type) || contentTypeFor(filename), contentLength: size, storagePath,
    }))
    return { email: email.id, subject: email.subject, attached: filename }
  },

  lp_document_upload_url: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    // Admin-only like the route. It runs directly from a chat (no staging), so the role is checked here.
    const denied = adminOnlyDenial(access.role, 'upload an LP document')
    if (denied) throw new Error(denied)
    const fileName = uploadFileName(input?.fileName)
    checkDeclaredSize(input?.sizeBytes, MAX_LP_DOCUMENT_BYTES)
    const minted = unwrap(await createLpDocumentUploadUrl(admin, fundId, fileName))
    return signedUploadResult({
      signedUrl: minted.signedUrl, storagePath: minted.storagePath, fileName, contentType: input?.contentType,
      maxBytes: MAX_LP_DOCUMENT_BYTES,
      next: `After the PUT returns 200, call lp_add_document with storage_path "${minted.storagePath}", file_name "${fileName}", ` +
        'a title, and who sees it (scope fund, investor with investors, or vehicle).',
    })
  },

  lp_add_document: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const denied = adminOnlyDenial(access.role, 'publish an LP document')
    if (denied) throw new Error(denied)
    const fileName = uploadFileName(input?.file_name)
    const scope = input?.scope === 'investor' || input?.scope === 'vehicle' ? input.scope : 'fund'
    const refs: unknown[] = Array.isArray(input?.investors) ? input.investors : []
    const investors = scope === 'investor' ? await Promise.all(refs.map(r => resolveInvestor(admin, fundId, String(r ?? '')))) : []
    const out = unwrap(await recordLpDocument(admin, { fundId, userId: requireUser(userId) }, {
      title: input?.title,
      file_name: fileName,
      storage_path: input?.storage_path,
      mime_type: str(input?.mime_type) || contentTypeFor(fileName),
      size_bytes: Number.isFinite(Number(input?.size_bytes)) && Number(input?.size_bytes) > 0 ? Number(input.size_bytes) : null,
      scope,
      lp_investor_ids: investors.map(i => i.id),
      vehicle: input?.vehicle,
      category: input?.category,
      doc_date: typeof input?.doc_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.doc_date) ? input.doc_date : null,
      index: input?.index === false ? false : undefined,
    }))
    return {
      documentId: out.id,
      title: str(input?.title),
      sharedWith: scope === 'fund' ? 'every LP' : scope === 'vehicle' ? `investors in ${str(input?.vehicle)}` : investors.map(i => i.name),
    }
  },
}
