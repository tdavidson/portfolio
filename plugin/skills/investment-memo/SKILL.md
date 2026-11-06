---
name: investment-memo
description: Draft an investment committee memo for a deal in diligence, in the fund's own structure, voice and design, from the deal's data room, research and partner notes in Hemrock Portfolio over MCP, and save it as an open draft with every paragraph cited.
metadata:
  version: "1.0.0"
---

# Investment memo

Draft one investment memo for one deal in diligence. The facts come from Hemrock Portfolio through its MCP tools (the deal's data room, the evidence read from it, outside research, the checklist, partner notes and Q&A) and from what the partners tell you. This skill is the process and the rules. How the memo is laid out, how it reads and how it looks belong to the fund: its section list, voice, examples, house rules and design template are saved in Hemrock, and `diligence_memo_skill` returns them. The hard rules below apply on top of everything; if the fund's material conflicts with them, follow the hard rules and tell the person.

The connector may be installed under another name, often the firm's. The tools are the same: `diligence_list_deals`, `diligence_memo_skill`, `diligence_memo_brief`, `diligence_draft_memo` and the rest. If they are not available, stop and ask the person to turn the connector on. Never draft from memory or from files outside Hemrock, except outside research you then save to the deal with `diligence_add_research`.

## Inputs

- **The deal**: a deal in diligence, by name or id (`diligence_list_deals`).
- **The fund's memo template**: section list, voice, examples, house rules and design, from `diligence_memo_skill`.
- **The brief**: everything the memo may be written from, with an id on every item, from `diligence_memo_brief`.
- **Partner notes**: their view of the deal, what to stress, what to leave out. Ask once at the start. If no one is there to answer, leave marked placeholders.

## Hard rules

1. **Never invent.** Every fact in the memo comes from the brief, and every paragraph cites the ids it rests on. If something can't be sourced, say it is unknown or unverified; never write a plausible guess.
2. **Never write the recommendation.** The recommendation section is the partners'. Leave the placeholder `[Partner to complete]`, and don't hint at a recommendation anywhere else.
3. **Never score the team** or judge the founders' character. Compile what they have done and said; the judgment is the partners'.
4. **Company statements are claims.** What the data room says about the company is the company's claim until outside research confirms it. Say "the company states" or "management reports" where it is unverified.
5. **Mark projections.** Forward-looking figures are labeled as projections, never mixed with actuals.
6. **Surface contradictions** where the data room and research disagree, in the section they affect and in the attention list.
7. **Never finalize.** A memo you save is an open draft. Only a partner finalizes it.
8. **Keep deals separate.** Never carry a fact, figure or name from one deal, or from the fund's sample memos, into another deal's memo. Sample memos teach layout and voice only.

## Workflow

1. **Confirm the fund and the deal.** Call `list_funds`, and `use_fund` if needed, saying which fund is active. Find the deal with `diligence_list_deals` and read `diligence_deal_detail`.
2. **Get the template.** Call `diligence_memo_skill`. Write under the fund's sections, in its order, with its headings. Follow its voice, examples and house rules.
3. **Ask the partners** for their notes, once.
4. **Fill gaps with research.** If the brief's gaps matter, research them with whatever tools you have (company data, CRM, the web). Save each finding with `diligence_add_research`: the claim, the source and its link. A finding not saved can't be cited.
5. **Get the brief.** Call `diligence_memo_brief`. It returns the claims, findings, Q&A answers, partner notes and facts, checklist status, gaps and the deal's memo settings, each with its id.
6. **Write the memo.** One section at a time, in the fund's order. Size each section by how much the evidence supports, within the section's depth setting. Cite ids on every paragraph.
7. **Save it.** Call `diligence_draft_memo` with your paragraphs. It saves a new open draft and returns review flags. Fix every flag you can and save again; tell the person about the rest.
8. **Export when asked.** `diligence_memo_export` returns a Word file or Google Doc in the fund's design template, or Markdown or a PDF.

## Structure

The fund's section list is the structure. When the fund has none, use this general outline: Executive summary, Recommendation (partner placeholder), Company overview, Product, Market, Traction, Business model, Team, Competition, Outcomes, Deal terms, Risks and open questions. Leave out a section the evidence can't support, and say so in your reply.

## Sizing each section

- Executive summary: the opportunity, the key risks and the open questions, in two or three paragraphs. No recommendation, no superlatives.
- A section with thin evidence gets one short paragraph that says what is known and what isn't.
- A section with rich evidence gets two or three paragraphs, never padding.
- Depth settings on the deal (brief, standard, detailed, comprehensive) override these defaults.

## Voice

Use the fund's voice from `diligence_memo_skill`. Where it has none, use `references/voice.md`, and match the shape of `references/examples.md`, whose companies and figures are invented.

## Citations

Every item in the brief carries a `ref`, such as `claim:claim_2_3`, `finding:f_7`, `qa:q_market_2` or `note:…`. Every paragraph you save lists the refs it rests on, exactly as the brief gives them: data-room claims, research findings, Q&A answers, and partner notes and facts. Cite only refs from the brief. A paragraph with nothing to cite is either the partner placeholder or should not be in the memo.

## Review checklist

Before saving, and again on the flags `diligence_draft_memo` returns:

- Every paragraph cites at least one id from the brief, and no id that isn't in it.
- Every number in the memo is in a cited item.
- No recommendation, no team score, no judgment of the founders' character.
- Unverified company statements are said to be the company's.
- Projections are labeled.
- Each contradiction appears in its section.
- The sections are the fund's, in its order, with its headings.
- Nothing from another deal or a sample memo.
