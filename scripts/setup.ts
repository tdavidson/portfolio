// Set up a deployment from a terminal: database, keys, deploy, auth, your fund, and how AI works.
//
//   npm run setup
//   npm run setup -- --email you@firm.com --fund "Hemrock Ventures" --ai assistant \
//     --supabase cli --vercel cli --install-clis yes --domain reporting.firm.com --yes
//
// Each step does the work itself where it can and prints the exact manual step where it can't.
// The Supabase CLI and the Vercel CLI are both optional: when one is missing, the script offers to
// install it; say no (or --supabase manual / --vercel skip) and that part becomes printed steps and
// pasted values. Safe to re-run: values already in .env.local are kept, the encryption key is
// never replaced, and the fund step reuses your account and fund (scripts/bootstrap-fund.ts).
//
// Flags (every question has one, so Claude Code or CI can run this without prompts):
//   --email, --fund, --products a,b     the fund, as for `npm run bootstrap`
//   --ai assistant|key                  no server AI key (your own assistant does the AI work), or a
//                                       key from ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
//   --supabase cli|manual               --project-ref <ref> to use an existing project, or
//                                       --project-name, --region, --org-id to create one
//   --vercel cli|skip                   --vercel-project <name>; --site-url when you host elsewhere
//   --domain reporting.firm.com         your custom domain, when you have one
//   --install-clis yes|no               install a missing CLI without asking
//   --env-path .env.local               where the keys go
//   --yes                               never prompt; anything not passed is skipped or left manual
//
// Secrets never go on the command line: keys are read from the CLIs or the environment, or typed at
// a prompt, and written only to the env file (mode 600) and, with Vercel, to the project's env.

import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { authConfigFor, parseEnv, supabaseKeysFromCli, updateEnv } from '../lib/setup/env-file'
import { AI_CAPABILITIES } from '../lib/ai/capabilities'

// ---------------------------------------------------------------------------
// Arguments, prompts, processes
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const NON_INTERACTIVE = process.argv.includes('--yes') || !stdin.isTTY
const rl = NON_INTERACTIVE ? null : createInterface({ input: stdin, output: stdout })

async function ask(question: string, fallback = ''): Promise<string> {
  if (!rl) return fallback
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''} `)).trim()
  return answer || fallback
}

async function confirm(question: string, flag: string | undefined, fallback: boolean): Promise<boolean> {
  if (flag === 'yes' || flag === 'cli' || flag === 'true') return true
  if (flag === 'no' || flag === 'manual' || flag === 'skip' || flag === 'false') return false
  if (!rl) return fallback
  const a = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  return a ? a.startsWith('y') : fallback
}

/** A secret typed at the prompt, not echoed. */
async function askSecret(question: string): Promise<string> {
  if (!rl) return ''
  stdout.write(`${question} `)
  // readline echoes each keystroke through _writeToOutput; let only the final newline through.
  const iface = rl as unknown as { _writeToOutput: (s: string) => void }
  const echo = iface._writeToOutput
  iface._writeToOutput = (s: string) => { if (s.includes('\n')) echo.call(iface, '\n') }
  try {
    return (await rl.question('')).trim()
  } finally {
    iface._writeToOutput = echo
  }
}

function heading(text: string) {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}`)
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions & { input?: string } = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts })
  return { ok: res.status === 0, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }
}

/** Run with the terminal attached, for logins and anything that prompts. */
function runLive(cmd: string, args: string[], env?: Record<string, string>): boolean {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  return res.status === 0
}

function onPath(cmd: string): boolean {
  return run(process.platform === 'win32' ? 'where' : 'which', [cmd]).ok
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

// ---------------------------------------------------------------------------
// The env file
// ---------------------------------------------------------------------------

const ENV_FILE = arg('env-path') ?? '.env.local'
let env: Record<string, string> = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {}

function saveEnv(updates: Record<string, string | undefined>) {
  const before = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  writeFileSync(ENV_FILE, updateEnv(before, updates), { mode: 0o600 })
  try { chmodSync(ENV_FILE, 0o600) } catch { /* not supported on this filesystem */ }
  env = parseEnv(readFileSync(ENV_FILE, 'utf8'))
}

// ---------------------------------------------------------------------------
// 1. The CLIs
// ---------------------------------------------------------------------------

/** How to call the Supabase CLI here: on the PATH, or through npx (downloaded on first use). */
let supabaseCmd: [string, string[]] | null = null
const supabase = (args: string[], opts?: SpawnSyncOptions & { input?: string }) => run(supabaseCmd![0], [...supabaseCmd![1], ...args], opts)
const supabaseLive = (args: string[], extraEnv?: Record<string, string>) => runLive(supabaseCmd![0], [...supabaseCmd![1], ...args], extraEnv)

async function ensureSupabaseCli(): Promise<boolean> {
  if (onPath('supabase')) { supabaseCmd = ['supabase', []]; return true }
  if (existsSync('node_modules/.bin/supabase')) { supabaseCmd = ['npx', ['--no-install', 'supabase']]; return true }
  const install = arg('install-clis')
  if (!(await confirm('The Supabase CLI isn\'t installed. Install it now? (no: you\'ll do the database steps by hand)', install, false))) return false
  if (process.platform !== 'win32' && onPath('brew')) {
    if (runLive('brew', ['install', 'supabase/tap/supabase'])) { supabaseCmd = ['supabase', []]; return true }
  } else if (process.platform === 'win32' && onPath('scoop')) {
    runLive('scoop', ['bucket', 'add', 'supabase', 'https://github.com/supabase/scoop-bucket.git'])
    if (runLive('scoop', ['install', 'supabase'])) { supabaseCmd = ['supabase', []]; return true }
  }
  // The npm package does not support a global install; npx runs it from the npm cache instead.
  console.log('Using the Supabase CLI through npx (it is downloaded on first use).')
  supabaseCmd = ['npx', ['-y', 'supabase']]
  return supabase(['--version']).ok
}

async function ensureVercelCli(): Promise<boolean> {
  if (onPath('vercel')) return true
  if (!(await confirm('The Vercel CLI isn\'t installed. Install it now (npm i -g vercel)? (no: you\'ll deploy by hand)', arg('install-clis'), false))) return false
  // npm 12 blocks dependency install scripts unless allow-listed, and a global install has no
  // package.json to list them in. These are the two the Vercel CLI pulls in (fsevents on macOS
  // only); npm 10 and 11 accept the flag and ignore it.
  return runLive('npm', ['install', '-g', '--allow-scripts=esbuild,fsevents', 'vercel']) && onPath('vercel')
}

// ---------------------------------------------------------------------------
// 2. The database
// ---------------------------------------------------------------------------

async function databaseWithCli(): Promise<string | null> {
  if (!supabase(['projects', 'list']).ok) {
    console.log('Signing in to Supabase (a browser window opens).')
    if (!supabaseLive(['login'])) return null
  }

  let ref = arg('project-ref') ?? env.SUPABASE_PROJECT_REF ?? ''
  if (!ref) {
    const projects = (parseJson(supabase(['projects', 'list', '-o', 'json']).stdout) ?? []) as { id?: string; ref?: string; name?: string }[]
    if (projects.length) {
      console.log('Your Supabase projects:')
      projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.ref ?? p.id})`))
    }
    const pick = await ask(projects.length ? 'Use which one? Enter a number, or press Enter to create a new project:' : 'No projects yet. Press Enter to create one:')
    const chosen = projects[Number(pick) - 1]
    if (chosen) ref = (chosen.ref ?? chosen.id)!
  }

  if (!ref) {
    const orgs = (parseJson(supabase(['orgs', 'list', '-o', 'json']).stdout) ?? []) as { id: string; name: string }[]
    const orgId = arg('org-id') ?? (orgs.length === 1 ? orgs[0].id : await ask(`Organization id (${orgs.map(o => `${o.name}: ${o.id}`).join(', ')}):`, orgs[0]?.id))
    const name = arg('project-name') ?? await ask('New project name:', 'portfolio')
    const region = arg('region') ?? await ask('Region:', 'us-east-1')
    const dbPassword = randomBytes(24).toString('base64url')
    console.log(`Creating "${name}" in ${region}…`)
    const created = supabase(['projects', 'create', name, '--org-id', orgId, '--region', region, '--db-password', dbPassword, '-o', 'json'])
    const project = parseJson(created.stdout) as { id?: string; ref?: string } | null
    ref = project?.ref ?? project?.id ?? ''
    if (!created.ok || !ref) { console.log(`Could not create the project: ${created.stderr.trim()}`); return null }
    // The CLI reads SUPABASE_DB_PASSWORD for link and db push; keep it next to the other keys.
    saveEnv({ SUPABASE_DB_PASSWORD: dbPassword })
    process.stdout.write('Waiting for the database to start')
    for (let i = 0; i < 60; i++) {
      const list = (parseJson(supabase(['projects', 'list', '-o', 'json']).stdout) ?? []) as { id?: string; ref?: string; status?: string }[]
      if (list.find(p => (p.ref ?? p.id) === ref)?.status === 'ACTIVE_HEALTHY') break
      process.stdout.write('.')
      await new Promise(r => setTimeout(r, 5000))
    }
    console.log('')
  }
  saveEnv({ SUPABASE_PROJECT_REF: ref, NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co` })

  const keys = supabaseKeysFromCli(parseJson(supabase(['projects', 'api-keys', '--project-ref', ref, '-o', 'json']).stdout))
  if (keys) saveEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.anon, SUPABASE_SERVICE_ROLE_KEY: keys.serviceRole })
  else await pasteSupabaseKeys()

  const dbEnv = env.SUPABASE_DB_PASSWORD ? { SUPABASE_DB_PASSWORD: env.SUPABASE_DB_PASSWORD } : undefined
  if (!supabaseLive(['link', '--project-ref', ref], dbEnv)) { console.log('Could not link the project; run `supabase link` and re-run this script.'); return ref }
  // Applies supabase/migrations only. supabase/pending-deploy/ waits for the release named in each header.
  console.log('Applying the database migrations (supabase db push)…')
  if (!supabaseLive(['db', 'push', ...(NON_INTERACTIVE ? ['--yes'] : [])], dbEnv)) console.log('The migrations did not all apply; fix the error above and re-run.')
  return ref
}

async function pasteSupabaseKeys() {
  const want: [string, string][] = [
    ['NEXT_PUBLIC_SUPABASE_URL', 'Project URL (Project Settings → API):'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Anon (publishable) key:'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'Service role (secret) key:'],
  ]
  for (const [key, question] of want) {
    if (env[key]) continue
    const value = key === 'NEXT_PUBLIC_SUPABASE_URL' ? await ask(question) : await askSecret(question)
    if (value) saveEnv({ [key]: value })
  }
}

async function databaseByHand() {
  console.log([
    'Do these in the Supabase dashboard (DOCS.md, Step 2):',
    '  1. Create a project at https://supabase.com/dashboard.',
    '  2. Run the migrations: paste each file in supabase/migrations/ into the SQL Editor, in filename order.',
    '     (Or install the Supabase CLI later and run `supabase db push`; pick one and keep to it.)',
    '  3. Copy the project URL and keys from Project Settings → API:',
  ].join('\n'))
  await pasteSupabaseKeys()
}

// ---------------------------------------------------------------------------
// 4. Deploy
// ---------------------------------------------------------------------------

/** What the host needs before the first build; the site URL follows once the deploy has one. */
const BUILD_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ENCRYPTION_KEY', 'CRON_SECRET']

function vercelEnvSet(name: string, value: string): boolean {
  run('vercel', ['env', 'rm', name, 'production', '--yes'])
  return run('vercel', ['env', 'add', name, 'production'], { input: value }).ok
}

async function deployWithVercel(): Promise<string | null> {
  if (!run('vercel', ['whoami']).ok) {
    console.log('Signing in to Vercel (a browser window opens).')
    if (!runLive('vercel', ['login'])) return null
  }
  const project = arg('vercel-project') ?? await ask('Vercel project name:', 'portfolio')
  if (!runLive('vercel', ['link', '--yes', '--project', project])) return null

  const domain = arg('domain') ?? await ask('Your custom domain, if you have one (e.g. reporting.firm.com), or press Enter for the vercel.app address:')
  if (domain && !run('vercel', ['domains', 'add', domain]).ok) console.log(`Add ${domain} in the Vercel dashboard → Domains, and point its DNS at Vercel.`)

  for (const name of BUILD_VARS) {
    if (env[name] && !vercelEnvSet(name, env[name])) console.log(`Could not set ${name} on Vercel; add it in Project → Settings → Environment Variables.`)
  }
  console.log('Deploying (first build)…')
  const first = run('vercel', ['deploy', '--prod', '--yes'])
  const deployUrl = first.stdout.trim().split(/\s+/).filter(s => s.startsWith('https://')).pop()
  if (!first.ok || !deployUrl) { console.log(`The deploy failed:\n${first.stderr.slice(-2000)}`); return null }

  // NEXT_PUBLIC_* values are baked in at build time, so the site URL needs a second build.
  const siteUrl = domain ? `https://${domain}` : await ask(
    'Your production URL (Vercel → Project → Domains; the per-deploy URL changes each time):', `https://${project}.vercel.app`)
  saveEnv({ NEXT_PUBLIC_SITE_URL: siteUrl, NEXT_PUBLIC_APP_URL: siteUrl })
  vercelEnvSet('NEXT_PUBLIC_SITE_URL', siteUrl)
  vercelEnvSet('NEXT_PUBLIC_APP_URL', siteUrl)
  console.log('Deploying again with the site URL…')
  if (!runLive('vercel', ['deploy', '--prod', '--yes'])) console.log('The second deploy failed; run `vercel deploy --prod` once the error above is fixed.')
  return siteUrl
}

async function deployByHand(): Promise<string | null> {
  console.log('Deploy to Vercel, Netlify or another host (DOCS.md, Step 4), with these environment variables:')
  for (const name of BUILD_VARS) console.log(`  ${name}  (in ${ENV_FILE})`)
  console.log('  NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_APP_URL  (your deployed URL; redeploy after setting them)')
  const siteUrl = arg('site-url') ?? env.NEXT_PUBLIC_SITE_URL ?? await ask('Your deployed URL, once it is up (or press Enter to finish this later):')
  if (siteUrl) saveEnv({ NEXT_PUBLIC_SITE_URL: siteUrl, NEXT_PUBLIC_APP_URL: siteUrl })
  return siteUrl || null
}

// ---------------------------------------------------------------------------
// 5. Auth
// ---------------------------------------------------------------------------

async function configureAuth(ref: string | null, siteUrl: string) {
  const manual = () => console.log([
    'In the Supabase dashboard (DOCS.md, Step 5):',
    `  Authentication → URL Configuration: Site URL ${siteUrl}, Redirect URLs ${siteUrl.replace(/\/+$/, '')}/**`,
    '  Authentication → Providers → Email: leave Confirm email on',
    '  Authentication → Hooks: Before User Created → Postgres function hook_before_user_created',
  ].join('\n'))
  if (!ref) return manual()
  let token = process.env.SUPABASE_ACCESS_TOKEN ?? ''
  if (!token) token = await askSecret('To set these for you, paste a Supabase access token (supabase.com/dashboard/account/tokens), or press Enter to do it by hand:')
  if (!token) return manual()
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(authConfigFor(siteUrl)),
  }).catch(() => null)
  if (res?.ok) console.log('Auth configured: site URL, redirect URLs, email confirmations and the signup hook.')
  else { console.log(`Could not configure auth (${res?.status ?? 'network error'}).`); manual() }
}

// ---------------------------------------------------------------------------
// 6–7. The fund, and how AI works
// ---------------------------------------------------------------------------

async function chooseAI(): Promise<'assistant' | 'key' | null> {
  const flag = arg('ai')
  if (flag === 'assistant' || flag === 'key') return flag
  const hasEnvKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY)
  console.log('How should AI work here?')
  console.log('  1. Use my own assistant: no server key. Claude or ChatGPT, connected over MCP, does the AI work.')
  console.log(`  2. Add a server key${hasEnvKey ? ' (found one in your environment)' : ' (put ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY in the environment first)'}.`)
  console.log('     The app then calls the model itself: the web app\'s AI buttons, email parsing and background jobs.')
  console.log('  Works from your assistant without a key:')
  for (const c of AI_CAPABILITIES.filter(c => c.keyless !== 'needs_key')) console.log(`    - ${c.label}${c.keyless === 'on_demand' ? ' (waits until you ask)' : ''}`)
  console.log('  Needs a server key:')
  for (const c of AI_CAPABILITIES.filter(c => c.keyless === 'needs_key')) console.log(`    - ${c.label}`)
  if (!rl) return null // Not asked: --ai decides, or the checklist asks later.
  const pick = await ask('1 or 2 (Enter to decide later in Settings):')
  if (pick === '1') return 'assistant'
  if (pick === '2') {
    if (hasEnvKey) return 'key'
    console.log('No key in the environment, so none is stored now. Add one in Settings → AI providers, or export it and re-run.')
  }
  return null
}

function bootstrapFund(email: string, fund: string, ai: 'assistant' | 'key' | null): boolean {
  const args = ['tsx', `--env-file=${ENV_FILE}`, 'scripts/bootstrap-fund.ts', '--email', email, '--fund', fund]
  const products = arg('products')
  if (products) args.push('--products', products)
  if (ai) args.push('--ai', ai)
  return runLive('npx', ['-y', ...args])
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Setting up Portfolio. Values go in', ENV_FILE, '(kept private, mode 600). Safe to re-run.')

  heading('1. Tools')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) console.log(`Node ${process.versions.node} is older than this app needs (22.17 or later).`)
  if (!existsSync('node_modules')) runLive('npm', ['install'])
  const wantSupabaseCli = arg('supabase') !== 'manual'
  const wantVercelCli = arg('vercel') !== 'skip'
  const hasSupabase = wantSupabaseCli && await ensureSupabaseCli()
  const hasVercel = wantVercelCli && await ensureVercelCli()

  heading('2. Database (Supabase)')
  const haveDb = env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY
  let ref: string | null = env.SUPABASE_PROJECT_REF ?? null
  if (haveDb && !(await confirm(`${ENV_FILE} already points at ${env.NEXT_PUBLIC_SUPABASE_URL}. Run the database step again (link and push migrations)?`, undefined, false))) {
    console.log('Keeping the database you already set up.')
  } else if (hasSupabase && await confirm('Set up the database with the Supabase CLI?', arg('supabase'), true)) {
    ref = await databaseWithCli()
  } else {
    await databaseByHand()
  }

  heading('3. Keys')
  if (env.ENCRYPTION_KEY) console.log('Keeping your ENCRYPTION_KEY. (Replacing it would make every stored secret unreadable.)')
  else {
    saveEnv({ ENCRYPTION_KEY: randomBytes(32).toString('hex') })
    console.log(`Generated ENCRYPTION_KEY in ${ENV_FILE}. Back it up: if it is lost, stored credentials cannot be recovered.`)
  }
  if (!env.CRON_SECRET) saveEnv({ CRON_SECRET: randomBytes(32).toString('hex') })

  heading('4. Deploy')
  const siteUrl = hasVercel && await confirm('Deploy to Vercel with the Vercel CLI?', arg('vercel'), true)
    ? await deployWithVercel()
    : await deployByHand()

  heading('5. Sign-in settings (Supabase Auth)')
  if (siteUrl) await configureAuth(hasSupabase ? ref : null, siteUrl)
  else console.log('Skipped until the app is deployed: re-run this script then, or follow DOCS.md, Step 5.')

  heading('6. Your fund and AI')
  const email = arg('email') ?? await ask('Your email (you will sign in with it):')
  const fund = arg('fund') ?? await ask('Fund name:')
  const ai = await chooseAI()
  if (email && fund && env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!bootstrapFund(email, fund, ai)) console.log('The fund step failed; the message above says why. Re-run it with `npm run bootstrap`.')
  } else {
    console.log('Skipped: needs your email, a fund name and the database keys. Then run `npm run bootstrap -- --email … --fund …`.')
  }

  heading('Next')
  const origin = siteUrl ?? '<your-domain>'
  console.log(`Connect ${origin.replace(/\/+$/, '')}/api/mcp in Claude or ChatGPT, and pick "Set up this fund" from its prompts.`)
  console.log(`Or sign in to the web app at ${origin} with ${email || 'your email'}.`)
  rl?.close()
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e))
  rl?.close()
  process.exit(1)
})
