import { describe, expect, it } from 'vitest'
import { fitDocuments, learnVoicePrompt, parseLearnedVoice, reusedFromSources, MAX_DOCUMENTS } from './learn-voice'

const doc = (filename: string, n: number, ch = 'a') => ({ filename, text: ch.repeat(n) })

describe('fitDocuments', () => {
  it('keeps everything when it fits', () => {
    const out = fitDocuments([doc('a.pdf', 10), doc('b.pdf', 20)], 100)
    expect(out.map(d => d.text.length)).toEqual([10, 20])
  })

  it('gives a short document its whole text and its spare share to the long ones', () => {
    const out = fitDocuments([doc('long.pdf', 1000), doc('short.pdf', 10), doc('mid.pdf', 1000)], 310)
    expect(out.map(d => d.text.length)).toEqual([150, 10, 150])
    expect(out.map(d => d.filename)).toEqual(['long.pdf', 'short.pdf', 'mid.pdf'])
  })

  it('never goes over the budget, drops empty documents and keeps at most the limit', () => {
    const many = Array.from({ length: MAX_DOCUMENTS + 3 }, (_, i) => doc(`d${i}.pdf`, 50 + i))
    const out = fitDocuments([{ filename: 'blank.pdf', text: '  \n ' }, ...many], 333)
    expect(out).toHaveLength(MAX_DOCUMENTS)
    expect(out.some(d => d.filename === 'blank.pdf')).toBe(false)
    expect(out.reduce((n, d) => n + d.text.length, 0)).toBeLessThanOrEqual(333)
  })
})

describe('learnVoicePrompt', () => {
  it('fences each document as reference data and asks for invented examples', () => {
    const p = learnVoicePrompt([{ filename: 'Q1 "letter" <x>.docx', text: 'We closed the quarter.' }])
    expect(p).toContain('<data label="document-1" filename="Q1 letter x.docx" type="reference-only">\nWe closed the quarter.\n</data>')
    expect(p).toContain('must be INVENTED')
    expect(p).toContain('=====STRUCTURE=====')
    expect(p).toContain('Quote in full any paragraph that repeats')
    expect(p).toContain('THE FUND\'S DOCUMENTS (1)')
  })
})

describe('parseLearnedVoice', () => {
  const long = (s: string) => `## ${s}\n${'x'.repeat(250)}`
  const S = '=====STRUCTURE=====', V = '=====VOICE=====', E = '=====EXAMPLES====='
  it('splits the structure, the voice and the examples', () => {
    const out = parseLearnedVoice(`Sure.\n${S}\n${long('Sections')}\n${V}\n${long('Voice')}\n${E}\n${long('Examples')}\n`)
    expect(out.structure.startsWith('## Sections')).toBe(true)
    expect(out.voice.startsWith('## Voice')).toBe(true)
    expect(out.examples.startsWith('## Examples')).toBe(true)
  })
  it('refuses an answer missing a part, out of order, or with a part too short to use', () => {
    expect(() => parseLearnedVoice(`${V}\n${long('V')}\n${E}\n${long('E')}`)).toThrow('did not return')
    expect(() => parseLearnedVoice(`${S}\n${long('S')}\n${E}\n${long('E')}\n${V}\n${long('V')}`)).toThrow('did not return')
    expect(() => parseLearnedVoice(`${S}\nshort\n${V}\n${long('V')}\n${E}\n${long('E')}`)).toThrow('too short')
  })
})

describe('reusedFromSources', () => {
  it('flags names and figures the examples took from the documents, not invented ones', () => {
    const docs = [{ filename: 'a.pdf', text: 'Quillon Systems grew ARR to $3.4M, up 41%, and the fund is at 2.6x.' }]
    const examples = 'Quillon Systems reached $3.4M of ARR. Acme Robotics grew 41% and Zephyr Labs is at 1.9x.'
    expect(reusedFromSources(examples, docs).sort()).toEqual(['$3.4M', '41%', 'Quillon Systems'].sort())
  })
})
