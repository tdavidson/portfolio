import { describe, expect, it } from 'vitest'
import { diffDraft, normalizeDocText, parseGoogleDocUrl } from './pull'

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

describe('parseGoogleDocUrl', () => {
  it('takes the id from a link or a bare id, and nothing else', () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toBe(ID)
    expect(parseGoogleDocUrl(`https://docs.google.com/document/u/1/d/${ID}/edit`)).toBe(ID)
    expect(parseGoogleDocUrl(` ${ID} `)).toBe(ID)
    expect(parseGoogleDocUrl('https://drive.google.com/drive/folders/abc')).toBeNull()
    expect(parseGoogleDocUrl('https://example.com/document/d/short/edit')).toBeNull()
  })
})

describe('normalizeDocText', () => {
  it('drops the BOM, Windows line ends, trailing spaces and runs of blank lines', () => {
    expect(normalizeDocText('﻿Dear Investors,  \r\n\r\n\r\n\r\nAcme grew. \r\n')).toBe('Dear Investors,\n\nAcme grew.')
  })
})

describe('diffDraft', () => {
  it('counts and lists the lines added and removed, in order', () => {
    const d = diffDraft('Opening\n\nAcme grew.\nBirch held.\nClosing', 'Opening\nAcme grew fast.\nBirch held.\nClosing\nP.S.')
    expect(d).toMatchObject({ added: 2, removed: 1, unchanged: 3 })
    expect(d.changes).toEqual([
      { kind: 'removed', line: 'Acme grew.' },
      { kind: 'added', line: 'Acme grew fast.' },
      { kind: 'added', line: 'P.S.' },
    ])
  })
  it('is empty when only blank lines and spacing differ, and caps the list', () => {
    expect(diffDraft('A\n\nB', '  A\nB  ')).toMatchObject({ added: 0, removed: 0, changes: [] })
    expect(diffDraft('', Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n'), 3).changes).toHaveLength(3)
  })
})
