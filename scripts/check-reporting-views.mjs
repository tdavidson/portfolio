#!/usr/bin/env node
// Synthetic, in-memory PostgreSQL check. Pass an installed @electric-sql/pglite module path
// to run without adding a production dependency: node scripts/check-reporting-views.mjs /path/to/dist/index.js
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const { PGlite } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '@electric-sql/pglite')
const db = new PGlite()
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table ai_usage_logs (fund_id text, created_at timestamptz, provider text, model text,
      input_tokens integer, output_tokens integer, audio_seconds integer, web_searches integer);
    create table diligence_memo_drafts (id text, fund_id text, deal_id text, is_draft boolean,
      finalized_at timestamptz, created_at timestamptz, ingestion_output jsonb, research_output jsonb,
      memo_draft_output jsonb, qa_answers jsonb);
    grant select on ai_usage_logs, diligence_memo_drafts to service_role;
    insert into ai_usage_logs select 'fund-a', '2026-09-30 12:00:00+00', 'synthetic', 'model-a', 10, 2, 3, 1 from generate_series(1, 2001);
    insert into ai_usage_logs values ('fund-b', '2026-09-30 12:00:00+00', 'synthetic', 'model-a', 9000, 0, 0, 0),
      ('fund-a', '2026-10-01 00:00:00+00', 'synthetic', 'model-a', 7, 1, 0, 0);
  `)
  const migration = await fs.readFile(new URL('../supabase/migrations/20261016004405_compact_reporting_views.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const totals = await db.query("select * from reporting_usage_daily where fund_id = 'fund-a' order by created_at")
  assert.equal(totals.rows.length, 2)
  assert.equal(Number(totals.rows[0].input_tokens), 20010)
  assert.equal(Number(totals.rows[0].web_searches), 2001)
  assert.equal(Number(totals.rows[1].input_tokens), 7)
  const values = [null, false, 0, '', {}, [], [null], { large: 'synthetic'.repeat(10000) }]
  for (let i = 0; i < values.length; i++) {
    await db.query(`insert into diligence_memo_drafts (id, fund_id, deal_id, ingestion_output, research_output, memo_draft_output, qa_answers)
      values ($1, 'fund-a', 'deal-a', $2::jsonb, $2::jsonb, $2::jsonb, $2::jsonb)`, [String(i), JSON.stringify(values[i])])
  }
  const flags = await db.query('select * from reporting_diligence_drafts order by id')
  for (let i = 0; i < values.length; i++) {
    for (const column of ['has_ingestion', 'has_research', 'has_memo_draft']) assert.equal(flags.rows[i][column], !!values[i])
    assert.equal(flags.rows[i].has_qa, Array.isArray(values[i]) && values[i].length > 0)
  }
  for (const view of ['reporting_usage_daily', 'reporting_diligence_drafts']) {
    const { rows } = await db.query(`select has_table_privilege('anon', $1, 'select') as anon,
      has_table_privilege('authenticated', $1, 'select') as authenticated,
      has_table_privilege('service_role', $1, 'select') as service`, [view])
    assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true })
    const opts = await db.query('select reloptions from pg_class where relname=$1', [view])
    assert.ok(opts.rows[0].reloptions.includes('security_invoker=true'))
  }
  console.log('Reporting views passed: complete totals, tenant filter, UTC boundary, JSON semantics, invoker security, service-role-only grants.')
} finally { await db.close() }
