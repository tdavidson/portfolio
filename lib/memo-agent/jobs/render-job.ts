import { loadDesignTemplate } from '@/lib/memo-agent/design'
import { effectiveSections } from '@/lib/memo-agent/design-sections'
import { renderWithDesign } from '@/lib/memo-agent/render/design-template'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveSchema, ensureDefaults } from '@/lib/memo-agent/firm-schemas'
import { renderMarkdown } from '@/lib/memo-agent/render/markdown'
import { designMemoInput, renderDocx } from '@/lib/memo-agent/render/docx'
import { docxToPdfViaDrive, uploadDocxToDrive } from '@/lib/memo-agent/render/gdoc'
import { parseDriveFolderUrl } from '@/lib/google/drive'

type Admin = ReturnType<typeof createAdminClient>

export type RenderFormat = 'markdown' | 'docx' | 'gdoc'

interface RenderJob {
  id: string
  fund_id: string
  deal_id: string
  draft_id: string | null
  payload: Record<string, unknown>
}

/**
 * Render a draft to one of the three target formats. The job result includes
 * either inline content (markdown) or a download/view URL (docx, gdoc). The
 * draft itself is not modified.
 */
export async function runRenderJob(admin: Admin, job: RenderJob): Promise<unknown> {
  const format = (job.payload?.format as string) ?? 'markdown'
  if (!['markdown', 'docx', 'gdoc', 'pdf'].includes(format)) {
    throw new Error(`Unsupported render format: ${format}`)
  }

  const draftId = job.draft_id ?? (typeof job.payload?.draft_id === 'string' ? (job.payload.draft_id as string) : null)
  if (!draftId) throw new Error('draft_id required for render job')

  // ingestion_output / research_output ride along so the citation appendix can name the
  // data-room document behind each claim instead of printing a bare claim id.
  const { data: draft } = await admin
    .from('diligence_memo_drafts')
    .select('id, draft_version, is_draft, memo_draft_output, ingestion_output, research_output, qa_answers')
    .eq('id', draftId)
    .eq('fund_id', job.fund_id)
    .maybeSingle()
  if (!draft) throw new Error('Draft not found')
  if (!(draft as any).memo_draft_output) throw new Error('Draft has no memo_draft_output — run Stage 4 first.')

  const { data: docRows } = await admin
    .from('diligence_documents')
    .select('id, file_name')
    .eq('deal_id', job.deal_id)
    .eq('fund_id', job.fund_id)
  const sources = {
    ingestion: (draft as any).ingestion_output ?? null,
    research: (draft as any).research_output ?? null,
    qa: (draft as any).qa_answers ?? null,
    documentNames: Object.fromEntries(
      ((docRows as any[]) ?? []).map(d => [d.id as string, (d.file_name ?? '') as string])
    ),
  }

  const { data: deal } = await admin
    .from('diligence_deals')
    .select('name, drive_folder_url, memo_template_config')
    .eq('id', job.deal_id)
    .eq('fund_id', job.fund_id)
    .maybeSingle()
  const dealName = (deal as { name: string } | null)?.name ?? 'Untitled deal'
  const dealDriveFolderUrl = (deal as { drive_folder_url: string | null } | null)?.drive_folder_url ?? null
  // Partner-defined section order/titles (incl. custom sections) override the
  // schema's section list in the export, matching the editor.
  const templateConfig = (deal as any)?.memo_template_config ?? {}
  // With none of its own, the fund design template's headings (the same list the draft was written to).
  const sectionConfig = await effectiveSections(
    admin as any, job.fund_id,
    Array.isArray(templateConfig?.sections) ? (templateConfig.sections as Array<{ id: string; title: string; included?: boolean }>) : undefined,
  ) as Array<{ id: string; title: string; included?: boolean }> | undefined

  // Fund-configurable export formatting.
  const { data: settings } = await admin
    .from('fund_settings')
    .select('memo_export_font_family, memo_export_font_size')
    .eq('fund_id', job.fund_id)
    .maybeSingle()
  const fontFamily = (settings as any)?.memo_export_font_family as string | null
  const fontSize = (settings as any)?.memo_export_font_size as number | null

  // Seed-on-demand so a fund that never visited the Schemas editor still
  // gets a non-empty memo_output schema. Without this the renderer's
  // sectionMeta map is empty and every section gets skipped — the symptom
  // is a docx with only the header and no body content.
  await ensureDefaults(job.fund_id, admin)
  const memoOutputSchema = await getActiveSchema(job.fund_id, 'memo_output', admin)
  const rubricSchema = await getActiveSchema(job.fund_id, 'rubric', admin)

  const renderInput = {
    memo: (draft as any).memo_draft_output,
    memoOutputYaml: memoOutputSchema?.yaml_content ?? '',
    rubricYaml: rubricSchema?.yaml_content ?? '',
    isDraft: !!(draft as any).is_draft,
    dealName,
    draftVersion: (draft as any).draft_version,
    fontFamily: fontFamily ?? undefined,
    fontSize: fontSize ?? undefined,
    sectionConfig,
    sources,
  }

  if (format === 'markdown') {
    const md = renderMarkdown(renderInput)
    return { format, content: md, length: md.length }
  }

  // Build docx for both docx and gdoc. With the fund's design template (one of its own sample memos),
  // the memo is written into that file so it looks like the fund's memos; otherwise the generic layout.
  const template = await loadDesignTemplate(admin as any, job.fund_id)
  let design: 'fund_template' | 'generic' = 'generic'
  let designNote: string | null = template.status === 'unusable' ? template.reason : null
  let buffer: Buffer
  if (template.status === 'ready') {
    try {
      buffer = await renderWithDesign(template.bytes, designMemoInput(renderInput))
      design = 'fund_template'
    } catch (err) {
      designNote = `The design template could not be used (${err instanceof Error ? err.message : String(err)}), so the standard layout was used.`
      buffer = await renderDocx(renderInput)
    }
  } else {
    buffer = await renderDocx(renderInput)
  }
  const safeDealName = dealName.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80)
  const filename = `${safeDealName} memo (${(draft as any).draft_version}).docx`

  if (format === 'pdf') {
    // Converted by Google Drive, so the PDF keeps the Word file's (and the fund template's) design.
    const pdf = await docxToPdfViaDrive({ admin: admin as any, fundId: job.fund_id, filename, buffer })
    const pdfName = filename.replace(/\.docx$/, '.pdf')
    const storagePath = `${job.deal_id}/renders/${Date.now()}_${pdfName}`
    const { error: uploadErr } = await admin.storage
      .from('diligence-documents')
      .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)
    const { data: signed, error: signErr } = await admin.storage.from('diligence-documents').createSignedUrl(storagePath, 60 * 60 * 24)
    if (signErr) throw new Error(`Signed URL failed: ${signErr.message}`)
    return { format, filename: pdfName, download_url: signed?.signedUrl ?? null, storage_path: storagePath, bytes: pdf.length, design, design_note: designNote }
  }

  if (format === 'docx') {
    const storagePath = `${job.deal_id}/renders/${Date.now()}_${filename}`
    const { error: uploadErr } = await admin.storage
      .from('diligence-documents')
      .upload(storagePath, buffer, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', upsert: true })
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    // Signed URL for partner download — expires in 24h.
    const { data: signed, error: signErr } = await admin.storage
      .from('diligence-documents')
      .createSignedUrl(storagePath, 60 * 60 * 24)
    if (signErr) throw new Error(`Signed URL failed: ${signErr.message}`)
    return {
      format,
      filename,
      download_url: signed?.signedUrl ?? null,
      storage_path: storagePath,
      bytes: buffer.length,
      design,
      design_note: designNote,
    }
  }

  // gdoc: upload + convert to Google Doc. Prefer the deal's own data-room
  // folder when one is configured, so the memo lands alongside the deal's
  // documents instead of the fund's default portfolio-reports folder.
  const dealFolderId = dealDriveFolderUrl ? parseDriveFolderUrl(dealDriveFolderUrl) : null
  const result = await uploadDocxToDrive({
    admin,
    fundId: job.fund_id,
    filename,
    buffer,
    folderIdOverride: dealFolderId,
  })
  return {
    format,
    filename,
    drive_file_id: result.fileId,
    web_view_link: result.webViewLink,
    destination: dealFolderId ? 'deal_data_room' : 'fund_default_folder',
    bytes: buffer.length,
    design,
    design_note: designNote,
  }
}
