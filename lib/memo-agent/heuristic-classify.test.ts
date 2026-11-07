import { describe, expect, it } from 'vitest'
import { classifyDocumentHeuristic } from './heuristic-classify'

describe('classifyDocumentHeuristic: org chart', () => {
  it.each([
    'Org Chart.pdf',
    'org_chart_q3.pptx',
    'Team Org Chart.pdf',
    'Organization Chart.xlsx',
    'organisational-chart.png',
    'team_org_chart.pdf',
  ])('files %s as an org chart', name => {
    expect(classifyDocumentHeuristic(name).detected_type).toBe('org_chart')
  })

  it('leaves other team and deck files alone', () => {
    expect(classifyDocumentHeuristic('Founder bios.pdf').detected_type).toBe('team_bio')
    expect(classifyDocumentHeuristic('Series A deck.pptx').detected_type).toBe('pitch_deck')
    expect(classifyDocumentHeuristic('Operating model.xlsx').detected_type).toBe('financial_model')
  })
})
