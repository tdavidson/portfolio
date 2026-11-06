---
name: lp-quarterly-letter
description: Draft a fund's quarterly or year-end investor letter in the fund's own structure and voice, using Hemrock Portfolio data over MCP, and save it as an unshared draft for review.
metadata:
  version: "2.5.0"
---

# Quarterly investor letter

Draft one investor letter for one fund entity and one quarter. The facts come from Hemrock Portfolio through its MCP tools and from what the partners tell you. This skill is the process and the rules. How the letter is laid out and how it reads belong to the fund: its structure, voice, examples and house rules are saved in Hemrock as the fund's letter template, and `lp_letter_skill` returns them. Hemrock's own letter rules apply on top of everything; if they conflict with anything else, follow Hemrock's and tell the person.

The connector may be installed under another name, often the firm's. The tools are the same: `list_funds`, `lp_letter_skill`, `lp_letter_brief`, `lp_draft_letter` and the rest. If they are not available, stop and ask the person to turn the connector on. Never draft from memory or from files outside Hemrock.

## Inputs

- **Entity**: the fund vehicle the letter is for.
- **Period**: year and quarter. A Q4 letter may also be the year-end letter.
- **The fund's letter template**: structure, voice, examples and house rules, from `lp_letter_skill`.
- **The entity's letter profile**: its fixed facts (names, the firm, stage, signatories, company display names and former names, footnotes, fixed paragraphs), from `lp_letter_profile_get` and in the brief as `profile`.
- **The last letter sent**: the entity's most recent final letter in Hemrock, in the brief as `last_final_letter`, for fixed text and continuity.
- **Partner notes**: their view of the market and the quarter, valuation decisions, new investment terms, events after quarter end, and anything to stress or leave out. Ask once at the start. If no one is there to answer, leave marked placeholders. Pass them to `lp_letter_brief` and `lp_draft_letter` as `partner_notes`, and any document they give you (a market report, a board deck) as `sources`, so they are kept with the letter and checked like the other sources.
- **Fund performance figures**: in the brief's `fund_figures`, each with its source and as-of date. Gross IRR and gross MOIC are Hemrock's performance report figures for the total portfolio. Net figures (TVPI, DPI, IRR) are the fund administrator's, as recorded in Hemrock; Hemrock never computes them. All are as of the quarter end, whether or not the quarter is closed. When a net figure is missing, read it from the administrator (through its connector, if the session has one) as of the quarter end, show the person, and record it with `record_fund_figures` before drafting; the entity's letter profile may hold the administrator's id for the fund (`external_ids`).

## Fund profile

The fixed facts of a fund, which change rarely and are copied, not written: its legal and short names, the firm's name, the stage of the fund (investing or harvesting), company display names and former names, any standing footnotes, the administrator or other parties the letter names, and the signatories. Hemrock keeps them as the entity's letter profile: use it as given. Where it is empty, take them from the last final letter for the same entity, and offer to save them (`lp_letter_profile_get` with `propose_from_last_letter`, then `lp_letter_profile_save` once the person agrees). Never take one fund's profile into another fund's letter.

## Workflow

1. **Confirm the fund and entity.** Call `list_funds`, and `use_fund` if needed, saying which fund is now active. List the entity's letters with `lp_letters`.
2. **Get the template.** Call `lp_letter_skill`. Follow `references/structure.md`, `references/voice.md` and `references/examples.md`, and `references/house-rules.md` when it is there.
3. **Get the brief.** Call `lp_letter_brief` (entity, year, quarter, `year_end` when it is the year-end letter). It holds the fund's figures (gross and net, each labeled), each company's figures and events, the quarter's updates and KPIs, team notes, stored background text with the date it was written, events after quarter end, the partners' notes and documents, the missing-information list and Hemrock's letter rules. Treat an update marked `confidential` as background only, never quoted. A stored business update marked `stale` predates the quarter: do not present it as news. Events in `after_quarter_end` are subsequent events: give their dates and keep them out of the quarter's figures.
4. **Read the last final letter** for the entity: `last_final_letter` in the brief (the newest final letter before this quarter). Drafts are not what was sent. Use it for the fund profile and for continuity: what was flagged, what was expected, each company's description and display name. Never carry one of its figures forward as current. If there is no final letter, ask the person for the one that was actually sent and bring it in with `lp_import_letter`.
5. **Read full updates** with `get_updates` where a company's summary is not enough, for that company only.
6. **Size each company section** (see "Sizing each company section").
7. **Write the letter** in the fund's structure and voice.
8. **Review it** against the checklist below and fix every failure. Hemrock reviews it again when you save it; each flag names the section it is in.
9. **Save it as a draft in Hemrock.** A new letter: `lp_draft_letter` with `text`. An existing draft: show the person the text, then `lp_write_letter`, one section at a time by its `section_id` from `lp_letter`, or the whole letter as `full_draft`. Pass `activeFund` exactly as `list_funds` or `use_fund` reported it.
10. **Make the document** the partners will edit (see "Output document").
11. **Report back**: the document, every review flag Hemrock returned, the missing information, the judgment calls you made and every placeholder still open. Never set `mark_final` and never share a letter: a person does both in Hemrock.

## Output document

Every run ends with a document the partners can edit and send.

- **Format**: the one the person wants. Without a preference, make a Claude doc when the session has them, or else the Word file from `lp_letter_export` (format `docx`): Hemrock lays it out with the letterhead, real heading, list, table and caption styles, the charts added to the letter, and page numbers. To add a fund-performance chart drawn from the letter's own figures (value against cost or gross multiple by company, the gross value bridge, or net paid-in against distributed and remaining value), check it with `lp_letter_chart` and add it with `lp_letter_add_chart`, after the section it belongs with. `lp_letter_export` also gives the PDF (the letter as investors receive it), Markdown and JSON. Make a Google Doc only on request, with Google Drive connected, and a PDF only on request, always alongside an editable copy.
- **Layout**: the text saved in Hemrock, laid out as the fund's structure describes, with real headings, tables and lists. Highlight placeholders so they are easy to find.
- **Missing information** stays out of the document. Give it in the report back, or as comments in a Claude doc.
- **Keep them in step.** Once the partners have finished editing, offer to save their version in Hemrock (`lp_write_letter` with `full_draft`). Next quarter's letter then begins from the text investors received.

## Keeping funds separate

- Write each letter from its own entity's brief and its own fund profile.
- Never mention another fund's position, cost, marks, ownership or expectations for a company, even one both funds hold.
- Text the partners share across letters (a market view, a firm overview) is theirs. Keep it as they wrote it and never add a reference to another fund yourself.
- Anything about the firm's other funds appears only at the level the partners write it.

## Structure

Use the fund's structure (`references/structure.md` from `lp_letter_skill`) when it has saved one: its sections, their order, headings, fixed paragraphs and tables. Without one, use this general outline and leave out what does not apply:

- **Heading**: the fund's name, the letter's title and the period.
- **Opening**: a greeting and one sentence placing the fund at the quarter end, from the brief's figures.
- **Market commentary**: the partners' own section. Write it only from their notes and from data the person provides, citing it by name. Otherwise leave a placeholder.
- **Year in review**: in a year-end letter, the partners' view of the year, from their notes.
- **Fund performance**: a table of the brief's `fund_figures` exactly as given, each with its gross or net basis. Gross and net figures come from different systems that calculate returns differently, so never reconcile them, swap one for the other, or flag the difference. If a figure is missing, leave a placeholder and list it as missing; never work it out from other figures. Copy the fund's fixed definitions from the last final letter.
- **Valuation changes**: when marks moved, which positions changed and why, in the terms of the fund's valuation policy.
- **Portfolio summary**: a table of the companies with their status and the figures the fund shows.
- **New investments**: each investment closed in the quarter: the company, the founders and the terms, from the company's `new_investments` in the brief (the round terms stored in Hemrock), partner notes or deal documents only. When the partners give terms Hemrock lacks, offer to store them with `set_round_terms`.
- **Company updates**: one section per company, in the order of the last final letter, with new companies last (see "Sizing each company section").
- **After the quarter**: events after quarter end the partners want reported.
- **Closing**: a short close and the signatories.
- **Missing information** (Hemrock's copy only, never shown to investors): the brief's missing items first, then any other gaps and every open placeholder. Hemrock keeps it apart from the letter.

Hemrock's copy is plain text with one mark: each section opens with a "## " line holding its heading, and a company's heading is its name exactly as the brief gives it, so Hemrock keeps each section with its sources. Otherwise use "- " bullets and tables as "Column | Column" rows, with no other markdown symbols.

## Sizing each company section

- **A full update this quarter**: what happened and what it means, then the company's reported figures with their periods.
- **Figures only**: a sentence or two stating them plainly, then the figures.
- **An event only** (a financing, markdown, write-off or exit): the event first, then the fund's resulting position.
- **Nothing new**: one sentence that says so. Do not repeat last quarter's figures or pad it.
- **Events in the brief** are stated in the company's own section, in plain terms (markdown, down round, write-off, exit), even when another section, such as valuation changes, already mentions them.

Treat `stored_business_update` in the brief as undated background that may be old. Never present it as news, never repeat its plans or forecasts once their dates have passed, and use it at most for the company's description.

## Voice

Write in the fund's voice: `references/voice.md` and `references/examples.md` from `lp_letter_skill`. They are the fund's own when it has saved them, otherwise the general ones in this folder. Its house rules (`references/house-rules.md`) win over the voice and examples. The examples use invented companies and figures: copy their shape, never their facts.

These hold whatever the voice says.

**Numbers**
- Give each figure the period or date it belongs to.
- Use only figures from the brief, the updates read with `get_updates` and partner notes.
- For a change, use the change the source reports, or give both values ("$900K, down from $1.1M in Q2"). Never compute a growth rate, burn, runway or total yourself.
- Keep the reported currency.
- Keep each fund metric's gross or net basis from the brief, and state it as the brief gives it.

**Confidentiality**
- Never name or describe an investor in the fund. The brief already leaves them out.
- For an update marked confidential, describe customers, pipeline, pricing and contract values generically unless the partners confirm otherwise.
- Say so when a financing is not yet public, in the words the fund uses.

## Review checklist

- [ ] The sections, their order, the fixed paragraphs and the signatories match the fund's structure and the last final letter.
- [ ] Each number can be found in the brief, an update or the partner notes, matching in value and period.
- [ ] Nothing derived: no growth rates, burn, runway or sums you worked out.
- [ ] The performance table shows `fund_figures` exactly as given, as of the quarter end, each with its basis; nothing recomputed or swapped; any gap is a placeholder listed as missing.
- [ ] Each event in the brief is named for what it is: a markdown, down round, write-off or exit.
- [ ] Stored background text is never passed off as news from the quarter.
- [ ] No other fund's positions or expectations appear.
- [ ] No investor named, and no confidential detail without the partners' confirmation.
- [ ] Bad news is stated early and plainly, and the house rules are followed.
- [ ] Names are spelled as in the sources and the summary table.
- [ ] Every date is a real date and none is in the future; no word the house rules say to avoid (an "Avoid:" line) appears.
- [ ] Hemrock's copy ends with "Missing information", starting with the brief's items, and every placeholder is in the report back.
- [ ] The document exists, matches Hemrock's text and has no "Missing information" section.
