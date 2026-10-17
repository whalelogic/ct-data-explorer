# CT Civic Data Explorer

An authenticated civic data explorer for CTData Collaborative. Administrators upload datasets (organized by town or by any other row label), approve the fields users may access, then publish. Users build reports from approved fields in the report builder, then open them as interactive pages at `/explore/<report-name>.html` or export PDFs. Every view retains its dataset name, period and source.

The interactive workflow advances the dynamic reporting direction in `SRS.docx` (draft v1.1). Public report publishing remains outstanding; this release requires sign-in. Jill Walsh's October 6 email and attached August 2025 brand guide define the palette and Poppins typography. Her September 30 data email asks for periods matching the existing town and housing profiles, rather than automatically selecting the newest data. Uploaded source data retains its declared period; this change does not silently replace datasets or fetch a newer vintage.

## Curate, build, explore

1. An administrator opens **Datasets** (`/admin`, searchable, sortable and filterable by reporting period, status and field review) and selects **+ Add dataset** (`/admin/datasets/new`). The upload page asks three things in order: the file, its name/source/reporting period, and what each row describes. The row column is suggested from the file (a `Town` column, the column that best matches Connecticut places, otherwise the first text column). Tick **These are Connecticut places** only when they are; names are then matched to the official list and a statewide comparison becomes available. Industries, programs or record IDs work too.
2. The upload opens the dataset page on its **Settings** tab, a numbered checklist: **Choose the fields people can use** (tick cards, then save), **Default comparison**, **Names and display** (optional) and **Publish**, which stays disabled, with the reason shown, until fields are chosen and saved. An empty approval unpublishes the dataset. The **Data** tab (default for everyone) previews the rows and the **Fields** tab lists what reports can use. Tabs are linkable as `#data`, `#fields` and `#settings`.
3. In the **Report builder**, work through four steps: **Compare** (pick towns, counties, planning regions or an approved text column such as Program, then tick which ones from a list; nothing is typed), **Show** (tick the fields as cards, then order or rename them; calculated ratios are optional), **Charts & tables** (starts with a chart and a table) and **Finish** (title, optional colors, **Save report** and **Export PDF**). The statewide figure is off by default. Source rows are never implicitly summed.
4. **Save** gives the report a readable address, `/explore/<report-name>.html`. **Explore reports** lists saved reports; each opens as an interactive page with its charts, tables and a ranking of its rows. PDF export is available from the builder and the viewer.

Older links to `/explore?dataset=…` open the builder with that dataset. Saved reports that stored `towns` are read as `rows`, so they keep working.

### Calculated fields

In the builder's **Show** step, **Add a calculated field › + New calculated field** first asks what to **Calculate**:

- **One value for the whole report**, shown as a summary under the title in the preview, viewer and PDF together with how it was worked out:
  - **Average per town** (or row, county…): the field added up across the report's rows ÷ how many there are, e.g. *average population per town* ("293,606 total Population ÷ 3 towns").
  - **Median**, **Highest**, **Lowest** (naming the town or row, and ties) and **Total**.
  - **Average per row with a value in a column**: the total ÷ the rows where that column is filled in.
- **One value for each row**: one field divided by another, e.g. clients per staff member, charted and tabulated like any field.

Each summary also shows the same figure for every comparable row as a benchmark, on by default: "Connecticut, all 169 towns: 21,447 (3,624,508 total Population ÷ 169 towns)", or Bridgeport for *Highest*. For town data that means every row of the same kind as those compared (all towns, or all counties), worked out from the towns themselves rather than the statewide row; for other data it is the whole dataset, after the report's category filters. It is omitted when the report already covers every row. Summaries default to whole numbers and ratios to two decimals. The statewide benchmark is never part of a summary. Summaries are never charted per row, and they only sum when you choose one, so source rows are still never combined implicitly.

Ratios and averages can be shown as a number, a percentage (× 100) or per 1,000. Everything is computed on the server (`services/custom-indicators.js`), never stored, and never computed in the browser. A missing value or a zero divisor gives N/A, and every field used must be approved for the dataset.

Migration `008_dataset_row_labels.sql` lets source rows have no town and records each dataset's row label column; `009_report_slugs.sql` adds unique report addresses, giving existing reports one made from their title and ID. Both are safe to apply to databases that already have a `reports.slug` column. `010_row_label_backfill.sql` records the Town column as the row label of source-row datasets uploaded before 008, adds a check that only those datasets carry a row label key, and rewrites saved report selections from `towns` to `rows` (the app still reads `towns`, so restored backups keep working).

Datasets do not need a town column. At upload, staff pick the column that identifies each row (an industry, program or record ID); a `Town` column is pre-selected when present and must then match Connecticut towns. Reports on such datasets select rows by that column's values, and town-only options (statewide benchmark) are hidden. Staff can change the label column later in the dataset page's **Row labels** panel; saved reports that named rows by the old column then ask for rows to be chosen again.

A Town column may also hold Connecticut's 8 counties (e.g. "Fairfield County") and 9 planning regions (e.g. "Capitol Planning Region"), added by `011_county_region_geographies.sql`. Those rows are kept as their own rows, never added to towns, and in the ranking view are shown for reference rather than ranked against the towns they contain. Any other unmatched name still rejects the upload.

Migration `005_dataset_curation.sql` preserves existing published fields until staff review them, and labels that state as review pending. All subsequent approvals apply on the server to options, dataset previews, chart/PDF/AI requests and saved reports. Reopening an older report after a field has been withdrawn requires a new valid selection.

## Staff customization

Open a dataset's **Details**, then **Customize names and display**. Staff can set a display name and description, rename approved fields, add field explanations, choose 0–4 decimal places, move fields up or down, and select a default chart style. Administrators can also prepare defaults for unpublished versions. Save applies these defaults to the dataset version; it never changes source names, field keys, values, units, approval or publication. Older versions keep their own settings. Conflicting saves ask the editor to reload rather than overwriting another staff member's work.

The report builder's **Customize field labels for this report** section overrides a selected field's label, description or precision. A blank setting inherits its shared default. **Use shared field defaults** removes report-specific overrides; each chart also has an optional custom title. Field explanations are included as notes in previews and PDFs. New reports and new chart blocks use the dataset's chart default, while saved layouts and explicit report overrides remain intact. Shared field order controls the field picker; reports retain their chosen field order.

Approved-field pickers in the builder and its chart/table blocks group choices by unit and show each field's unit. Counts, dollars, percentages and text categories are distinct groups; the report's chosen field order is preserved.

### Chart colors and report appearance

In dataset Details, **Shared report appearance** sets the six chart series colors, statewide benchmark color, heading color, table-header background, standard/large text, and comfortable/compact spacing. Its sample updates as you edit. Save shared defaults to apply them to reports that inherit those settings. **Use CTData styling** restores the original theme; save to apply it.

In the builder, **Report appearance** offers an **Override** toggle for each setting. Disabled controls follow the dataset defaults, including later staff changes; enabled overrides are stored with the report and survive save, reopen and duplication. **Use all shared styling** removes every style override. Colors and presentation are resolved on the server and used by both browser previews and PDFs. Heading and table-header choices must retain readable text contrast. Source attribution stays visible.

## Brand and embedding

Poppins is bundled locally with its OFL license and embedded in PDFs. `src/shared/theme.js` and `public/css/app.css` use CTData navy `#262558`, teal `#39738C`, coral `#DE6F59` and the supporting brand palette. Charts avoid using teal and green together as required by the brand guide. No font CDN is needed.

`/explore/<report-name>.html?embed=1` shows a saved report without site chrome for same-origin embedding. Authentication remains required. Cross-origin WordPress embedding or a public viewer requires the actual hosting origin and a decision about public versus signed-in access; the existing same-origin frame policy is retained. No WordPress credentials or hosting target are configured in this repository.

Deploy from this application directory with `docker compose up -d --build`, which applies migrations automatically. Verify the configured local URL's `/healthz` and sign-in/exploration flow. Back up the database first and preserve the existing database volume. Migration `006_preserve_saved_reports.sql` renames the legacy saved-selection table to `reports` without copying or deleting saved selections; fresh databases already have the new table. Deploy the previous compatible report-based revision to roll back application code; do not roll back to a revision using the legacy table name against the renamed table without restoring its matching backup.

## Quick start

Requires Node.js 22+ and Docker, which runs MySQL 8.4. The app connects with the `mysql2` driver that `npm install` adds. To use a MySQL server you already have instead, see "Using your own MySQL" in the [root README](../README.md).

```sh
cp .env.example .env               # set DB_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
npm install
docker compose up -d --wait db     # MySQL 8.4 on 127.0.0.1:${DB_PORT}
npm run migrate
npm run create-admin -- --email you@example.org --first First --last Last
npm run seed                       # loads ../sample-data/acs2024_sample.csv and activates it
npm run dev                        # http://localhost:3000
```

`create-admin` prints a one-time link. Open it to set your password.

To run the app and database together in containers, use `docker compose up --build`. Migrations run on startup. Create the admin with `docker compose exec app node scripts/create-admin.js --email … --first … --last …`, then choose **Datasets › + Add dataset**. Selecting a CSV or `.xlsx` workbook reveals its name, source and reporting-period fields. A successful upload opens the dataset's **Settings** tab; clicking an existing dataset row opens its **Data** tab (drafts open on **Settings**).

Excel uploads import the first worksheet by default; enter a worksheet name to import another sheet. Choose the column that identifies each row; files with exactly one `Town` header (case-insensitive) work without a choice. Rows can repeat: each nonblank source row is retained separately. Blank rows are skipped and numeric cells use their underlying values rather than display formatting. Formula cells use values saved by Excel; the server does not recalculate formulas. Save the workbook in Excel before uploading. Files are limited to 10 MB, 10,000 rows and 100 columns. Legacy `.xls` files should be saved as `.xlsx` first.

**Repeated rows and mixed data.** The importer detects column types without requiring registration. `dataset_records` stores the original row number, matched town and JSON cell values; `datasets.column_definitions` keeps headings, types and display rules. Text employer names, missing values and populated unnamed columns are retained. Parenthetical town labels are matched only when the base name is a known town, with an import note and the original label retained. The overview displays source rows rather than merging them by town. Known single-row numeric indicator datasets still populate `observations`, preserving existing calculated indicators and reports.

For example, Industry Jobs retains five industry rows for each town; its repeated Total Jobs value is never summed. Key Employers retains the employer names and Bridgewater's note explaining its blank entries. Population Within 45 Minutes detects the numeric population column despite its descriptive heading. A header explicitly indicating a decimal-format percentage is displayed as a percentage without changing its stored fraction.

Reports over source rows offer category filters and select columns from that dataset. Charts use numeric columns; text-only datasets render as tables. Browser charts show 20 locations per page, indicator tables show 10 locations, and source tables show 50 rows. Page controls reach the complete selection. PDFs include all selected locations in readable chart and table sections, with source details on every page. No implicit sums, averages or cross-dataset joins are performed.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm start` | Start the server (dev mode restarts on file changes) |
| `npm test` | Unit and HTTP tests (`node:test` + supertest); no database needed |
| `node --test test/pdf.test.js` | Run one test file; add `--test-name-pattern="filenames"` for one test |
| `npm run lint` | ESLint |
| `npm run migrate` | Apply pending `migrations/NNN_*.sql` files in order |
| `npm run create-admin -- --email … --first … --last …` | Create an admin and print a set-password link |
| `npm run reset-password -- [-p] <email>` | Reset an account's password when nobody can sign in: prints a one-time link, or with `-p` prompts for a new password |
| `npm run seed [-- file.csv]` | Upload a CSV as a new, active version of "ACS 5-Year Town Profile" (2024) |

## How it works

### Code style

Use descriptive camelCase names for variables and functions, and UPPER_SNAKE_CASE for constants. Keep page initialization, event handlers, and rendering functions at the top level of each browser module. Build larger DOM sections one element at a time instead of nesting many element-builder calls. Prefer a plain loop or an `if` statement when a chain of callbacks or a nested conditional would be harder to follow. Use two-space indentation, braces around conditionals and loops, and one statement per line. Comments should explain a rule or a reason, rather than repeat the code.

**Layers.** Code is split into routes, services and repositories, and each layer calls only the one below it:
- `src/routes/*` handles HTTP, with zod validation at the boundary.
- `src/services/*` holds the logic.
- `src/repositories/*` holds hand-written, parameterized SQL through one `mysql2` pool (`src/db/pool.js`). There is no ORM.

`src/app.js` puts middleware in this order: helmet, request log, static files, JSON body parsing, session, then `/api/auth`, then `requireAuth` and CSRF for the rest of `/api`. Role checks (`requireRole`) and ownership checks are applied per route. One central error handler returns safe messages; `HttpError` messages are shown to users.

**MySQL.** The app targets MySQL 8.4 (8.0.19 or later works). A few things differ from what you might assume:
- Every table uses the `utf8mb4_0900_as_cs` collation, so comparisons and unique keys are case-sensitive. Case-insensitive matching is written out explicitly: `LOWER()` for town names, emails and sources, and a `_ci` collation for report search.
- Each connection is set to UTC and READ COMMITTED isolation (`src/db/pool.js`). `DATETIME` values are always UTC.
- "One active version per name and vintage" and "source names unique ignoring case" are functional unique indexes, since MySQL has no partial indexes.
- MySQL commits `CREATE`/`ALTER` statements immediately, so a migration that fails partway can leave some of its schema changes behind. Keep each migration file to one logical step, and check for partial changes before re-running a failed one.
- `key` is a reserved word, so the `indicators.key` column is always written as `` `key` ``.

**Long-format data.** Tables are `sources` (the agency or survey a dataset comes from, unique ignoring case), `datasets` (one row per uploaded version, referencing its source), `towns` (169 towns plus one `state` row), `indicators` and `observations` (one value per dataset × indicator × town). A new dataset or indicator is an insert, never a schema change. Uploads are validated in full before anything is written (`csv-validation.js`), and every problem is reported at once. Each upload becomes a new version. Versions are activated or deactivated, never edited or deleted, and only one version per name and vintage can be active.

**Derived values are computed on the server.** Ratio indicators, such as poverty rate = `povnumerator / povdenominator`, are computed in `services/compute.js` when a report is built. They are never stored or computed in the browser. `src/shared/format.js` holds the number formatting rules. The browser (preview) and pdfkit (PDF) import the same file, so a figure looks identical on screen and on paper.

**One selection object.** The report builder produces a *selection*: dataset, towns, benchmark, indicators, title, subtitle and a *layout*. The layout is an ordered list of text, chart and table blocks, and a report can hold any number of each (up to 30 blocks). `services/selection.js` validates it and `reports.selection` stores it. `buildReport()` resolves it into report data, and that one object is returned as JSON for the live preview and passed to the PDF renderer. Saved reports store only the selection, so reopening a report re-renders it against the currently active dataset version.

**Town selection and chart groups.** A selection can include every available town, with no comparison-town limit. A chart block can request up to 25 selected fields; an empty field list includes every selected numeric field. The default grouped bar chart and line charts group fields by unit, then split groups into charts of at most six series. A bar chart produces one chart for each numeric field. One layout block can therefore become several rendered chart blocks, each with its own `chart.title`. All matching source rows and their original values remain in the report, including repeated town rows. Chart grouping never sums rows or drops measures.

**Text blocks.** Text uses a small Markdown subset: `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists, `**bold**`, `*italic*` and `[links](https://…)` (http, https and mailto only). `services/markup.js` parses it on the server into a node tree, which the preview renders with text-only DOM calls and the PDF draws with pdfkit, so user text never becomes HTML. Anything else (nested lists, images, raw HTML) shows as plain text. Reports saved before layouts existed are converted when read: their chart, table and notes become blocks in that order.

**PDF.** `services/pdf/index.js` is the boundary. The current renderer draws with pdfkit vector primitives, needs no headless browser, and gives the same bytes for the same report data. Swap the renderer there if faithful HTML-to-PDF output is ever needed (SRS OQ-4).

**AI summary (optional).** `services/ai/` drafts two to four sentences, which the user can add to the report as a text block. It is outside the render path: figures, tables and charts always come from the database. Only public aggregate figures and labels are sent. Every number in the draft is checked against the report's computed values, and mismatches are flagged before the user accepts the text. With `AI_PROVIDER=none` (the default), the button is hidden and text is written by hand. With `AI_PROVIDER=anthropic`, the server calls Claude (`claude-opus-5` by default, with server-side refusal fallback enabled) using `ANTHROPIC_API_KEY`. To add another provider, add a module exposing `draft(facts) => Promise<string>` and register it in `services/ai/index.js`.

**Accounts and security.**
- Accounts are invite-only; there is no self-registration. Passwords are hashed with bcrypt (cost 12, 12 characters to 72 bytes).
- Invite and reset links are single-use. Only their hash is stored, and the token travels in the URL fragment so it never reaches server logs.
- Sessions are stored server-side in MySQL (`src/db/session-store.js`) behind an HttpOnly cookie. They expire after 30 minutes idle or 8 hours total.
- Five failed sign-ins in 15 minutes lock the account for 15 minutes, and there is a per-IP rate limit on credential endpoints.
- State-changing requests need a synchronizer CSRF token in `X-CSRF-Token`.
- Chart.js is served from `node_modules`, not a CDN, so pages make no third-party requests.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `APP_BASE_URL` | `http://localhost:$PORT` | Used to build invite and reset links |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `localhost`, `3306` | MySQL connection. `.env.example` uses port `3307`, which is also the host port docker compose publishes |
| `DB_POOL_MAX` | `10` | Maximum MySQL connections in the pool |
| `SESSION_SECRET` | random per start (dev only) | Required when `NODE_ENV=production` |
| `COOKIE_SECURE` | `true` in production | Set `false` only for plain-HTTP local development |
| `TRUST_PROXY` | `false` | Set `true` behind Nginx |
| `AI_PROVIDER` | `none` | `none` or `anthropic` |
| `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT` | –, `claude-opus-5`, `low` | Used only when `AI_PROVIDER=anthropic` |

## Extending

- **New data:** choose **Datasets › + Add dataset** and select a CSV or `.xlsx` file. Repeated rows and new column headings are supported automatically, and a town column is optional.
- **Optional indicator definitions:** define known numeric keys when custom units or calculated ratios are needed. Definitions can also be added in the dataset overview. A ratio appears for compatible indicator datasets when both inputs have values.
- **Schema change:** add `migrations/NNN_description.sql`. Migrations are forward-only; never edit one that has been applied.

## Decisions to review with the client

These choices go beyond, or resolve ambiguity in, SRS draft v1.0:

- **No email is sent.** Admins choose **People** in the header to copy invite and password-reset links. The SRS assumes emailed reset tokens.
- **Dataset upload is admin-only.** This follows SRS §4.2 (CRUD), although US003 says "staff member".
- **Duplicating reports.** Any signed-in user can duplicate any report, and the copy belongs to them. Only the creator can rename, edit or delete a report.
- **Source footer is mandatory.** It appears on every report and PDF page and cannot be removed from the layout.
- **One unit per chart.** Mixed-unit selections produce separate charts automatically, so counts, percentages and currency keep their own scales.
- **New unit and schema columns.** An `area` unit was added for land area. `users.password_hash` is nullable until an invite is accepted, and lockout state lives on `users`.
- **Top-coded values shown as-is.** Values such as Darien's $250,001 median income are displayed unchanged; automatic data-quality notes (US013) are not built yet.

## Planned

- **AI-written text between charts.** The AI would write headings, paragraphs and lists from the report's own figures and place them between the user's charts and tables, as a proposal to review. Not built yet; see [docs/ai-assisted-reports.md](docs/ai-assisted-reports.md).
