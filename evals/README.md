# Skill evals

Invented cases that the letter and memo skills (`plugin/skills/lp-quarterly-letter`,
`plugin/skills/investment-memo`) are graded against. Run them before changing a skill, or before
pointing the skills at a new model, so a regression shows up here first.

Every fund, company, person and figure in these files is invented. Keep it that way: never build
a case from a real fund's letter, memo or data room, even with the names changed.

## Run

```bash
npm run evals                                    # every case of both skills, once
npm run evals -- --skill investment-memo --runs 3
npm run evals -- --case mixed-quarter --model claude-opus-4-8
npm run evals -- --provider openai --model gpt-4.1
```

The key is `EVAL_API_KEY`, or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for the provider (a
`.env.local` is read if there is one). Each run sends the skill's `SKILL.md` and references as the
system prompt and the case's brief as the tool result the skill would have fetched, then grades
the reply. Replies and `summary.json` go to `evals/results/` (gitignored). The script exits
non-zero when a case fails, and prints why.

To grade a letter or memo written somewhere else, such as a Claude conversation with the skill
installed, save the reply and pass it with `--grade`. No key is needed:

```bash
npm run evals -- --skill lp-quarterly-letter --case mixed-quarter --grade my-letter.txt
```

## How a reply is graded

- **The review Hemrock already runs.** A letter goes through `reviewLetter`
  (`lib/lp-letters/review.ts`), the same flags a draft gets when it is saved: numbers not in the
  sources, gross or net labels, events not stated plainly, investors named, stale or confidential
  text, dates, words the house rules avoid, other entities' companies, and the "Missing
  information" notes. A memo goes through `buildParagraphs` and `reviewParagraphs`
  (`lib/memo-agent`): citations, figures, recommendations outside the partners' section, team
  judgments, unlabeled projections and empty sections.
- **The case's own expectations** (`expect` in the case file): text that must or must not appear
  (case-insensitive regular expressions, optionally in one section), what the "Missing
  information" notes or the attention list must mention, a word limit for a section, and, for a
  memo, that company figures are attributed to the company.

A review flag fails the case unless the case lists its kind in `allowed_flags`.

## Cases

| Skill | Case | What it checks |
|---|---|---|
| Letter | `mixed-quarter` | A write-off and a down round stated plainly, a confidential update kept out, an old stored update not presented as news, a missing net figure left as a placeholder and listed, a short section for a company with nothing new |
| Letter | `exit-and-new-investment` | A year-end letter with an exit and escrow, a new investment's terms, an event after the quarter that is not yet public, and house-rule words to avoid |
| Memo | `first-round-contradiction` | A customer count the data room and research disagree on, an unverified market size, a projection, attribution of company claims, and the partners' recommendation left alone |
| Memo | `thin-evidence` | A thin data room: say what is unknown, invent nothing, and leave out sections with no evidence |

## Add a case

1. Write `evals/<skill>/<id>.json` with `id`, `description`, `brief` (what `lp_letter_brief` or
   `diligence_memo_brief` returns) and `expect`. Types: `LetterCase` in
   `lib/skill-evals/letter.ts`, `MemoCase` in `lib/skill-evals/memo.ts`.
2. Write a good reply beside it (`<id>.good.txt` for a letter, `<id>.good.json` for a memo), and
   optionally a bad one (`<id>.bad.*`) that the case should fail.
3. `npx vitest run lib/skill-evals` checks that the good reply passes and the bad one fails, so a
   case that no skill could pass never lands. CI runs this test; it calls no model.
