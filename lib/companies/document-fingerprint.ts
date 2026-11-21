// What makes two holding documents "the same file": the SHA-256 of their bytes, or the SHA-256 of
// their extracted text after normalising it. The second catches the near-duplicate a byte hash
// misses: the same manager statement re-exported a byte apart, or a renamed copy of a Word file
// whose packaging changed.
//
// The text is read with the Company Updates parser (lib/company-updates/extraction.ts) so an
// uploaded document and an update's attachment of the same file hash alike: that parser is what
// filled `company_update_artifacts.extracted_text`, and it reads PDFs, which the older upload
// extractor leaves to the model.

import { createHash } from 'node:crypto'
import { extractArtifact } from '@/lib/company-updates/extraction'

/** Page and slide labels the parsers add ("[Page 3]", "[Page 3 (OCR)]"): not part of the document. */
const LABEL = /^\s*\[(?:page|slide|sheet)[^\]\n]{0,40}\]\s*$/gim

/**
 * The text as it is compared: labels dropped, Unicode compatibility forms folded, case folded and
 * every run of whitespace one space. Formatting a parser adds or a re-export changes never makes
 * two copies of one document differ.
 */
export function normalizeForHash(text: string): string {
  return text
    .replace(LABEL, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The text hash, or null when there is no text worth comparing (an image, a scan with no text layer). */
export function textSha256(text: string | null | undefined): string | null {
  if (!text) return null
  const normal = normalizeForHash(text)
  // A handful of characters ("page 1") is not a document's content: two different scans would match.
  if (normal.replace(/[^a-z0-9]/g, '').length < 20) return null
  return sha256Hex(normal)
}

export interface Fingerprint {
  sha256: string
  textSha256: string | null
  /** The parser's text, with page labels, for reading. Empty when none could be read. */
  text: string
  pageCount: number | null
  /** False when the file failed the safety scan (its bytes should not be kept). */
  safe: boolean
}

/** Hash a file's bytes and its text. Never throws on an unreadable file: it just has no text hash. */
export async function fingerprintFile(buffer: Buffer, filename: string, contentType: string | null): Promise<Fingerprint> {
  const sha256 = sha256Hex(buffer)
  try {
    const extracted = await extractArtifact({
      filename,
      declaredContentType: contentType ?? '',
      content: buffer.toString('base64'),
    })
    const result = extracted.result
    const pages = Number(result.metadata?.pageCount)
    return {
      sha256,
      textSha256: textSha256(result.text),
      text: result.text ?? '',
      pageCount: Number.isFinite(pages) && pages > 0 ? pages : null,
      safe: result.parser !== 'safety-scan',
    }
  } catch {
    return { sha256, textSha256: null, text: '', pageCount: null, safe: true }
  }
}
