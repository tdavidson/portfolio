import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/**
 * A fund's letter structure, voice and examples are its own data: they live in its letter template
 * (lp_letter_templates) and never in this repo. The skill in plugin/skills/lp-quarterly-letter is the
 * process and a general outline only.
 *
 * This guards against a fund's letter text being copied in. tests/fixtures/blocked-letter-text.txt
 * holds fingerprints of letter text a fund has shared: truncated SHA-256 hashes of runs of eight
 * lower-cased words (a quarter of them, picked by hash), so the list reveals none of it. A file that
 * repeats a passage of that text matches several. To fingerprint more, hash each eight-word run of
 * the text the same way, keep those whose hash is divisible by 4, and add them to the list.
 *
 * Like no-real-names.test.ts, passing it doesn't make a change clean; it only catches known text.
 */
const RUN = 8
const LIMIT = 3

const blocked = new Set(readFileSync('tests/fixtures/blocked-letter-text.txt', 'utf8').split('\n').filter(Boolean))
const SKIP = /(^|\/)(package-lock\.json|vendor\/|public\/|demo-widget\/data\/)|\.generated\.ts$|^lib\/types\/database\.ts$|^tests\/fixtures\/blocked-letter-text\.txt$|\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|tgz|xlsx|docx)$/
// Letter text could land in any prose or source file. Images, data, lockfiles and generated files
// are left out: the generated plugin bundle copies plugin/skills, which is checked itself.
const TEXT = /\.(md|mdx|txt|ts|tsx|js|mjs|cjs|sql|json|ya?ml|html|css)$/
const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(f => f && TEXT.test(f) && !SKIP.test(f))
const textOf = (f: string) => {
  try { return statSync(f).size < 2_000_000 ? readFileSync(f, 'utf8') : '' } catch { return '' }
}

/** How many of the text's eight-word runs are fingerprinted. */
export function matches(text: string): number {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  let n = 0
  const seen = new Set<string>()
  for (let i = 0; i + RUN <= words.length; i++) {
    const run = words.slice(i, i + RUN).join(' ')
    if (seen.has(run)) continue
    seen.add(run)
    if (blocked.has(createHash('sha256').update(run).digest('hex').slice(0, 12))) n++
  }
  return n
}

describe("no fund's letter text in the repo", () => {
  it('has fingerprints to check against', () => {
    expect(blocked.size).toBeGreaterThan(100)
  })

  it("repeats no passage of a fund's letter structure, voice or examples", () => {
    const hits = files.map(f => [f, matches(textOf(f))] as const).filter(([, n]) => n >= LIMIT)
    expect(hits, "a fund's letter text belongs in its letter template, not the repo").toEqual([])
  }, 60_000)
})
