# Planned: AI-written text between charts

Status: **not built**. Recorded 2026-09-27 as the next step for the AI summary (SRS US009).

## Goal

Today "Draft summary" produces one block of prose, which the user can add as a single text block. The goal is for the AI to write the report's surrounding text: headings, paragraphs and lists placed between the charts and tables the user chose in the builder, for example:

```
## Income            (text)
[income chart]       (chart, chosen by the user)
Paragraph about it.  (text)
## Poverty           (text)
- point one          (text)
- point two
[poverty chart]      (chart, chosen by the user)
[table]              (table, chosen by the user)
```

## Rules the feature must keep

- **Text comes only from the data source.** The model sees only `summaryFacts(report)`: the dataset name, source and vintage, the places, and the indicator values already on the report. It gets no outside knowledge or context beyond what the prompt tells it to use. Every figure in every generated block goes through `crossCheckFigures()`, and mismatches are flagged per block.
- **The AI never changes figures, charts or tables.** It proposes text blocks only. The user's chart and table blocks, their order relative to each other, and their settings stay exactly as chosen.
- **It remains a proposal.** The user reviews the proposed layout and accepts or discards it before it reaches the report. Nothing is added automatically. It stays out of the render path, and reports still build and export with `AI_PROVIDER=none`.
- **Same markup as hand-written text.** Generated text uses the Markdown subset in `services/markup.js`, so the preview and the PDF render it the same way.

## Sketch of an approach

1. Send the facts plus the report's current chart and table blocks (type and indicators, by position) to the provider.
2. Ask for structured JSON output: a list of text blocks, each with a position ("before block N" or "after the last block") and Markdown text. Validate it with the existing zod `blockSchema`, limits and `MAX_TEXT_LENGTH`.
3. Merge the text blocks into a copy of `selection.layout` without moving any chart or table block. Replace existing text blocks, or keep them, depending on what the user chooses.
4. Show the merged layout in the preview with the flagged figures, and offer Accept, Regenerate and Discard. This extends the current draft panel in `public/js/builder.js`.
5. Keep the SRS targets: under 15 s with the 15 s provider timeout and no retries, and only public aggregate figures leave the server.

## Open questions for the client

- Should the AI also be allowed to suggest *which* charts to add, or only write text around the ones the user picked? The current plan is text only.
- Should generated text replace text the user already wrote, sit beside it, or should this be asked every time?
- Is there a tone or reading-level guideline for CTData publications that the prompt should follow?
