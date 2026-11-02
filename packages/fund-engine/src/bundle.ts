// A close's reproducibility bundle: everything needed to recompute what the close produced, and
// a manifest that pins it.
//
//   books.ledger     the plain-text ledger as of the close date (the close's own snapshot)
//   terms.json       the vehicle's terms, in the CLI's terms-file format
//   statements.json  exactly what `fund-engine statements --as-of <period end>` printed
//   manifest.json    format, engine version, what was closed, SHA-256 and size of each file, and
//                    the audit trail's chain head when the close was recorded
//
// The bundle's own hash is the SHA-256 of manifest.json. The app records that hash on the close
// and in the audit trail, so a bundle someone hands you can be matched to the close it claims to
// be. `fund-engine verify --bundle <dir>` checks every file against the manifest and recomputes
// statements.json from the ledger and the terms.

import { sha256Hex, utf8Bytes } from './sha256.ts'
import { ENGINE_NAME, ENGINE_VERSION } from './version.ts'
import { statementsReport } from './reports.ts'
import { parseVehicleTerms } from './terms-file.ts'
import type { VehicleCarryTerms } from './carry.ts'

export const BUNDLE_FORMAT = 'hemrock-close-bundle/1'

export const BUNDLE_FILES = {
  ledger: 'books.ledger',
  terms: 'terms.json',
  statements: 'statements.json',
  manifest: 'manifest.json',
} as const

export interface BundleSubject {
  fundId: string
  vehicleId: string
  vehicle: string
  fiscalPeriodId: string
  periodStart: string
  periodEnd: string
}

export interface BundleManifest {
  format: string
  engine: { name: string; version: string }
  subject: BundleSubject
  createdAt: string
  /** How statements.json was produced, run from inside the bundle directory. */
  command: string
  files: Record<string, { sha256: string; bytes: number }>
  /** The audit trail's head when the bundle was built: the last event before this close's own. */
  auditChain: { headSeq: number; headHash: string } | null
  notes: string[]
}

export interface CloseBundle {
  manifest: BundleManifest
  /** Every file's exact text, manifest.json included. */
  files: Record<string, string>
  /** SHA-256 of manifest.json — the bundle's identity. */
  sha256: string
}

/** One partner as the terms file names them. */
export interface TermsFilePartner {
  id: string
  name?: string | null
  account?: string | null
  commitment?: number | null
}

/**
 * A terms file (the CLI's terms.json) from a vehicle's stored terms. `parseVehicleTerms` reads it
 * back to the same carry terms, so the bundle recomputes with exactly what the close used.
 */
export function termsFileFrom(input: {
  vehicle: string
  carry: VehicleCarryTerms
  partners: TermsFilePartner[]
  /** Informational: how the close allocates P&L. The statements do not depend on it. */
  allocationBasis?: string | null
}): Record<string, unknown> {
  const c = input.carry
  return {
    vehicle: input.vehicle,
    carry: {
      kind: c.kind,
      carryRate: c.carryRate,
      prefRate: c.prefRate,
      catchupRate: c.catchupRate,
      catchupSize: c.catchupSize ?? 1,
      prefCompounds: c.prefCompounds,
      prefBase: c.prefBase ?? 'contributed',
      // Only when set, so a bundle made before these terms existed hashes the same.
      ...(c.prefMultiple != null ? { prefMultiple: c.prefMultiple } : {}),
      ...(c.prefDayCount === '30/360' ? { prefDayCount: c.prefDayCount } : {}),
      ...(c.catchupMeasure === 'profit' ? { catchupMeasure: c.catchupMeasure } : {}),
      ...(c.carrySteps?.length ? { carrySteps: c.carrySteps } : {}),
      ...(c.capitalIncludes ? { capitalIncludes: c.capitalIncludes } : {}),
      ...(c.gpCommitBearsCarry ? { gpCommitBearsCarry: true } : {}),
      ...(c.waterfallScope === 'per_lp' ? { waterfallScope: c.waterfallScope } : {}),
      gpEntityId: c.gpEntityId,
      recipients: c.recipients.map(r => ({ partner: r.lpEntityId, pct: r.pct })),
    },
    partners: [...input.partners]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(p => ({
        id: p.id,
        ...(p.name ? { name: p.name } : {}),
        ...(p.account ? { account: p.account } : {}),
        ...(p.commitment != null ? { commitment: p.commitment } : {}),
      })),
    ...(input.allocationBasis ? { allocation: { basis: input.allocationBasis } } : {}),
  }
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n'

function fileEntry(text: string) {
  return { sha256: sha256Hex(text), bytes: utf8Bytes(text).length }
}

/** The statements a bundle carries: the CLI's `statements` output, byte for byte. */
export function bundleStatements(ledgerText: string, termsText: string, periodEnd: string): string {
  return json(statementsReport(ledgerText, parseVehicleTerms(JSON.parse(termsText)), { asOf: periodEnd }))
}

export function buildBundle(input: {
  ledgerText: string
  terms: Record<string, unknown>
  subject: BundleSubject
  createdAt: string
  auditChain: { headSeq: number; headHash: string } | null
  notes?: string[]
}): CloseBundle {
  const termsText = json(input.terms)
  const statementsText = bundleStatements(input.ledgerText, termsText, input.subject.periodEnd)
  const files: Record<string, string> = {
    [BUNDLE_FILES.ledger]: input.ledgerText,
    [BUNDLE_FILES.terms]: termsText,
    [BUNDLE_FILES.statements]: statementsText,
  }
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
    subject: input.subject,
    createdAt: input.createdAt,
    command: `fund-engine statements --ledger ${BUNDLE_FILES.ledger} --terms ${BUNDLE_FILES.terms} --as-of ${input.subject.periodEnd}`,
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, fileEntry(text)])),
    auditChain: input.auditChain,
    notes: input.notes ?? [],
  }
  const manifestText = json(manifest)
  return { manifest, files: { ...files, [BUNDLE_FILES.manifest]: manifestText }, sha256: sha256Hex(manifestText) }
}

// ---------------------------------------------------------------------------------------------
// verify

export interface VerifyCheck {
  name: string
  ok: boolean
  detail: string
}

export interface VerifyResult {
  ok: boolean
  /** SHA-256 of manifest.json as read — compare it with the hash recorded on the close. */
  bundleSha256: string | null
  subject: BundleSubject | null
  engine: { bundle: string | null; running: string }
  auditChain: BundleManifest['auditChain']
  checks: VerifyCheck[]
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function firstDifference(a: string, b: string): string {
  const al = a.split('\n'), bl = b.split('\n')
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}: bundle has ${JSON.stringify(al[i] ?? '(end)')}, recomputed ${JSON.stringify(bl[i] ?? '(end)')}`
  }
  return 'identical'
}

/**
 * Verify a bundle. `read(name)` returns a file's text from the bundle directory, or throws when it
 * is missing. Pass `expectSha256` (the hash recorded on the close) to check the bundle is that one.
 */
export function verifyBundle(read: (name: string) => string, opts: { expectSha256?: string | null } = {}): VerifyResult {
  const checks: VerifyCheck[] = []
  const result = (manifest: BundleManifest | null, bundleSha256: string | null): VerifyResult => ({
    ok: checks.every(c => c.ok),
    bundleSha256,
    subject: manifest?.subject ?? null,
    engine: { bundle: manifest?.engine ? `${manifest.engine.name}@${manifest.engine.version}` : null, running: `${ENGINE_NAME}@${ENGINE_VERSION}` },
    auditChain: manifest?.auditChain ?? null,
    checks,
  })

  let manifestText: string
  try { manifestText = read(BUNDLE_FILES.manifest) } catch {
    checks.push({ name: 'manifest', ok: false, detail: `${BUNDLE_FILES.manifest} is missing` })
    return result(null, null)
  }
  const bundleSha256 = sha256Hex(manifestText)
  let manifest: BundleManifest
  try { manifest = JSON.parse(manifestText) } catch {
    checks.push({ name: 'manifest', ok: false, detail: `${BUNDLE_FILES.manifest} is not valid JSON` })
    return result(null, bundleSha256)
  }
  if (manifest?.format !== BUNDLE_FORMAT || !manifest.files || typeof manifest.files !== 'object' || !manifest.subject?.periodEnd) {
    checks.push({ name: 'manifest', ok: false, detail: `not a ${BUNDLE_FORMAT} manifest` })
    return result(null, bundleSha256)
  }
  checks.push({ name: 'manifest', ok: true, detail: `${BUNDLE_FORMAT}, ${manifest.subject.vehicle} through ${manifest.subject.periodEnd}` })

  if (opts.expectSha256) {
    const want = opts.expectSha256.trim().toLowerCase()
    checks.push({ name: 'bundle hash', ok: want === bundleSha256, detail: want === bundleSha256 ? `matches ${want}` : `manifest.json hashes to ${bundleSha256}, expected ${want}` })
  }

  for (const name of [BUNDLE_FILES.ledger, BUNDLE_FILES.terms, BUNDLE_FILES.statements]) {
    if (!manifest.files[name]) checks.push({ name: `file ${name}`, ok: false, detail: 'not listed in the manifest' })
  }
  const contents = new Map<string, string>()
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!SAFE_NAME.test(name) || name === BUNDLE_FILES.manifest) {
      checks.push({ name: `file ${name}`, ok: false, detail: 'not a file name a bundle may list' })
      continue
    }
    let text: string
    try { text = read(name) } catch {
      checks.push({ name: `file ${name}`, ok: false, detail: 'missing from the bundle' })
      continue
    }
    contents.set(name, text)
    const actual = fileEntry(text)
    const ok = actual.sha256 === entry?.sha256 && actual.bytes === entry?.bytes
    checks.push({ name: `file ${name}`, ok, detail: ok ? `sha256 ${actual.sha256}` : `sha256 ${actual.sha256} (${actual.bytes} bytes), manifest says ${entry?.sha256} (${entry?.bytes} bytes)` })
  }

  const ledger = contents.get(BUNDLE_FILES.ledger)
  const terms = contents.get(BUNDLE_FILES.terms)
  const statements = contents.get(BUNDLE_FILES.statements)
  if (ledger !== undefined && terms !== undefined && statements !== undefined) {
    try {
      const recomputed = bundleStatements(ledger, terms, manifest.subject.periodEnd)
      const same = recomputed === statements
      checks.push({ name: 'recompute', ok: same, detail: same ? 'statements.json recomputes exactly from books.ledger and terms.json' : `statements.json does not recompute — ${firstDifference(statements, recomputed)}` })
      const report = JSON.parse(recomputed)
      checks.push({ name: 'trial balance', ok: report.checks.trialBalanceBalanced, detail: report.checks.trialBalanceBalanced ? 'debits equal credits' : 'the trial balance does not balance' })
      checks.push({ name: 'roll-forward', ok: report.checks.everyRollForwardTies && report.checks.navTiesToLedger, detail: report.checks.everyRollForwardTies && report.checks.navTiesToLedger ? `every partner's roll-forward ties; NAV ${report.nav} equals partner capital in the ledger` : 'a roll-forward does not tie, or NAV differs from partner capital in the ledger' })
    } catch (e) {
      checks.push({ name: 'recompute', ok: false, detail: `the statements could not be recomputed: ${(e as Error).message}` })
    }
  }

  // Informational: a different engine version may still reproduce the bundle; the recompute check
  // is what decides.
  const bundleEngine = `${manifest.engine?.name}@${manifest.engine?.version}`
  checks.push({ name: 'engine', ok: true, detail: bundleEngine === `${ENGINE_NAME}@${ENGINE_VERSION}` ? `built and verified with ${bundleEngine}` : `built with ${bundleEngine}, verified with ${ENGINE_NAME}@${ENGINE_VERSION}` })

  return result(manifest, bundleSha256)
}

export function verifyTable(r: VerifyResult): string {
  const out: string[] = []
  out.push(`${r.ok ? 'PASS' : 'FAIL'}${r.subject ? ` — ${r.subject.vehicle}, period ${r.subject.periodStart} to ${r.subject.periodEnd}` : ''}`)
  if (r.bundleSha256) out.push(`bundle sha256 ${r.bundleSha256}`)
  if (r.auditChain) out.push(`audit trail head pinned at sequence ${r.auditChain.headSeq}: ${r.auditChain.headHash}`)
  out.push('')
  for (const c of r.checks) out.push(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`)
  return out.join('\n') + '\n'
}
