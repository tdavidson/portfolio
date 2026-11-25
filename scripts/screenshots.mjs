#!/usr/bin/env node
/**
 * Retake the screenshots in public/screenshots from the demo widget's sample fund.
 *
 *   npm run demo:widget && npm run screenshots            # every shot below
 *   npm run screenshots -- dashboard fund                  # just these
 *
 * Each shot is a page of the built widget (demo-widget/dist), rendered by the app's own components
 * on the demo snapshot, so the images always match the current app and can never show a real
 * fund's data. scripts/demo-check.mjs does the browsing; this script picks the pages, the size
 * (1440×900 at 2× for a sharp image on retina screens) and the file names the README, FEATURES.md
 * and the marketing site use. Overwrites in place, so commit the result.
 *
 * A page with an id (a company, a fund, a letter) takes the first matching URL the widget serves,
 * read from demo-widget/dist/routes.json, so the shots follow the snapshot when it changes.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const routesFile = path.join(root, 'demo-widget', 'dist', 'routes.json')
const outDir = path.join(root, 'public', 'screenshots')

/** File name (without .png) → the widget URL, or a pattern matched against the widget's URLs. */
const SHOTS = {
  dashboard: '/dashboard',
  company: /^\/companies\/[^/]+$/,
  fund: /^\/funds\/[0-9a-f-]{36}$/,
  'capital-accounts': /^\/funds\/[0-9a-f-]{36}\/capital-accounts$/,
  statements: /^\/funds\/[0-9a-f-]{36}\/statements$/,
  forecast: /^\/funds\/[0-9a-f-]{36}\/forecast$/,
  journal: /^\/funds\/[0-9a-f-]{36}\/journal$/,
  'report-card': /^\/lps\/cards\/[^/]+$/,
  lps: '/lps',
  'lp-portal': '/lp-portal',
  investments: '/investments',
  funds: '/funds',
  letters: '/letters',
  letter: /^\/letters\/[0-9a-f-]{36}$/,
  diligence: '/diligence',
  'diligence-memo': /^\/diligence\/[^/]+\/drafts\/[^/]+$/,
  deals: '/deals',
  review: '/review',
  inbound: '/emails',
  'email-detail': /^\/emails\/[^/]+$/,
  import: '/import',
  interactions: '/interactions',
  asks: '/requests',
  notes: '/notes',
  compliance: '/compliance',
  views: '/views',
  view: /^\/views\/[0-9a-f-]{36}$/,
  settings: '/settings',
}

if (!fs.existsSync(routesFile)) {
  console.error('screenshots: demo-widget/dist is empty; run `npm run demo:widget` first.')
  process.exit(2)
}
const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'))
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(SHOTS)
const unknown = names.filter(n => !(n in SHOTS))
if (unknown.length) {
  console.error(`screenshots: no shot named ${unknown.join(', ')}. Known: ${Object.keys(SHOTS).join(', ')}`)
  process.exit(2)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-shots-'))
let failed = 0
for (const name of names) {
  const spec = SHOTS[name]
  const href = typeof spec === 'string' ? spec : routes.find(r => spec.test(r))
  if (!href || !routes.includes(href)) {
    console.error(`skip  ${name}: the widget serves no page for ${spec}`)
    failed++
    continue
  }
  const dir = path.join(tmp, name)
  try {
    // A query makes demo-check visit exactly this URL rather than every URL it prefixes.
    execFileSync(process.execPath, [
      path.join(root, 'scripts', 'demo-check.mjs'),
      '--only', `${href}?`, '--shots', dir,
      '--width', '1440', '--height', '900', '--scale', '2', '--frame',
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch {
    console.error(`fail  ${name}: ${href} crashed in the widget`)
    failed++
    continue
  }
  const [shot] = fs.readdirSync(dir)
  fs.copyFileSync(path.join(dir, shot), path.join(outDir, `${name}.png`))
  console.log(`ok    ${name}.png  ←  ${href}`)
}
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
