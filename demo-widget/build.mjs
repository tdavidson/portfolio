#!/usr/bin/env node
/**
 * Build the public demo widget: demo-widget/dist/{widget.js, widget.css, snapshot.json,
 * answers.json, manifest.json}.
 *
 *   npm run demo:widget
 *
 * 1. esbuild bundles demo-widget/index.tsx with the app's own components (React included, so
 *    the host page needs nothing) and the Next.js modules swapped for the stubs in ./stubs, as
 *    an ES module split at the dynamic imports in routes.tsx: widget.js is the shell and the
 *    dashboard, and each section of the app is a chunk fetched on first use.
 * 2. Tailwind compiles app/globals.css — the app's whole stylesheet, preflight and base rules
 *    included — with the app's config, for exactly the files that bundle pulled in.
 * 3. scope-css.mjs rewrites its selectors to match only inside the widget, keeping every
 *    rule's specificity, and a short reset stops the host page's inherited styles at the door.
 * 4. The data files are copied and a manifest written for the site's build to check against.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scopeCss, ROOT_RESET, ROOT } from './scope-css.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dist = path.join(here, 'dist')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

// 1. Script -------------------------------------------------------------------------------
const result = await build({
  entryPoints: [path.join(here, 'index.tsx')],
  outdir: dist,
  entryNames: 'widget',
  chunkNames: 'chunk-[hash]',
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"' },
  // Anything else that reads process.env at runtime gets an empty object, not a ReferenceError.
  banner: { js: 'var process=typeof process==="undefined"?{env:{}}:process;' },
  alias: {
    'next/link': path.join(here, 'stubs', 'next-link.tsx'),
    'next/navigation': path.join(here, 'stubs', 'next-navigation.ts'),
    'next-themes': path.join(here, 'stubs', 'next-themes.ts'),
    'next/script': path.join(here, 'stubs', 'next-script.tsx'),
    '@/lib/supabase/client': path.join(here, 'stubs', 'supabase-client.ts'),
    // The bank page's spreadsheet parser, half a megabyte the read-only demo never runs.
    'xlsx': path.join(here, 'stubs', 'xlsx.ts'),
  },
  // `import text from '…/file.csv?raw'` (hrefs.ts's template downloads), as Vite does it in the tests.
  plugins: [{
    name: 'raw',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }))
      b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }))
    },
  }],
  metafile: true,
  logLevel: 'warning',
  legalComments: 'none',
})

// 2. Styles: the app's own stylesheet, compiled for the files in the bundle, scoped -------------
const bundled = Object.keys(result.metafile.inputs)
  .filter(f => /\.(tsx?|jsx?)$/.test(f) && !f.includes('node_modules'))
  .map(f => path.resolve(root, f))
fs.writeFileSync(path.join(dist, 'content-files.json'), JSON.stringify(bundled, null, 1))

execFileSync(path.join(root, 'node_modules', '.bin', 'tailwindcss'), [
  '-c', path.join(here, 'tailwind.config.ts'),
  '-i', path.join(root, 'app', 'globals.css'),
  '-o', path.join(dist, 'tw.css'),
  '--minify',
], { stdio: 'inherit', cwd: root })

// 3. Scope it (scope-css.mjs): same rules, same specificity, matching only inside the widget.
const tw = fs.readFileSync(path.join(dist, 'tw.css'), 'utf8')
const banner = `/* Portfolio demo widget: app/globals.css from reporting ${pkg.version}, scoped to .${ROOT}. Built ${new Date().toISOString()}. */`
fs.writeFileSync(path.join(dist, 'widget.css'), `${banner}\n${ROOT_RESET}\n${scopeCss(tw)}`)
fs.rmSync(path.join(dist, 'tw.css'))

// 4. Data + manifest -------------------------------------------------------------------------
// Minified on the way out: the files in data/ are indented so a re-record diffs by line, and
// visitors should not download the indentation.
for (const f of ['snapshot.json', 'answers.json', 'pages.json', 'api.json']) {
  fs.writeFileSync(path.join(dist, f), JSON.stringify(JSON.parse(fs.readFileSync(path.join(here, 'data', f), 'utf8'))))
}
const chunks = fs.readdirSync(dist).filter(f => /^chunk-[A-Z0-9]+\.js$/i.test(f)).sort()
const snapshot = JSON.parse(fs.readFileSync(path.join(dist, 'snapshot.json'), 'utf8'))

// Every URL the widget serves for this data, for the site's build to prerender and the scripts
// to walk. The table is data (route-table.ts), so it runs in Node without a browser.
const tableBuild = await build({
  entryPoints: [path.join(here, 'route-table.ts')], write: false, bundle: true, format: 'esm', platform: 'node', target: ['node20'],
  tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'warning',
})
const tableUrl = `data:text/javascript;base64,${Buffer.from(tableBuild.outputFiles[0].text).toString('base64')}`
const { allHrefs } = await import(tableUrl)
const routes = allHrefs(snapshot, JSON.parse(fs.readFileSync(path.join(dist, 'pages.json'), 'utf8')))
fs.writeFileSync(path.join(dist, 'routes.json'), JSON.stringify(routes, null, 1) + '\n')
const answers = JSON.parse(fs.readFileSync(path.join(dist, 'answers.json'), 'utf8'))
const manifest = {
  name: 'portfolio-demo-widget',
  version: pkg.version,
  builtAt: new Date().toISOString(),
  schemaVersion: snapshot.schemaVersion,
  answersSchemaVersion: answers.schemaVersion,
  answersGeneratedBy: answers.generatedBy,
  global: 'PortfolioDemo',
  files: ['widget.js', ...chunks, 'widget.css', 'snapshot.json', 'answers.json', 'pages.json', 'api.json', 'routes.json'],
}
// The SHA-256 of every file, so the site's build can tell a download that straddled two
// publishes (the release's files are replaced one at a time) from a whole build, and retry.
manifest.sha256 = Object.fromEntries(manifest.files.map(f => [
  f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex'),
]))
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2))
fs.rmSync(path.join(dist, 'content-files.json'))

for (const f of manifest.files) {
  const size = fs.statSync(path.join(dist, f)).size
  console.log(`${f.padEnd(22)} ${(size / 1024).toFixed(0).padStart(6)} KB`)
}
