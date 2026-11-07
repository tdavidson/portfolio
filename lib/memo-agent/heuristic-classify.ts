/**
 * Heuristic document classification — fast, conservative, low-confidence.
 *
 * Used on upload to give documents an initial detected_type before the agent's
 * Stage 1 ingestion runs (which produces the authoritative classification).
 *
 * Output type names mirror data_room_ingestion.yaml document_types.
 */

export type DocumentType =
  | 'pitch_deck'
  | 'financial_model'
  | 'cap_table'
  | 'data_room_summary'
  | 'memo'
  | 'product_overview'
  | 'customer_references'
  | 'sales'
  | 'legal'
  | 'market_research'
  | 'team_bio'
  | 'org_chart'
  | 'press'
  | 'industry_expert'
  | 'call_recording'
  | 'call_transcript'
  | 'other'

export type Confidence = 'low' | 'medium' | 'high'

export interface HeuristicResult {
  detected_type: DocumentType
  confidence: Confidence
}

const DECK_KEYWORDS = ['deck', 'pitch', 'presentation', 'slides', 'pitchdeck']
const MODEL_KEYWORDS = ['model', 'financials', 'projections', 'forecast', 'p&l', 'pnl', 'budget']
const CAP_TABLE_KEYWORDS = ['cap table', 'cap_table', 'captable', 'ownership', 'waterfall']
const MEMO_KEYWORDS = ['memo', 'investment memo', 'board memo']
const LEGAL_KEYWORDS = ['saf', 'safe', 'note', 'term sheet', 'termsheet', 'shareholder', 'incorporation', 'articles', 'bylaws']
const MARKET_KEYWORDS = ['market', 'tam', 'industry', 'analyst report', 'gartner']
// Org chart: reporting lines and headcount by function. Checked before deck,
// model and team keywords so "org chart.pptx" or "team org chart.pdf" is not
// filed as a pitch deck, financial model or team bio.
// Matches org chart, org_chart, orgchart, organization chart, organisational-chart, etc.
const ORG_CHART_PATTERN = /(?:^|[^a-z])org(?:ani[sz]ation(?:al)?)?[\s_-]?chart/
const TEAM_KEYWORDS = ['bio', 'biography', 'resume', 'cv', 'team', 'founder']
const PRESS_KEYWORDS = ['press', 'announcement', 'launch', 'feature', 'article']
const PRODUCT_KEYWORDS = ['product', 'overview', 'spec', 'roadmap']
const REFERENCES_KEYWORDS = ['reference', 'testimonial', 'case study', 'casestudy']
// Sales: customer contracts and commercial/GTM material. Kept distinct from
// `customer_references` (proof points) and `legal` (corporate/financing docs).
const SALES_KEYWORDS = [
  'sales', 'contract', 'customer contract', 'order form', 'orderform', 'msa',
  'master service', 'master services', 'sow', 'statement of work', 'purchase order',
  'pricing', 'price list', 'quote', 'quotation', 'invoice', 'loi', 'letter of intent',
  'subscription agreement', 'customer agreement', 'sales agreement', 'pipeline', 'bookings',
]
const EXPERT_KEYWORDS = ['expert call', 'expert network', 'industry expert', 'tegus', 'alphasights', 'glg']

function hasKeyword(name: string, words: string[]): boolean {
  const lower = name.toLowerCase()
  return words.some(w => lower.includes(w))
}

function ext(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'flac', 'opus'])
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv'])
const TRANSCRIPT_EXTS = new Set(['vtt', 'srt'])

export function classifyDocumentHeuristic(filename: string, contentType?: string): HeuristicResult {
  const lower = filename.toLowerCase()
  const e = ext(filename)

  // Audio / video recordings → transcribe job, not ingest. Confidence is
  // "high" on extension match because the file format is unambiguous.
  if (AUDIO_EXTS.has(e) || VIDEO_EXTS.has(e) || contentType?.startsWith('audio/') || contentType?.startsWith('video/')) {
    return { detected_type: 'call_recording', confidence: 'high' }
  }

  // Pre-made transcript formats (Zoom-saved .vtt, Meet caption .srt export).
  if (TRANSCRIPT_EXTS.has(e) || contentType === 'text/vtt' || contentType === 'application/x-subrip') {
    return { detected_type: 'call_transcript', confidence: 'high' }
  }

  // An org chart can arrive as a sheet, slide, PDF or image, so match it by
  // name before the format-based guesses below.
  if (ORG_CHART_PATTERN.test(lower)) return { detected_type: 'org_chart', confidence: 'medium' }

  // Excel / sheets — almost always financial model or cap table.
  if (e === 'xlsx' || e === 'xls' || e === 'csv' || contentType?.includes('spreadsheetml')) {
    if (hasKeyword(lower, CAP_TABLE_KEYWORDS)) return { detected_type: 'cap_table', confidence: 'medium' }
    return { detected_type: 'financial_model', confidence: 'medium' }
  }

  // PowerPoint / Keynote — almost always a deck.
  if (e === 'pptx' || e === 'ppt' || e === 'key' || contentType?.includes('presentationml')) {
    return { detected_type: 'pitch_deck', confidence: 'medium' }
  }

  // PDF / DOCX — go by filename keywords.
  if (e === 'pdf' || e === 'docx' || e === 'doc' || e === 'md' || e === 'txt') {
    if (hasKeyword(lower, DECK_KEYWORDS)) return { detected_type: 'pitch_deck', confidence: 'medium' }
    if (hasKeyword(lower, CAP_TABLE_KEYWORDS)) return { detected_type: 'cap_table', confidence: 'low' }
    if (hasKeyword(lower, MODEL_KEYWORDS)) return { detected_type: 'financial_model', confidence: 'low' }
    if (hasKeyword(lower, MEMO_KEYWORDS)) return { detected_type: 'memo', confidence: 'medium' }
    // Sales before legal: a "customer contract"/"order form" is commercial, not
    // a corporate/financing legal doc (which match the distinct LEGAL keywords).
    if (hasKeyword(lower, SALES_KEYWORDS)) return { detected_type: 'sales', confidence: 'low' }
    if (hasKeyword(lower, EXPERT_KEYWORDS)) return { detected_type: 'industry_expert', confidence: 'low' }
    if (hasKeyword(lower, LEGAL_KEYWORDS)) return { detected_type: 'legal', confidence: 'low' }
    if (hasKeyword(lower, REFERENCES_KEYWORDS)) return { detected_type: 'customer_references', confidence: 'low' }
    if (hasKeyword(lower, TEAM_KEYWORDS)) return { detected_type: 'team_bio', confidence: 'low' }
    if (hasKeyword(lower, PRESS_KEYWORDS)) return { detected_type: 'press', confidence: 'low' }
    if (hasKeyword(lower, MARKET_KEYWORDS)) return { detected_type: 'market_research', confidence: 'low' }
    if (hasKeyword(lower, PRODUCT_KEYWORDS)) return { detected_type: 'product_overview', confidence: 'low' }
    return { detected_type: 'other', confidence: 'low' }
  }

  // Images / video — probably a screenshot or demo recording.
  return { detected_type: 'other', confidence: 'low' }
}
