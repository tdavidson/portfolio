import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE_GUIDE } from './default-template'
import {
  DEFAULT_EXAMPLES_MD, DEFAULT_VOICE_MD, LETTER_SKILL_MD, LETTER_SKILL_VERSION, WRITER_SECTIONS, letterVoice, sectionsOf, skillForWriter, voiceAsStyleGuide,
} from './skill'
import { listSkillResources, readSkillResource } from './skill-resources'

describe('the lp-quarterly-letter skill', () => {
  it('is bundled from plugin/, with a version', () => {
    expect(LETTER_SKILL_MD).toMatch(/^---\nname: lp-quarterly-letter\n/)
    expect(LETTER_SKILL_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(DEFAULT_VOICE_MD).toMatch(/^# Voice/)
    expect(DEFAULT_EXAMPLES_MD).toMatch(/^# Examples/)
  })

  it("gives the app's writer the structure, sizing, voice and checklist, not the tool workflow", () => {
    const text = skillForWriter()
    for (const s of WRITER_SECTIONS) expect(text).toContain(`## ${s}`)
    expect(text).not.toContain('## Workflow')
    expect(text).not.toContain('## Output document')
    expect(text).toContain('general outline')
  })

  it('names a missing section rather than writing without it', () => {
    expect(() => skillForWriter('---\nname: x\n---\n## Structure\nOnly this.')).toThrow(/no section "Fund profile"/)
    expect([...sectionsOf('---\nname: x\n---\n## A\none\n## B\ntwo').keys()]).toEqual(['A', 'B'])
  })
})

describe('the voice a letter is written in', () => {
  it("is the fund's own saved style guide when it has one", () => {
    expect(letterVoice({ name: 'House voice', styleGuide: 'Write like us.' })).toEqual({
      source: 'fund', template: 'House voice', voice: 'Write like us.', examples: '', houseRules: '', structure: '',
    })
  })

  it("carries the fund's own examples and its house rules", () => {
    const v = letterVoice({ name: 'House voice', styleGuide: 'Write like us.', examples: '## New investments\nAcme.', houseRules: 'ARR to one decimal.' })
    expect(v).toMatchObject({ source: 'fund', examples: '## New investments\nAcme.', houseRules: 'ARR to one decimal.' })
    // House rules add to the general voice too.
    expect(letterVoice({ name: 'Rules only', styleGuide: null, houseRules: 'Sign from both partners.' }))
      .toMatchObject({ source: 'default', template: 'Rules only', houseRules: 'Sign from both partners.', examples: DEFAULT_EXAMPLES_MD.trim() })
  })

  it('folds the voice into one style guide for the per-company writer, leaving out the general examples', () => {
    const own = voiceAsStyleGuide(letterVoice({ name: 'H', styleGuide: 'Write like us.', examples: 'Ex.', houseRules: 'Rule.' }))
    expect(own).toContain('Write like us.')
    expect(own.indexOf('Ex.')).toBeLessThan(own.indexOf('HOUSE RULES'))
    expect(own).toContain('Rule.')
    expect(voiceAsStyleGuide(letterVoice(null))).toBe(DEFAULT_VOICE_MD.trim())
  })

  it("is the skill's general voice and examples otherwise, including for the old built-in Default", () => {
    for (const t of [null, { name: 'Default', styleGuide: null }, { name: 'Default', styleGuide: DEFAULT_STYLE_GUIDE }, { name: 'x', styleGuide: '  ' }]) {
      const v = letterVoice(t)
      expect(v.source).toBe('default')
      expect(v.voice).toBe(DEFAULT_VOICE_MD.trim())
      expect(v.examples).toBe(DEFAULT_EXAMPLES_MD.trim())
    }
  })
})

describe('the skill as MCP resources', () => {
  it('lists and reads the three files, and nothing else', () => {
    const uris = listSkillResources().map(r => r.uri)
    expect(uris).toEqual([
      'skill://lp-quarterly-letter/SKILL.md', 'skill://lp-quarterly-letter/references/voice.md', 'skill://lp-quarterly-letter/references/examples.md',
    ])
    expect(readSkillResource(uris[0])!.contents[0].text).toBe(LETTER_SKILL_MD)
    expect(readSkillResource('skill://lp-quarterly-letter/../secrets')).toBeNull()
    expect(readSkillResource('ui://portfolio/dashboard.html')).toBeNull()
  })
})
