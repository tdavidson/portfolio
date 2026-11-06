import { describe, expect, it } from 'vitest'
import { MEMO_SKILL_MD, MEMO_SKILL_VERSION, memoSkillForWriter, memoVoice, memoVoiceBlock } from './skill'
import { listMemoSkillResources, readMemoSkillResource } from './skill-resources'

describe('investment-memo skill', () => {
  it('is bundled with a version and the sections a writer needs', () => {
    expect(MEMO_SKILL_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(memoSkillForWriter()).toContain('## Hard rules')
    expect(MEMO_SKILL_MD).toContain('diligence_memo_brief')
  })

  it("uses the fund's voice when it has one, else the general one", () => {
    expect(memoVoice(null).source).toBe('default')
    expect(memoVoiceBlock(memoVoice(null))).toBe('')
    const v = memoVoice({ voice: 'Short sentences.', house_rules: 'Dates as 2026-01-15.', examples: 'An example.' })
    expect(v.source).toBe('fund')
    expect(memoVoiceBlock(v)).toContain('Short sentences.')
    expect(memoVoiceBlock(v)).toContain('HOUSE RULES')
  })

  it('serves its files as MCP resources and nothing else', () => {
    const uris = listMemoSkillResources().map(r => r.uri)
    expect(uris).toContain('skill://investment-memo/SKILL.md')
    expect(readMemoSkillResource(uris[0])!.contents[0].text).toBe(MEMO_SKILL_MD)
    expect(readMemoSkillResource('skill://investment-memo/../secrets')).toBeNull()
  })
})
