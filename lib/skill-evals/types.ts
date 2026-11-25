// Skill evals: invented cases a skill's output is graded against, so a change to a skill (or to the
// model it runs on) is checked before it ships. The cases live in evals/<skill>/<id>.json; the
// grading reuses the reviews Hemrock already runs when a letter or memo is saved, plus each case's
// own expectations. See evals/README.md.

/** A text the output must (or must not) contain: a case-insensitive regular expression. */
export interface TextExpectation {
  text: string
  /** Only in this section: a company's name or a heading, matched case-insensitively. */
  section?: string
}

export interface EvalFailure {
  /** What failed: a review flag's kind, or the expectation's name. */
  check: string
  message: string
}

export interface EvalResult {
  case: string
  skill: string
  pass: boolean
  failures: EvalFailure[]
  /** Review flags the case tolerates, reported but not failed. */
  tolerated: EvalFailure[]
}

/** Regexes from a case file: case-insensitive, and a bad one fails loudly rather than matching nothing. */
export function caseRegex(source: string, where: string): RegExp {
  try {
    return new RegExp(source, 'i')
  } catch (e) {
    throw new Error(`${where}: "${source}" is not a valid regular expression (${(e as Error).message}).`)
  }
}

export const words = (s: string) => s.split(/\s+/).filter(Boolean).length
