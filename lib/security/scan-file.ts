import JSZip from 'jszip'

export interface ScanResult {
  safe: boolean
  reason?: string
}

// Aligned with the diligence-documents storage bucket (100 MB) so anything that
// can be uploaded can also be scanned + parsed; below this the scan is not the
// bottleneck. Zip-bomb expansion is bounded separately (MAX_ZIP_UNCOMPRESSED).
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'ps1', 'dll', 'so', 'msi',
  'com', 'scr', 'vbs', 'js', 'jar', 'py', 'rb',
])

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

// Magic byte signatures for executable detection
const EXECUTABLE_SIGNATURES: Array<{ bytes: number[]; name: string }> = [
  { bytes: [0x7f, 0x45, 0x4c, 0x46], name: 'ELF executable' },      // \x7fELF
  { bytes: [0x4d, 0x5a], name: 'PE/EXE executable' },                // MZ
  { bytes: [0xfe, 0xed, 0xfa, 0xce], name: 'Mach-O executable' },    // 32-bit
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], name: 'Mach-O executable' },    // 64-bit
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], name: 'Mach-O executable' },    // reverse byte order
  { bytes: [0xce, 0xfa, 0xed, 0xfe], name: 'Mach-O executable' },    // reverse 32-bit
  { bytes: [0x23, 0x21], name: 'Script with shebang' },              // #!
  { bytes: [0xca, 0xfe, 0xba, 0xbe], name: 'Java class file' },      // CAFEBABE
]

// Expected magic bytes for known content types
const MAGIC_BYTE_MAP: Record<string, { bytes: number[]; offset?: number }> = {
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46] },                    // %PDF
  'image/png':       { bytes: [0x89, 0x50, 0x4e, 0x47] },                    // \x89PNG
  'image/jpeg':      { bytes: [0xff, 0xd8, 0xff] },                          // \xFF\xD8\xFF
  'image/gif':       { bytes: [0x47, 0x49, 0x46, 0x38] },                    // GIF8
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':      { bytes: [0x50, 0x4b, 0x03, 0x04] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':            { bytes: [0x50, 0x4b, 0x03, 0x04] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':    { bytes: [0x50, 0x4b, 0x03, 0x04] },
  'application/zip': { bytes: [0x50, 0x4b, 0x03, 0x04] },                    // PK\x03\x04
}

// Content types that are ZIP-based (need zip bomb detection)
const ZIP_BASED_TYPES = new Set([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const MAX_ZIP_UNCOMPRESSED = 500 * 1024 * 1024 // 500 MB
const MAX_ZIP_RATIO = 100
const MAX_ZIP_ENTRIES = 1000

export function scanFile(buffer: Buffer, filename: string, contentType: string): ScanResult {
  // 1. File size check
  if (buffer.length > MAX_FILE_SIZE) {
    return { safe: false, reason: `File too large: ${Math.round(buffer.length / 1024 / 1024)}MB exceeds ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB limit` }
  }

  // 2. Dangerous extensions (including double-extension like report.pdf.exe)
  const parts = filename.toLowerCase().split('.')
  for (let i = 1; i < parts.length; i++) {
    if (DANGEROUS_EXTENSIONS.has(parts[i])) {
      return { safe: false, reason: `Dangerous file extension: .${parts[i]}` }
    }
  }

  // 3. Executable magic bytes
  for (const sig of EXECUTABLE_SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
      return { safe: false, reason: `Executable content detected: ${sig.name}` }
    }
  }

  // 4. Magic byte vs claimed content type
  const expected = MAGIC_BYTE_MAP[contentType]
  if (expected && buffer.length >= expected.bytes.length) {
    const offset = expected.offset ?? 0
    const matches = expected.bytes.every((b, i) => buffer[offset + i] === b)
    if (!matches) {
      return { safe: false, reason: `File content does not match declared type ${contentType}` }
    }
  }

  // 5. Zip bomb detection (synchronous check not possible with JSZip — handled separately)
  // This is checked asynchronously via scanFileAsync for ZIP-based types

  // 6. EICAR test pattern
  const head = buffer.subarray(0, 256).toString('ascii')
  if (head.includes(EICAR)) {
    return { safe: false, reason: 'EICAR test pattern detected' }
  }

  return { safe: true }
}

/**
 * Async version that also checks for zip bombs on ZIP-based files.
 * Use this when you need the full scan including zip bomb detection.
 */
export async function scanFileAsync(buffer: Buffer, filename: string, contentType: string): Promise<ScanResult> {
  // Run all synchronous checks first
  const syncResult = scanFile(buffer, filename, contentType)
  if (!syncResult.safe) return syncResult

  // Zip bomb detection for ZIP-based content types
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  // By the bytes too: the parsers dispatch on the declared type, and .xls/.doc/.ppt routes open a
  // zip container just as happily — so an xlsx bomb named a.xls skipped this check by its name alone.
  const startsLikeZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
  const isZipBased = startsLikeZip || ZIP_BASED_TYPES.has(contentType) ||
    ['zip', 'docx', 'xlsx', 'pptx'].includes(ext)

  if (isZipBased && buffer.length > 0) {
    try {
      const zip = await JSZip.loadAsync(buffer)
      const entries = Object.keys(zip.files)

      if (entries.length > MAX_ZIP_ENTRIES) {
        return { safe: false, reason: `ZIP has too many entries: ${entries.length} (max ${MAX_ZIP_ENTRIES})` }
      }

      let totalUncompressed = 0
      for (const entry of entries) {
        const file = zip.files[entry]
        if (!file.dir) {
          // _data contains compression info; use it to estimate uncompressed size
          const info = file as any
          totalUncompressed += info._data?.uncompressedSize ?? 0
        }
      }

      if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) {
        return { safe: false, reason: `ZIP uncompressed size too large: ${Math.round(totalUncompressed / 1024 / 1024)}MB (max 500MB)` }
      }

      if (buffer.length > 0 && totalUncompressed / buffer.length > MAX_ZIP_RATIO) {
        return { safe: false, reason: `ZIP compression ratio too high: ${Math.round(totalUncompressed / buffer.length)}:1 (max ${MAX_ZIP_RATIO}:1)` }
      }
    } catch {
      // SEC-008: FAIL CLOSED.
      //
      // This used to swallow the error on the reasoning that an unparseable ZIP "will likely fail
      // downstream anyway" — but downstream is a parser, not a scanner, and the scan is what the
      // caller was told happened. Every bomb check above lives inside this try, so a file crafted
      // to break JSZip skipped entry counts, uncompressed size and compression ratio, and then
      // came back `safe: true`. The one input that defeats the analysis was the one input the
      // analysis approved.
      //
      // A genuine .docx that cannot be opened is not a usable document either, so refusing it
      // costs nothing a user wanted.
      return {
        safe: false,
        reason: 'ZIP-based file could not be parsed for archive-bomb analysis',
      }
    }
  }

  return { safe: true }
}
