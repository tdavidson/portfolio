// Charts the partners upload into a letter: images with captions, placed after a section.
//
// The images are immutable. Each is stored in the private lp-letter-charts bucket under its own
// hash, never overwritten, and a letter's charts list (lp_letters.charts) only points at them. So a
// letter, once final or shared, prints the same images it was reviewed with: taking a chart off a
// draft or changing its caption changes the list, never a stored image. Read with the service-role
// key only; every caller has already passed the lp_letters gate and the entity check (getLetter).

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLetter } from './service'
import { chartsOf, imageSize, sniffImage, type LetterChart } from './document'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'

type Admin = SupabaseClient
type Ctx = { fundId: string; userId: string; visible: string[] | null }

export const CHART_BUCKET = 'lp-letter-charts'
export const MAX_CHART_BYTES = 5 * 1024 * 1024
export const MAX_CHARTS = 20

async function editable(admin: Admin, ctx: Ctx, letterId: string): Promise<Outcome<any>> {
  const found = await getLetter(admin, ctx.fundId, ctx.visible, letterId)
  if (!found.ok) return found
  if (!found.value) return fail(404, 'Not found')
  // A final letter is what was reviewed and may have been sent: its images stay as they were.
  if (found.value.status === 'final') return fail(409, 'This letter is final. Set it back to draft to change its charts.')
  if (found.value.status === 'generating') return fail(409, 'This letter is being generated. Try again when it finishes.')
  return found
}

async function saveCharts(admin: Admin, ctx: Ctx, letterId: string, charts: LetterChart[]): Promise<Outcome<LetterChart[]>> {
  const { error } = await (admin as any).from('lp_letters')
    .update({ charts, updated_at: new Date().toISOString() })
    .eq('id', letterId).eq('fund_id', ctx.fundId)
  if (error) return dbFail(error, 'lp-letters-charts')
  return done(charts)
}

const cleanCaption = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null)

/** Add an image (PNG or JPEG, by its bytes) to a draft letter, after a section or at the end. */
export async function addChart(
  admin: Admin, ctx: Ctx, letterId: string,
  input: { bytes: Uint8Array; caption?: unknown; sectionId?: unknown },
): Promise<Outcome<LetterChart[]>> {
  const found = await editable(admin, ctx, letterId)
  if (!found.ok) return found
  const type = sniffImage(input.bytes)
  if (!type) return fail(400, 'A chart must be a PNG or JPEG image.')
  if (input.bytes.length > MAX_CHART_BYTES) return fail(400, 'A chart image must be 5 MB or less.')
  const current = chartsOf(found.value)
  if (current.length >= MAX_CHARTS) return fail(400, `A letter can have at most ${MAX_CHARTS} charts.`)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const path = `${ctx.fundId}/${letterId}/${sha256}.${type === 'image/png' ? 'png' : 'jpg'}`
  // upsert false: an object at that path is this same image, already stored.
  const { error: upErr } = await (admin as any).storage.from(CHART_BUCKET).upload(path, input.bytes, { contentType: type, upsert: false })
  if (upErr && !/exist|duplicate/i.test(String(upErr.message ?? ''))) return fail(500, 'Could not store the chart image.')
  const size = imageSize(input.bytes)
  const chart: LetterChart = {
    id: `chart-${sha256.slice(0, 8)}-${Date.now().toString(36)}`,
    section_id: typeof input.sectionId === 'string' && input.sectionId ? input.sectionId.slice(0, 200) : null,
    caption: cleanCaption(input.caption),
    path, content_type: type, sha256,
    width: size?.width ?? null, height: size?.height ?? null,
    uploaded_at: new Date().toISOString(), uploaded_by: ctx.userId,
  }
  return saveCharts(admin, ctx, letterId, [...current, chart])
}

/** Change a chart's caption or place. The image stays as stored. */
export async function updateChart(
  admin: Admin, ctx: Ctx, letterId: string, chartId: string, change: { caption?: unknown; sectionId?: unknown },
): Promise<Outcome<LetterChart[]>> {
  const found = await editable(admin, ctx, letterId)
  if (!found.ok) return found
  const current = chartsOf(found.value)
  if (!current.some(c => c.id === chartId)) return fail(404, 'No such chart on this letter.')
  return saveCharts(admin, ctx, letterId, current.map(c => (c.id !== chartId ? c : {
    ...c,
    ...(change.caption !== undefined ? { caption: cleanCaption(change.caption) } : {}),
    ...(change.sectionId !== undefined ? { section_id: typeof change.sectionId === 'string' && change.sectionId ? change.sectionId.slice(0, 200) : null } : {}),
  })))
}

/** Take a chart off a draft letter. The stored image is kept: another version may point at it. */
export async function removeChart(admin: Admin, ctx: Ctx, letterId: string, chartId: string): Promise<Outcome<LetterChart[]>> {
  const found = await editable(admin, ctx, letterId)
  if (!found.ok) return found
  const current = chartsOf(found.value)
  if (!current.some(c => c.id === chartId)) return fail(404, 'No such chart on this letter.')
  return saveCharts(admin, ctx, letterId, current.filter(c => c.id !== chartId))
}

/**
 * The images of a letter's charts, by chart id. Only paths under this fund and letter are read, so
 * a charts list edited by hand can't point a letter at another fund's file.
 */
export async function chartBytes(admin: Admin, fundId: string, letterId: string, charts: LetterChart[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  const prefix = `${fundId}/${letterId}/`
  await Promise.all(charts.map(async c => {
    if (!c.path.startsWith(prefix) || c.path.includes('..')) return
    const { data, error } = await (admin as any).storage.from(CHART_BUCKET).download(c.path)
    if (error || !data) return
    const bytes = new Uint8Array(await data.arrayBuffer())
    // The file must still be the image the letter was reviewed with.
    if (createHash('sha256').update(bytes).digest('hex') !== c.sha256) return
    out.set(c.id, bytes)
  }))
  return out
}

/** Each chart as an inline data URI, for the PDF, which renders offline. */
export function chartDataUris(charts: LetterChart[], bytes: Map<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of charts) {
    const b = bytes.get(c.id)
    if (b) out.set(c.id, `data:${c.content_type};base64,${Buffer.from(b).toString('base64')}`)
  }
  return out
}
