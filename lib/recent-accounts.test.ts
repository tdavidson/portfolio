import { describe, expect, it } from 'vitest'
import { withRecent, __test } from './recent-accounts'

describe('withRecent', () => {
  it('puts the account first, lower-cased, without duplicates', () => {
    const list = [
      { email: 'a@laconia.com', fundName: 'Laconia' },
      { email: 'b@3se.com', fundName: '3SE' },
    ]
    expect(withRecent(list, { email: ' B@3SE.com ', fundName: '3SE Holdings' })).toEqual([
      { email: 'b@3se.com', fundName: '3SE Holdings' },
      { email: 'a@laconia.com', fundName: 'Laconia' },
    ])
  })

  it('caps the list', () => {
    let list: { email: string; fundName: string }[] = []
    for (let i = 0; i < 10; i++) list = withRecent(list, { email: `u${i}@x.com`, fundName: 'F' })
    expect(list).toHaveLength(__test.MAX)
    expect(list[0].email).toBe('u9@x.com')
  })

  it('ignores something that is not an email', () => {
    expect(withRecent([], { email: 'nope', fundName: 'F' })).toEqual([])
  })
})

describe('parse', () => {
  it('drops malformed storage instead of throwing', () => {
    expect(__test.parse('not json')).toEqual([])
    expect(__test.parse('{"email":"a@b.c"}')).toEqual([])
    expect(__test.parse('[{"email":"a@b.c","fundName":"F"},{"email":1},null]')).toEqual([
      { email: 'a@b.c', fundName: 'F' },
    ])
  })
})
