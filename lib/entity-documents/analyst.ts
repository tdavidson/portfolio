import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { visibleVehicleIds } from '@/lib/access/scope'
import type { ToolDefinition } from '@/lib/ai/types'
import { KIND_LABELS, getDocument, listDocuments, searchDocuments, textWindow, type DocumentKind } from './index'

// The Analyst's view of entity governing documents. Available to anyone who can see an entity —
// governing documents follow entity access, not a domain grant (plans/spec-entity-documents.md) —
// so this is a built-in Analyst tool rather than a registry tool, which is gated on one domain.

export const ENTITY_DOCUMENTS_TOOL: ToolDefinition = {
  name: 'entity_documents',
  description:
    "An entity's governing documents — LPA, operating agreement, side letters, amendments. " +
    'action "list": the documents (optionally for one entity). ' +
    'action "search": find passages by words (e.g. "management fee", "investment period", "recycling"); returns excerpts with page numbers. ' +
    'action "read": read a document\'s text from an offset, to quote a clause in full or page through. ' +
    'Cite the document title and page for every term you state.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'search', 'read'] },
      entity: { type: 'string', description: 'Optional: the entity (fund/SPV) name. Defaults to the entity in view, else all of yours.' },
      query: { type: 'string', description: 'search: the words to find.' },
      document_id: { type: 'string', description: 'read: the document id (from list or search).' },
      offset: { type: 'number', description: 'read: character offset to start from (default 0).' },
      max_chars: { type: 'number', description: 'read: how much to return (default 12000, max 30000).' },
    },
  },
}

export interface EntityDocumentsDeps {
  admin: SupabaseClient
  fundId: string
  access: AccessContext
  /** The entity the Analyst is opened on, if any (a name). */
  defaultEntity?: string | null
}

/**
 * An entity the caller can see, by name or alias (case-insensitive) — any kind, the management
 * company included: its operating agreement is a governing document like any other, and documents
 * follow entity access. Throws, naming only the caller's entities, when there is no match.
 */
export async function resolveDocumentEntity(
  admin: SupabaseClient, fundId: string, access: AccessContext, name: string,
): Promise<{ id: string; name: string }> {
  const { data } = await (admin as any).from('fund_vehicles').select('id, name, aliases').eq('fund_id', fundId)
  const visible = visibleVehicleIds(access)
  const mine = ((data as any[]) ?? []).filter(v => visible === null || visible.includes(v.id))
  const wanted = name.trim().toLowerCase()
  const hit = mine.find(v => v.name.toLowerCase() === wanted)
    ?? mine.find(v => ((v.aliases as string[] | null) ?? []).some(a => a.toLowerCase() === wanted))
  if (!hit) throw new Error(`Unknown entity "${name}". Yours: ${mine.map(v => v.name).sort().join(', ') || 'none'}`)
  return { id: hit.id, name: hit.name }
}

/** The entities a call covers: the one named (or in view), else every entity the caller can see. */
async function entitiesFor(deps: EntityDocumentsDeps, entity: unknown): Promise<string[]> {
  const named = typeof entity === 'string' && entity.trim() ? entity : deps.defaultEntity ?? null
  if (named) return [(await resolveDocumentEntity(deps.admin, deps.fundId, deps.access, named)).id]
  const ids = visibleVehicleIds(deps.access)
  if (ids !== null) return ids
  const { data } = await (deps.admin as any).from('fund_vehicles').select('id').eq('fund_id', deps.fundId)
  return ((data as any[]) ?? []).map(v => v.id as string)
}

export async function runEntityDocumentsTool(deps: EntityDocumentsDeps, input: any): Promise<unknown> {
  const action = input?.action
  if (action === 'read') {
    const ids = await entitiesFor(deps, input?.entity ?? null)
    // A document id from another call may belong to any of the caller's entities, not only the one in view.
    const visible = input?.entity ? ids : (visibleVehicleIds(deps.access) ?? null)
    const doc = typeof input?.document_id === 'string' ? await getDocument(deps.admin, deps.fundId, input.document_id, visible) : null
    if (!doc) return { error: 'No such document among your entities.' }
    if (!doc.extracted_text) {
      return { error: doc.ocr_status === 'pending'
        ? 'This document is a scan still being read; try again in a few minutes.'
        : 'No text could be read from this document.' }
    }
    const max = Math.min(Math.max(Number(input?.max_chars) || 12_000, 500), 30_000)
    return {
      document: { id: doc.id, title: doc.title, kind: KIND_LABELS[doc.kind as DocumentKind] ?? doc.kind, effective_date: doc.effective_date },
      ...textWindow(doc.extracted_text, Number(input?.offset) || 0, max),
      note: 'Page markers like [Page 12] show where each page starts.',
    }
  }

  const ids = await entitiesFor(deps, input?.entity ?? null)
  if (action === 'search') {
    const query = typeof input?.query === 'string' ? input.query : ''
    if (!query.trim()) return { error: 'search needs a query' }
    const hits = await searchDocuments(deps.admin, deps.fundId, ids, query, 8)
    return {
      results: hits.map(h => ({
        document_id: h.document_id,
        title: h.title,
        kind: KIND_LABELS[h.kind as DocumentKind] ?? h.kind,
        page: h.locator.page ?? null,
        excerpt: h.excerpt,
      })),
      note: hits.length ? 'Matches are marked [[like this]]. Read the document around a match before relying on it.' : 'No matching passages.',
    }
  }

  const docs = await listDocuments(deps.admin, deps.fundId, ids)
  return {
    documents: docs.map(d => ({
      id: d.id,
      title: d.title,
      kind: KIND_LABELS[d.kind] ?? d.kind,
      effective_date: d.effective_date,
      pages: d.page_count,
      readable: d.extraction_status === 'complete' || d.extraction_status === 'partial'
        ? true
        : d.ocr_status === 'pending' ? 'scan being read' : false,
    })),
  }
}

/** How to review an entity's books against its governing documents — appended when the Analyst is on an entity. */
export const GOVERNING_DOCUMENTS_GUIDE = `You can read this entity's governing documents with the entity_documents tool (list, search, read).

Answering questions about terms: search for the term, then read the passage around the best match. Quote or closely paraphrase the clause and cite the document and page. If side letters or amendments exist, check whether they change the term, and say which governs. If the documents do not address it, say so.

Reviewing compliance with the LPA (when asked): work through the terms that matter — management fee (rate, basis, step-downs, offsets), investment period and what may be done after it, fund term and extensions, concentration or diversification limits, recycling, GP commitment, organizational expense caps, carry and hurdle. For each: state the term with its citation; compare it with the entity's figures from the books in this conversation (fees charged, commitments and called capital, cost per company, investment dates, distributions); then give a finding — consistent, possible issue, or can't tell. Never invent a figure: when the books here don't show one, say what data would settle it. Keep it to a short table of findings followed by the issues worth raising.`
