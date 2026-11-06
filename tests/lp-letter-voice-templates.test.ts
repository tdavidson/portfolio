import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The fund's letter voice: learned from past letters as a draft, edited, then chosen as the one
 * letters are written in. Only one template is the fund's voice at a time.
 */

const store = memoryAdmin()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'fund-1', userId: 'u1', role: 'admin' }) }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/parsing/extractAttachmentText', () => ({
  extractFromBuffer: async (buf: Buffer, name: string) => ({ extractedText: name.startsWith('blank') ? '' : buf.toString('utf8') }),
}))
const filler = 'x'.repeat(250)
const answer = vi.fn(async () => ({
  text: `=====STRUCTURE=====\n## Sections\nOpening, then company updates. ${filler}\n=====VOICE=====\n## Who is speaking\nThe partners, as "we". ${filler}\n=====EXAMPLES=====\n## Status paragraph\nQuillon Systems grew to $3.4M. Acme Robotics grew 20%. ${filler}`,
  usage: { inputTokens: 1, outputTokens: 1 },
}))
vi.mock('@/lib/ai', () => ({ createFundAIProvider: async () => ({ provider: { createMessage: answer }, model: 'm', providerType: 'anthropic' }) }))
vi.mock('@/lib/ai/usage', () => ({ logAIUsage: async () => {} }))

import { POST } from '@/app/api/lp-letters/templates/route'
import { PATCH } from '@/app/api/lp-letters/templates/[id]/route'
import { templateEdit } from '@/lib/lp-letters/templates'

const upload = (files: [string, string][], name = 'House voice') => {
  const form = new FormData()
  for (const [n, text] of files) form.append('file', new File([text], n))
  form.append('name', name)
  return POST(new NextRequest('http://localhost/api/lp-letters/templates', { method: 'POST', body: form }))
}
const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/lp-letters/templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  answer.mockClear()
  store.tables.lp_letter_templates = [
    { id: 't-old', fund_id: 'fund-1', name: 'Old', style_guide: 'Old voice.', is_default: true },
    { id: 't-other', fund_id: 'fund-2', name: 'Theirs', style_guide: 'x', is_default: true },
  ]
})

describe('learning a voice from past letters', () => {
  it('reads every document in one call and saves a draft that is not the fund voice yet', async () => {
    const res = await upload([
      ['q1.docx', 'Quillon Systems grew to $3.4M in the quarter.'],
      ['q2.pdf', 'We marked the fund at 1.2x.'],
      ['blank.pdf', ''],
    ])
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(answer).toHaveBeenCalledTimes(1)
    const prompt = (answer.mock.calls[0] as any[])[0].content as string
    expect(prompt).toContain('filename="q1.docx"')
    expect(prompt).toContain('filename="q2.pdf"')
    expect(body).toMatchObject({ name: 'House voice', is_default: false, source_type: 'upload', source_format: null, source_filename: '2 documents' })
    expect(body.structure).toMatch(/^## Sections/)
    expect(body.style_guide).toMatch(/^## Who is speaking/)
    expect(body.examples).toMatch(/^## Status paragraph/)
    expect(body.source_files).toEqual([{ filename: 'q1.docx', chars: 45 }, { filename: 'q2.pdf', chars: 27 }])
    // The name and figure copied from a letter are flagged; the invented ones are not.
    expect(body.reused_from_sources.sort()).toEqual(['$3.4M', 'Quillon Systems'])
    expect(body.unread_files).toEqual(['blank.pdf'])
    expect(store.tables.lp_letter_templates.find((t: any) => t.id === 't-old')!.is_default).toBe(true)
  })

  it('refuses files with no text, and an answer not in the asked format', async () => {
    expect((await upload([['blank.pdf', '']])).status).toBe(400)
    answer.mockResolvedValueOnce({ text: 'I could not do that.', usage: { inputTokens: 1, outputTokens: 1 } })
    const res = await upload([['q1.docx', 'Some letter.']])
    expect(res.status).toBe(502)
    expect(store.tables.lp_letter_templates).toHaveLength(2)
  })
})

describe('editing and choosing the fund voice', () => {
  it('saves the voice, examples and house rules', async () => {
    const res = await patch('t-old', { name: ' Edited ', structure: 'Opening, then updates.', style_guide: 'New voice.', examples: 'Ex.', house_rules: 'Rule.', fund_id: 'fund-2' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'Edited', structure: 'Opening, then updates.', style_guide: 'New voice.', examples: 'Ex.', house_rules: 'Rule.', fund_id: 'fund-1' })
  })

  it("makes one template the fund's voice and unsets the fund's others, never another fund's", async () => {
    store.tables.lp_letter_templates.push({ id: 't-new', fund_id: 'fund-1', name: 'New', style_guide: 'v', is_default: false })
    const res = await patch('t-new', { is_default: true, house_rules: 'Rule.' })
    expect(await res.json()).toMatchObject({ id: 't-new', is_default: true, house_rules: 'Rule.' })
    const byId = Object.fromEntries(store.tables.lp_letter_templates.map((t: any) => [t.id, t.is_default]))
    expect(byId).toEqual({ 't-old': false, 't-new': true, 't-other': true })
    expect((await patch('t-other', { is_default: true })).status).toBe(404)
  })

  it('takes only text within limits, and a name that is not blank', () => {
    expect(templateEdit({ name: '  ' })).toMatchObject({ ok: false })
    expect(templateEdit({ examples: 5 })).toMatchObject({ ok: false })
    expect(templateEdit({ house_rules: 'x'.repeat(20_001) })).toMatchObject({ ok: false })
    expect(templateEdit({ examples: '  ', house_rules: 'Rule.', other: 'x' })).toEqual({ ok: true, value: { examples: null, house_rules: 'Rule.' } })
  })
})
