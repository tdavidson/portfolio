import yaml from 'js-yaml'
import { memoRevisionTitle, ROUND_CHANGES_SECTION_ID, withRoundChangesFirst } from '@/lib/diligence/rounds'
import type { MemoDraftOutput } from '@/lib/memo-agent/stages/draft'
import type { DimensionScore } from '@/lib/memo-agent/stages/score'
import { SCORE_TABLE_HEADERS, confidenceLabel, dimensionLabel, scoreLabel } from './scores-table'
import { buildSourceLabels, type SourceLabel, type SourceLabelInput } from './source-labels'

export interface RenderInput {
  memo: MemoDraftOutput & { scores?: DimensionScore[] }
  memoOutputYaml: string
  rubricYaml: string
  isDraft: boolean
  dealName: string
  draftVersion: string
  /** Partner-defined section order/titles (incl. custom sections). Overrides the schema order when set. */
  sectionConfig?: Array<{ id: string; title: string; included?: boolean }>
  /**
   * Resolves each citation to the data-room document (or research source) behind it.
   * Omit and the appendix falls back to raw `type:id` — readable, but not checkable.
   */
  sources?: SourceLabelInput
}

const SECTION_FALLBACK_ORDER = [
  'header',
  'executive_summary',
  'recommendation',
  'company_overview',
  'product',
  'market',
  'traction',
  'business_model',
  'team',
  'competition_moat',
  'outcomes_analysis',
  'deal_terms',
  'risks_and_open_questions',
  'scoring_summary',
  'appendix',
  // Backward-compat: legacy schemas used 'product_technology' instead of 'product'.
  // Keep it in the fallback order so older drafts render in roughly the same slot.
  'product_technology',
]

/**
 * Markdown render of a memo draft.
 *
 * Conforms to memo_output.yaml's section order. Each prose paragraph carries
 * inline citation markers (`[1][2]…`) that resolve to the appendix citation
 * map at the bottom of the doc. Projections and unverified claims are
 * marked inline (`[projection]`, `⚠ unverified`).
 */
export function renderMarkdown(input: RenderInput): string {
  const sections = parseSections(input.memoOutputYaml)
  const sectionMeta = new Map(sections.map(s => [s.id, s]))

  // Section order + titles: partner section config when present (authoritative,
  // incl. custom + renamed sections), else the schema order. The structured tail
  // (scoring_summary, appendix) is always appended.
  let baseOrder: string[]
  if (input.sectionConfig && input.sectionConfig.length > 0) {
    const included = input.sectionConfig.filter(s => s.included !== false)
    baseOrder = included.map(s => s.id)
    for (const s of included) {
      const meta = sectionMeta.get(s.id)
      sectionMeta.set(s.id, { id: s.id, title: s.title || meta?.title || s.id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), kind: meta?.kind ?? 'prose' })
    }
    for (const tail of ['scoring_summary', 'appendix']) {
      if (!baseOrder.includes(tail) && sectionMeta.has(tail)) baseOrder.push(tail)
    }
  } else {
    baseOrder = sections.length ? sections.map(s => s.id) : SECTION_FALLBACK_ORDER
  }

  // Append section_ids from paragraphs that aren't in baseOrder so no content is hidden.
  const paragraphSectionIds = Array.from(new Set(input.memo.paragraphs.map(p => p.section_id)))
  const extras = paragraphSectionIds.filter(id => !baseOrder.includes(id))
  // A later diligence round's "What changed since Round N" opens the memo.
  const sectionOrder = withRoundChangesFirst([...baseOrder, ...extras])
  const revisionTitle = memoRevisionTitle(input.memo)
  if (revisionTitle && sectionOrder.includes(ROUND_CHANGES_SECTION_ID)) {
    sectionMeta.set(ROUND_CHANGES_SECTION_ID, { id: ROUND_CHANGES_SECTION_ID, title: revisionTitle, kind: 'prose' })
  }
  // Fill in fallback meta for any section id in the order that the parsed
  // YAML didn't define — keeps render output non-empty when the schema is
  // missing or stale.
  for (const id of sectionOrder) {
    if (!sectionMeta.has(id)) {
      sectionMeta.set(id, { id, title: id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), kind: id === 'scoring_summary' || id === 'appendix' ? 'structured' : 'prose' })
    }
  }

  // Group paragraphs by section.
  const paragraphsBySection = new Map<string, typeof input.memo.paragraphs>()
  for (const p of input.memo.paragraphs) {
    if (!paragraphsBySection.has(p.section_id)) paragraphsBySection.set(p.section_id, [])
    paragraphsBySection.get(p.section_id)!.push(p)
  }

  const sourceLabels = buildSourceLabels(input.sources ?? {})

  // Build a stable citation key list as we walk paragraphs in order.
  const citationKeys: string[] = []
  function citeNumber(sourceType: string, sourceId: string): number {
    const key = `${sourceType}:${sourceId}`
    const idx = citationKeys.indexOf(key)
    if (idx >= 0) return idx + 1
    citationKeys.push(key)
    return citationKeys.length
  }

  const lines: string[] = []

  if (input.isDraft) lines.push('# DRAFT — not finalized', '')

  // Header
  const header = input.memo.header ?? {}
  lines.push(`# ${header.company_name ?? input.dealName}`)
  const headerBits: string[] = []
  if (header.sector) headerBits.push(header.sector)
  if (header.stage) headerBits.push(header.stage)
  if (header.round_size) headerBits.push(header.round_size)
  if (headerBits.length) lines.push(`*${headerBits.join(' · ')}*`)
  lines.push('')
  if (header.deal_lead) lines.push(`Deal lead: ${header.deal_lead}`)
  else lines.push('Deal lead: *[Partner to complete]*')
  if (header.memo_date) lines.push(`Date: ${header.memo_date}`)
  lines.push(`Version: ${input.draftVersion} · Agent: ${header.agent_version ?? 'memo-agent v0.1'}`)
  lines.push('')

  for (const sectionId of sectionOrder) {
    if (sectionId === 'header') continue
    const meta = sectionMeta.get(sectionId)
    if (!meta) continue

    if (meta.kind === 'structured' && sectionId === 'scoring_summary') {
      lines.push(`## ${meta.title}`)
      lines.push('')
      lines.push(...renderScoresMarkdown(input.memo.scores ?? []))
      lines.push('')
      continue
    }
    if (meta.kind === 'structured' && sectionId === 'appendix') {
      lines.push(`## ${meta.title}`)
      lines.push('')
      lines.push(...renderCitations(citationKeys, sourceLabels))
      lines.push('')
      continue
    }

    // Partner-hidden paragraphs are excluded from the render.
    const paragraphs = (paragraphsBySection.get(sectionId) ?? []).filter(p => !p.hidden)
    if (paragraphs.length === 0) continue

    lines.push(`## ${meta.title}`)
    lines.push('')

    paragraphs
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach(p => {
        // Inline markers
        const markers: string[] = []
        if (p.contains_projection) markers.push('[projection]')
        if (p.contains_unverified_claim) markers.push('⚠ unverified')
        if (p.contains_contradiction) markers.push('†contradiction')
        const markerSuffix = markers.length ? ` *${markers.join(' · ')}*` : ''

        let prose = p.prose
        if (p.origin === 'partner_only_placeholder') {
          prose = `*${prose}*`
        }

        // Citation footnotes
        const citationNumbers = (p.sources ?? [])
          .filter(s => s.source_type !== 'partner_only')
          .map(s => citeNumber(s.source_type, s.source_id))
        const cites = citationNumbers.length ? ' ' + citationNumbers.map(n => `[${n}]`).join('') : ''

        lines.push(`${prose}${cites}${markerSuffix}`)
        lines.push('')
      })
  }

  return lines.join('\n')
}

function renderScoresMarkdown(scores: DimensionScore[]): string[] {
  if (scores.length === 0) return ['*No scores yet.*']
  const lines: string[] = []
  lines.push(`| ${SCORE_TABLE_HEADERS.join(' | ')} |`)
  lines.push('|---|:-:|---|---|')
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
  for (const s of scores) {
    lines.push(`| ${cell(dimensionLabel(s.dimension_id))} | ${scoreLabel(s)} | ${confidenceLabel(s.confidence)} | ${cell(s.rationale ?? '')} |`)
  }
  return lines
}

function renderCitations(keys: string[], labels: Map<string, SourceLabel>): string[] {
  if (keys.length === 0) return ['*No citations.*']
  const lines: string[] = []
  keys.forEach((key, i) => {
    const [type, ...rest] = key.split(':')
    const id = rest.join(':')
    const hit = labels.get(key)
    // Name the data-room document the claim came from. A bare `claim:c_4f2a` is not a
    // citation — a reader can't check it. The id still rides along in code font so a
    // claim can be traced back to the ingestion output when someone needs to.
    if (hit) {
      const detail = hit.detail ? ` — ${hit.detail}` : ''
      const link = hit.url ? ` (<${hit.url}>)` : ''
      lines.push(`${i + 1}. **${hit.label}**${detail}${link} · \`${type}:${id}\``)
    } else {
      lines.push(`${i + 1}. **${type}** — \`${id}\``)
    }
  })
  return lines
}

interface SectionMeta { id: string; title: string; kind?: string }
function parseSections(yamlText: string): SectionMeta[] {
  try {
    const parsed = yaml.load(yamlText) as any
    const sections = parsed?.memo_structure?.sections
    if (!Array.isArray(sections)) return []
    return sections.map((s: any) => ({ id: s.id, title: s.title ?? s.id, kind: s.kind }))
  } catch {
    return []
  }
}
