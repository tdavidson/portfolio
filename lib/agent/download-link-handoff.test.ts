import { describe, expect, it } from 'vitest'
import { DOWNLOAD_LINK_HANDOFF, linkNote } from '@/lib/agent/report-links'

// A host that keeps a project's files as text refuses a PDF ("NUL bytes"), so every download link
// tells the assistant to hand the link over and to keep only text in such a store.
describe('download link hand-off', () => {
  it('says the file is binary, goes to the person, and names the text form for text stores', () => {
    expect(DOWNLOAD_LINK_HANDOFF).toMatch(/Give the person this link/)
    expect(DOWNLOAD_LINK_HANDOFF).toMatch(/don't fetch the file yourself to save it/)
    expect(DOWNLOAD_LINK_HANDOFF).toMatch(/binary/)
    expect(DOWNLOAD_LINK_HANDOFF).toMatch(/text form/)
  })

  it('appends the rule to a link note', () => {
    expect(linkNote('The link works for an hour. ')).toBe(`The link works for an hour. ${DOWNLOAD_LINK_HANDOFF}`)
  })
})
