// Handlers for the DOCUMENT TEMPLATE agent tools (document-tools-manifest.ts).
//
// The dispatcher has already checked lp_relations / lp_letters for the caller, and fundId comes
// from the credential, never from input. The download link is re-checked when it is opened
// (app/api/agent/reports/[token]/route.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { linkNote, reportLinkUrl, signReportLink } from '@/lib/agent/report-links'
import { siteOrigin } from '@/lib/site-links'
import { findTemplate, generateDocument, latestRender, listTemplates, saveTemplate } from '@/lib/document-templates/service'

export const DOCUMENT_HANDLERS: Record<string, AgentToolHandler> = {
  document_template_get: async ({ admin, fundId }: AgentToolContext, input: any) => {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (!name) {
      const templates = await listTemplates(admin, fundId)
      return { templates, note: templates.length ? 'Pass a name to get one template, its data shape and its last data.' : 'No document templates yet. Save one with document_template_save.' }
    }
    const t = await findTemplate(admin, fundId, name)
    if (!t) throw new Error(`No document template named "${name}". Call document_template_get with no name to list them.`)
    const last = await latestRender(admin, fundId, t.id)
    return {
      name: t.name, vehicle: t.vehicle, instructions: t.instructions, updated_at: t.updated_at,
      html: t.body_html,
      sample_data: t.sample_data,
      last_generated: last ? { title: last.title, created_at: last.created_at, data: last.data, warnings: last.warnings } : null,
    }
  },

  document_template_save: async ({ admin, fundId, userId }: AgentToolContext, input: any) =>
    saveTemplate(admin, fundId, userId, input ?? {}),

  document_generate: async ({ admin, fundId, userId, origin }: AgentToolContext, input: any) => {
    if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
    const doc = await generateDocument(admin, fundId, userId, input ?? {})
    const { token, expiresAt } = signReportLink({ fundId, userId, kind: 'template_document', args: { render: doc.renderId } })
    return {
      document: doc.title, template: doc.template,
      url: reportLinkUrl(origin ?? siteOrigin(), token),
      expires_at: expiresAt,
      checks_failed: doc.warnings,
      note: linkNote('It opens the PDF for an hour, for this member only. ' +
        (doc.warnings.length ? 'Tell them about every failed check before they send it. ' : '') +
        'To fetch it again later, generate it again rather than re-sharing this link.'),
    }
  },
}
