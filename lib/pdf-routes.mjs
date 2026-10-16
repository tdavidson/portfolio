// The routes whose function renders a PDF through headless Chromium (lib/lp-report-pdf.ts →
// @sparticuz/chromium), and the files that have to ship with them.
//
// WHY THIS LIST EXISTS. @sparticuz/chromium carries Chromium as brotli archives in its `bin/`
// directory and unpacks them at runtime from a path it computes (`getBinPath()`), which the build's
// file tracer cannot follow. So the package's JavaScript was traced into these functions and its
// binary was not: on Vercel `chromium.executablePath()` threw, every PDF route failed at render,
// and the assistant's report links — which answer every failure with the same 404 — said "This
// link has expired" about a link minted seconds earlier. next.config.mjs adds `bin/` to each route
// here; tests/pdf-routes.test.ts fails when a route that reaches lib/lp-report-pdf.ts is missing.
//
// Not '/**': the archives are ~67 MB, and every other function would carry them for nothing
// against Vercel's 250 MB unzipped function limit.

/** App-router route paths, as Next names them (dynamic segments in brackets). */
export const PDF_ROUTES = [
  '/api/accounting/proposed-calls',
  '/api/accounting/proposed-calls/pdf',
  '/api/accounting/fund-performance/pdf',
  '/api/accounting/k1-packages/pdf',
  '/api/accounting/lp-statement/pdf',
  '/api/accounting/lp-statement/publish',
  '/api/accounting/notices/preview',
  '/api/accounting/notices/publish',
  '/api/accounting/notices/receipt',
  '/api/accounting/partnership-invoices/[id]/pdf',
  '/api/accounting/statements/pdf',
  '/api/accounting/tax-package',
  '/api/agent/call-notices/publish',
  '/api/agent/reports/[token]',
  '/api/lps/export/pdf',
  '/api/lps/onboarding/request',
  '/api/lps/onboarding/sort',
  '/api/lps/preview/snapshot/[id]/pdf',
  '/api/lps/send',
  '/api/portal/analyst',
  '/api/portal/letters/[id]/pdf',
  '/api/portal/snapshots/[id]/pdf',
  '/api/portal/statement/pdf',
  '/api/pending-actions/[id]/approve',
]

export const CHROMIUM_FILES = ['./node_modules/@sparticuz/chromium/bin/**/*']

/**
 * `outputFileTracingIncludes` entries for PDF_ROUTES. Next matches each key as a picomatch glob
 * against the route path, where `[token]` is glob syntax, so the brackets of a dynamic segment are
 * escaped to mean themselves. tests/pdf-routes.test.ts matches every key the way Next does.
 */
export function pdfTracingIncludes() {
  return Object.fromEntries(PDF_ROUTES.map(r => [r.replace(/[[\]]/g, c => `\\${c}`), CHROMIUM_FILES]))
}
