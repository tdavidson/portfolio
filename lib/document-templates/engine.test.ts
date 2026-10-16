import { describe, it, expect } from 'vitest'
import { renderTemplate, parseTemplate, TemplateError } from './engine'

const r = (tpl: string, data: unknown = {}) => renderTemplate(tpl, data).html

describe('document template engine', () => {
  it('interpolates and escapes', () => {
    expect(r('Hi {{name}}', { name: '<b>LP</b>' })).toBe('Hi &lt;b&gt;LP&lt;/b&gt;')
    expect(r('{{a.b.c}}', { a: { b: { c: 7 } } })).toBe('7')
    expect(r('[{{missing}}][{{obj}}]', { obj: { x: 1 } })).toBe('[][]')
  })

  it('never reaches a prototype', () => {
    expect(r('{{constructor}}{{name.constructor.name}}{{__proto__}}', { name: 'x' })).toBe('')
    expect(r('{{toString}}', {})).toBe('')
  })

  it('loops with locals, else, and outward lookup', () => {
    const tpl = '{{#each rows}}{{@index}}:{{name}}/{{fund}}{{#if @last}}.{{else}},{{/if}}{{else}}none{{/each}}'
    expect(r(tpl, { fund: 'F', rows: [{ name: 'a' }, { name: 'b' }] })).toBe('0:a/F,1:b/F.')
    expect(r(tpl, { rows: [] })).toBe('none')
    expect(r('{{#each rows}}{{../title}}{{this}}{{/each}}', { title: 'T', rows: [1, 2] })).toBe('T1T2')
    expect(r('{{#with a}}{{b}}{{@root.c}}{{/with}}', { a: { b: 1 }, c: 2 })).toBe('12')
  })

  it('formats money, numbers, percentages, multiples and dates', () => {
    expect(r('{{usd 6420000}} {{usd -2250}} {{usd 1.5 2}}')).toBe('$6,420,000 ($2,250) $1.50')
    expect(r('{{num 0}} {{num -104500}} {{num 35000}}')).toBe('- -104,500 35,000')
    expect(r('{{pct 0.873}} {{pct (div 280000 5000000)}} {{mult (div 6420000 6750000)}}')).toBe('87.3% 5.6% 0.95x')
    expect(r('{{date d}} {{date d "short"}} {{quarter d}}', { d: '2026-03-31' })).toBe('March 31, 2026 3/31 Q1 2026')
  })

  it('treats a lone name as a value even when a helper shares it', () => {
    expect(r('{{quarter}}', { quarter: 'Q1' })).toBe('Q1')
  })

  it('aggregates lists', () => {
    const inv = [
      { name: 'A', cat: 'Fund', q: { funded: 35000 }, v: 100 },
      { name: 'B', cat: 'Direct', q: { funded: 0 }, v: 50 },
      { name: 'C', cat: 'Fund', q: { funded: 20000 }, v: 50 },
    ]
    expect(r('{{sum inv "q.funded"}}', { inv })).toBe('55000')
    expect(r('{{join (where inv "q.funded" "gt" 0) "name"}}', { inv })).toBe('A and C')
    expect(r('{{count (where inv "cat" "eq" "Fund")}}', { inv })).toBe('2')
    const tpl = '{{#each (groupSum inv "cat" "v" "Direct=Direct Equity|Fund=Funds")}}{{label}} {{pct share}} {{color}};{{/each}}'
    expect(r(tpl, { inv })).toBe('Direct Equity 25.0% #2a78d6;Funds 75.0% #eb6834;')
  })

  it('grays out "Other" and draws a donut', () => {
    const html = r('{{#each (parts t "name" "pct")}}{{color}} {{/each}}{{donut (parts t "name" "pct") "Tokens" "$1"}}',
      { t: [{ name: 'USDC', pct: 90 }, { name: 'Other', pct: 10 }] })
    expect(html.startsWith('#2a78d6 #8a8983 <svg')).toBe(true)
    expect(html).toContain('<path')
  })

  it('returns failed checks as warnings, rendering nothing', () => {
    const out = renderTemplate('x{{check (near a b 1) "Totals do not tie"}}y', { a: 640001, b: 640000 })
    expect(out).toEqual({ html: 'xy', warnings: [] })
    expect(renderTemplate('{{check (eq 1 2) "Totals do not tie"}}', {}).warnings).toEqual(['Totals do not tie'])
  })

  it('refuses malformed templates with a reason', () => {
    expect(() => parseTemplate('{{#each rows}}x')).toThrow(TemplateError)
    expect(() => parseTemplate('{{/if}}')).toThrow(/Unexpected/)
    expect(() => parseTemplate('{{#script x}}{{/script}}')).toThrow(/Unknown block/)
    expect(() => parseTemplate('{{nothelper a b}}')).toThrow(/Unknown helper/)
    expect(() => parseTemplate('{{usd "x}}')).toThrow(/Unclosed string/)
  })
})
