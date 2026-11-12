# Improvements, November 2026

What was wrong and what was done about it. Newest work first.

## AI

| Issue | Fix |
|---|---|
| The assistant and Draft summary refused any dataset that was not town-based. | Both now read every published dataset. Draft datasets, unapproved fields and accounts are still off limits. |
| The assistant showed dots until the whole answer was ready. | Replies appear as they are written, with a line saying what is being looked up. New route: `POST /api/assistant/stream`. |

Not done yet: AI text between charts (`docs/ai-assisted-reports.md`), a calculation tool, a preview of what Apply will change.

The streamed route is tested with a scripted client. It has not been run against the live Claude API.

## Datasets

| Issue | Fix |
|---|---|
| The Data tab opened with two cards that repeated the header. | Removed. One line above the table says what a row is. |
| Long column names wrapped one word per line and made the header huge. | Names are held to two lines; the full name shows on hover. |
| Hidden columns crowded the table. | Off by default. Administrators can tick a box to see them. |
| A row column with the same value on every row (ST = CT) was accepted silently. | The upload page warns and names a better column. It also no longer suggests such a column. |
| Numbers showed as 22.286769514. | Rounded to two decimals unless someone sets a precision. Small fractions keep four. |

## Reports

| Issue | Fix |
|---|---|
| A report had a name and a separate title that did not match. | The name is the title unless a different one is typed in Finish. |
| Charts of many rows showed 9 of 20 bars with no hint to scroll. | A page of 20 fits the width. Wider charts show a shadow on the side with more. |
| A chart of one field repeated its heading as a legend. | Legend removed, on screen and in the PDF. |
| Report cards had six buttons. | View, Edit and PDF stay. Duplicate, Rename and Delete moved under More. |
| A report on all 169 towns ran to 109 PDF pages. | Bar lists and one-line-per-row tables: 45 pages. PDFs stop at 500 pages with a clear message. |
| Unsaved work was lost on reload or an expired session. | Kept in the tab and offered back. Cleared on sign-out. |
| Ctrl+S twice saved the report twice; same-named saves could fail. | Both fixed. |

## Embedding

| Issue | Fix |
|---|---|
| A report could not be shown on another website: framing was blocked and the data needed sign-in. | `/embed/<report>.html` is public and shows only the report. The Embed button on a report copies the iframe code. |

## Navigation

| Issue | Fix |
|---|---|
| Admin pages listed Datasets and People twice. | The sub-nav keeps only Add dataset and Activity. |
| The header took a quarter of a phone screen. | One line for brand and account, one scrolling row of links. |

## Operations

Settings are checked at startup, there is an activity log and an account page, rate limits per person, a health check, and a deployment guide (`docs/deployment.md`).

## Known gaps

- The statewide row flattens town bars on count charts when it is switched on.
- `public/js/data-shape.js` and `public/town.html` are no longer used.
- One app instance only: rate limits are held in memory.
