# CT Civic Data Explorer

An authenticated civic data explorer for CTData Collaborative. Administrators upload datasets, approve the fields users may access, then publish. Users select approved fields from datasets about locations, categories, or other records and interact with charts and tables at `/explore`. Geographic comparisons appear when the dataset has recognized Connecticut locations. Reports and PDF export are optional. Every view retains its dataset name, period and source.

The interactive workflow advances the dynamic reporting direction in `SRS.docx` (draft v1.1). Public report publishing remains outstanding; this release requires sign-in. Jill Walsh's October 6 email and attached August 2025 brand guide define the palette and Poppins typography. Her September 30 data email asks for periods matching the existing town and housing profiles, rather than automatically selecting the newest data. Uploaded source data retains its declared period; this change does not silently replace datasets or fetch a newer vintage.

## Pages

| Page | Tabs and actions |
| --- | --- |
| Dashboard | **Datasets** and **Saved reports**; search and open either. |
| Data management | Search, filter, and sort dataset versions. **Add dataset** opens the upload form. **Administration** links to **Data management** and **Manage users**. |
| Dataset | **Data preview** opens by default, with live row and visible-field counts beneath the title. **Fields** and **Settings** hold field review and display settings. **Create a report with this data** carries the selected dataset into the builder. |
| Explore | **Fields**, **Filters** when applicable, and **View**. **New report**, **Copy link**, and **Export PDF** keep the selection. |
| Report builder | **Data**, **Fields**, **Content**, **Titles**, **Appearance**, **Preview**. **Content** edits one block at a time; **Save report** and **Export PDF** stay available across tabs. |
| People | **People** lists access. **Add person → Create invite** creates a link to copy; no email is sent. |

New uploads require field approval before publication. An empty approval unpublishes the dataset. Field choices use approved names, types, and units; filters and geographic comparisons appear only when applicable. Source rows are preserved unless aggregation is explicitly selected.

Migration `005_dataset_curation.sql` preserves existing published fields until staff review them, and labels that state as review pending. All subsequent approvals apply on the server to options, dataset previews, chart/PDF/AI requests and saved reports. Reopening an older report after a field has been withdrawn requires a new valid selection.

## Staff customization

Dataset **Settings** contains **Names**, **Field labels**, and **Style** tabs. Set the dataset name, description, default chart, field labels, decimals, and order, then choose **Save defaults**. Administrators can also prepare unpublished versions. These settings apply only to that version and preserve source data, units, approval, and publication. Conflicting saves require a reload.

Builder **Fields → Field labels & decimals** overrides labels, descriptions, or precision for the report. Blank settings inherit dataset defaults; **Reset to dataset defaults** clears overrides. Edit report titles in **Titles** and chart titles in **Content**; blank titles use dataset and field defaults. Field explanations appear in previews and PDFs. New charts inherit the dataset's chart default; saved layouts keep their choices.

Approved-field pickers in the builder, chart/table blocks and Explore group choices by unit and show each field's unit. Counts, dollars, percentages and text categories are distinct groups; the report's chosen field order is preserved.

### Chart colors and report appearance

Dataset **Settings → Style** has **Colors**, **Text & spacing**, and **Preview** tabs. Set series, statewide, heading, and table-header colors, text size, and spacing. **Reset style** restores CTData styling; **Save defaults** applies changes to Explore and inheriting reports.

Builder **Appearance** uses the same tabs with an **Override** toggle per setting. Unchecked settings follow dataset defaults; overrides survive saving and duplication. **Reset overrides** clears them. Browser previews and PDFs share server-resolved styling and contrast checks. Source attribution stays visible.

## Brand and embedding

Poppins is bundled locally with its OFL license and embedded in PDFs. `src/shared/theme.js` and `public/css/app.css` use CTData navy `#262558`, teal `#39738C`, coral `#DE6F59` and the supporting brand palette. Charts avoid using teal and green together as required by the brand guide. No font CDN is needed.

`/explore?embed=1` provides compact exploration chrome for same-origin embedding. Authentication remains required. Cross-origin WordPress embedding or a public viewer requires the actual hosting origin and a decision about public versus signed-in access; the existing same-origin frame policy is retained. No WordPress credentials or hosting target are configured in this repository.

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

To run the app and database together in containers, use `docker compose up --build`. Migrations run on startup. Create the admin with `docker compose exec app node scripts/create-admin.js --email … --first … --last …`, then open **Data management → Add dataset**. Selecting a CSV or `.xlsx` reveals its name, source, and period fields. Uploads and existing dataset rows open **Data preview**. The summary counts visible data fields and source rows, including repeated rows; secondary metadata is under **Details**.

Excel uploads import the first worksheet by default; enter a worksheet name to import another sheet. Include a header row with text or numeric fields; a `Town` header (case-insensitive) is optional. Recognized Connecticut town names enable geographic comparisons, while other location names and categories remain ordinary source values. Towns and other records can repeat: each nonblank source row is retained separately. Blank rows are skipped and numeric cells use their underlying values rather than display formatting. Formula cells use values saved by Excel; the server does not recalculate formulas. Save the workbook in Excel before uploading. Files are limited to 10 MB, 10,000 rows and 100 columns. Legacy `.xls` files should be saved as `.xlsx` first.

**Repeated rows and mixed data.** The importer detects column types without requiring registration. `dataset_records` stores the original row number, optional matched town and JSON cell values; `datasets.column_definitions` keeps headings, types and display rules. Text employer names, missing values and populated unnamed columns are retained. Parenthetical town labels are matched only when the base name is a known town, with an import note and the original label retained. The overview displays source rows rather than merging them by town. Known single-row numeric indicator datasets still populate `observations`, preserving existing calculated indicators and reports.

For example, Industry Jobs retains five industry rows for each town; its repeated Total Jobs value is never summed. Key Employers retains the employer names and Bridgewater's note explaining its blank entries. Population Within 45 Minutes detects the numeric population column despite its descriptive heading. A header explicitly indicating a decimal-format percentage is displayed as a percentage without changing its stored fraction.

Reports over source rows offer text and numeric filters and select approved columns from that dataset. Charts use numeric measures and can use approved fields as category/axis and series fields; compatible chart types adapt to those choices. Text-only datasets render as tables. Browser charts show 20 rows per page, indicator tables show 10 locations, and source tables show 50 rows. Page controls reach the complete selection. PDFs include the full selection in readable chart and table sections, with source details on every page. No implicit sums, averages or cross-dataset joins are performed. Users must explicitly choose an aggregation before chart values are grouped; the source table continues to retain individual rows.

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

**Record selection and chart groups.** Town selection is optional; an empty `towns` array includes all matching source rows. Geographic controls and statewide comparisons are available only when the selected dataset supports them. A chart block can request up to 25 selected numeric measures in `indicators`, plus an approved `axisField` for category/axis labels and an optional `seriesField`. Empty measure lists include every selected numeric field. Chart types must be compatible with the selected fields. `aggregation` defaults to `none`, preserving every source row; users can explicitly choose a supported aggregation to group chart values. Chart grouping by unit is independent of aggregation. The default grouped bar chart and line charts group measures by unit, then split groups into charts of at most six series. A bar chart produces one chart for each numeric measure. One layout block can therefore become several rendered chart blocks, each with its own `chart.title`; incompatible units never share a scale. All matching source rows and their original values remain in the source table, including repeated rows.

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

- **New data:** choose **Data management → Upload dataset** and select a CSV or `.xlsx` file with column headers. A Town column is optional; location, category, and other record datasets are supported automatically.
- **Optional indicator definitions:** compatible indicator datasets offer definitions in the dataset overview for known numeric keys with custom units or calculated ratios. A ratio appears when both inputs have values. Generic record datasets use their own approved fields instead.
- **Schema change:** add `migrations/NNN_description.sql`. Migrations are forward-only; never edit one that has been applied.

## Decisions to review with the client

These choices go beyond, or resolve ambiguity in, SRS draft v1.0:

- **No email is sent.** Admins use **People → Add person** to create an invite, then **Copy invite link**. Existing accounts offer invite/reset links under **Actions**. The SRS assumes emailed reset tokens.
- **Dataset upload is admin-only.** This follows SRS §4.2 (CRUD), although US003 says "staff member".
- **Duplicating reports.** Any signed-in user can duplicate any report, and the copy belongs to them. Only the creator can rename, edit or delete a report.
- **Source footer is mandatory.** It appears on every report and PDF page and cannot be removed from the layout.
- **One unit per chart.** Mixed-unit selections produce separate charts automatically, so counts, percentages and currency keep their own scales.
- **New unit and schema columns.** An `area` unit was added for land area. `users.password_hash` is nullable until an invite is accepted, and lockout state lives on `users`.
- **Top-coded values shown as-is.** Values such as Darien's $250,001 median income are displayed unchanged; automatic data-quality notes (US013) are not built yet.

## Planned

- **AI-written text between charts.** The AI would write headings, paragraphs and lists from the report's own figures and place them between the user's charts and tables, as a proposal to review. Not built yet; see [docs/ai-assisted-reports.md](docs/ai-assisted-reports.md).
