import { describe, expect, it } from 'vitest'
import { normalizeForHash, sha256Hex, textSha256 } from './document-fingerprint'
import { decodeCursor, encodeCursor, parsePageRange, selectPages } from './holding-documents'

describe('text hash', () => {
  it('ignores page labels, case, width forms and whitespace', () => {
    const a = '[Page 1]\nQuarterly NAV statement for Example Fund I\n\nNet asset value: 100,000'
    const b = 'QUARTERLY   NAV statement for Ｅxample Fund I net asset value: 100,000\n[Page 2]\n'
    expect(normalizeForHash(a)).toBe(normalizeForHash(b))
    expect(textSha256(a)).toBe(textSha256(b))
  })
  it('has no hash for too little text', () => {
    expect(textSha256('[Page 1]\npage 1')).toBeNull()
    expect(textSha256('')).toBeNull()
    expect(textSha256(null)).toBeNull()
  })
  it('hashes bytes as hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('page selection', () => {
  it('parses ranges', () => {
    expect(parsePageRange('1-3')).toEqual([1, 2, 3])
    expect(parsePageRange('4, 1-2')).toEqual([1, 2, 4])
    expect(parsePageRange('0')).toBeNull()
    expect(parsePageRange('3-1')).toBeNull()
    expect(parsePageRange('abc')).toBeNull()
  })
  it('selects the pages asked for from labelled text', () => {
    const text = '[Page 1]\none\n[Page 2 (OCR)]\ntwo\n[Page 3]\nthree'
    expect(selectPages(text, [2, 3])).toEqual({ text: '[Page 2 (OCR)]\ntwo\n\n[Page 3]\nthree', found: [2, 3] })
    expect(selectPages(text, [9])).toEqual({ text: '', found: [] })
    expect(selectPages('no labels here', [1])).toBeNull()
  })
  it('round-trips a cursor, and starts over on a missing or garbled one', () => {
    expect(decodeCursor(encodeCursor(150))).toBe(150)
    expect(decodeCursor(undefined)).toBe(0)
    expect(decodeCursor('not-a-cursor')).toBe(0)
  })
})
