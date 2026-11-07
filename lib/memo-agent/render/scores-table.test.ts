import { describe, expect, it } from 'vitest'
import { Packer, Document } from 'docx'
import JSZip from 'jszip'
import { buildScoresTable } from './docx'
import { renderMarkdown } from './markdown'
import { dimensionLabel, scoreLabel } from './scores-table'

const scores: any[] = [
  { dimension_id: 'team_founder_market_fit', mode: 'machine', score: 4, confidence: 'high', rationale: 'Strong references.\nGo-to-market lead is new.', supporting_evidence: [] },
  { dimension_id: 'conviction', mode: 'partner_only', score: null, confidence: null, rationale: '', supporting_evidence: [] },
]

async function tableXml(): Promise<string> {
  const doc = new Document({ sections: [{ children: [buildScoresTable(scores)] }] })
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc))
  return zip.file('word/document.xml')!.async('string')
}

describe('memo scoring table', () => {
  it('gives Word and Google Drive real column widths, fixed, within the page', async () => {
    const xml = await tableXml()
    const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]))
    expect(grid).toHaveLength(4)
    expect(Math.min(...grid)).toBeGreaterThanOrEqual(900)
    expect(grid.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9026)
    expect(grid[3]).toBe(Math.max(...grid)) // rationale gets the room
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>')
    expect(xml).toContain('<w:tblHeader/>')
  })

  it('prints readable labels and leaves out the scoring mode', async () => {
    const xml = await tableXml()
    expect(xml).toContain('Team founder market fit')
    expect(xml).not.toContain('team_founder_market_fit')
    expect(xml).not.toMatch(/>Mode</)
    expect(xml).not.toContain('>machine<')
  })

  it('labels scores', () => {
    expect(dimensionLabel('market_size_and_timing')).toBe('Market size and timing')
    expect(scoreLabel({ score: null, mode: 'partner_only' })).toBe('Partner')
    expect(scoreLabel({ score: null, mode: 'machine' })).toBe('—')
    expect(scoreLabel({ score: 0 as any, mode: 'machine' })).toBe('0')
  })

  it('keeps the Markdown table to four columns on one line per row', () => {
    const md = renderMarkdown({
      memo: { header: {}, paragraphs: [], scores } as any,
      memoOutputYaml: '', rubricYaml: '', isDraft: false, dealName: 'Example Co', draftVersion: 'v1',
    })
    const rows = md.split('\n').filter(l => l.startsWith('|'))
    expect(rows[0]).toBe('| Dimension | Score | Confidence | Rationale |')
    expect(rows[2]).toBe('| Team founder market fit | 4 | High | Strong references. Go-to-market lead is new. |')
    expect(rows[3]).toBe('| Conviction | Partner | — |  |')
  })
})
