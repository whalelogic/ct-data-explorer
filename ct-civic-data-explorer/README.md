# CT Civic Data Explorer

An internal web app for CTData Collaborative staff. Staff upload town-level datasets, build a data report for one or more Connecticut towns, and export it as a PDF. Every report carries its dataset name, source, and uploader. The specification is `SRS.docx` at the repository root.

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

To run the app and database together in containers, use `docker compose up --build`. Migrations run on startup. Create the admin with `docker compose exec app node scripts/create-admin.js --email … --first … --last …`, then choose **Upload dataset** in the header. Selecting a CSV or `.xlsx` workbook reveals its name, source and period fields. A successful upload opens the dataset overview; clicking an existing dataset row opens the same page with its metadata, available indicators and paginated data preview.

Excel uploads import the first worksheet by default; enter a worksheet name to import another sheet. Include exactly one `Town` header (case-insensitive) and any named text or numeric columns. Towns can repeat: each nonblank source row is retained separately. Blank rows are skipped and numeric cells use their underlying values rather than display formatting. Formula cells use values saved by Excel; the server does not recalculate formulas. Save the workbook in Excel before uploading. Files are limited to 10 MB, 10,000 rows and 100 columns. Legacy `.xls` files should be saved as `.xlsx` first.

**Repeated rows and mixed data.** The importer detects column types without requiring registration. `dataset_records` stores the original row number, matched town and JSON cell values; `datasets.column_definitions` keeps headings, types and display rules. Text employer names, missing values and populated unnamed columns are retained. Parenthetical town labels are matched only when the base name is a known town, with an import note and the original label retained. The overview displays source rows rather than merging them by town. Known single-row numeric indicator datasets still populate `observations`, preserving existing calculated indicators and reports.

For example, Industry Jobs retains five industry rows for each town; its repeated Total Jobs value is never summed. Key Employers retains the employer names and Bridgewater's note explaining its blank entries. Population Within 45 Minutes detects the numeric population column despite its descriptive heading. A header explicitly indicating a decimal-format percentage is displayed as a percentage without changing its stored fraction.

Reports over source rows offer category filters and select columns from that dataset. Charts use numeric columns; text-only datasets render as tables. Wide PDF tables repeat the town and category in successive column groups. Reports are limited to 1,000 matching source rows and charts to 40; use category filters for larger selections. No implicit sums, averages or cross-dataset joins are performed.

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

- **New data:** choose **Upload dataset** and select a CSV or `.xlsx` file with a Town column. Repeated towns and new column headings are supported automatically.
- **Optional indicator definitions:** define known numeric keys when custom units or calculated ratios are needed. Definitions can also be added in the dataset overview. A ratio appears for compatible indicator datasets when both inputs have values.
- **Schema change:** add `migrations/NNN_description.sql`. Migrations are forward-only; never edit one that has been applied.

## Decisions to review with the client

These choices go beyond, or resolve ambiguity in, SRS draft v1.0:

- **No email is sent.** Admins choose **Manage users** on the upload page to copy invite and password-reset links. The SRS assumes emailed reset tokens.
- **Dataset upload is admin-only.** This follows SRS §4.2 (CRUD), although US003 says "staff member".
- **Duplicating reports.** Any signed-in user can duplicate any report, and the copy belongs to them. Only the creator can rename, edit or delete a report.
- **Source footer is mandatory.** It appears on every report and PDF page and cannot be removed from the layout.
- **One unit per chart.** A chart plots one unit, so mixed units are refused with a message naming the indicators.
- **New unit and schema columns.** An `area` unit was added for land area. `users.password_hash` is nullable until an invite is accepted, and lockout state lives on `users`.
- **Top-coded values shown as-is.** Values such as Darien's $250,001 median income are displayed unchanged; automatic data-quality notes (US013) are not built yet.

## Planned

- **AI-written text between charts.** The AI would write headings, paragraphs and lists from the report's own figures and place them between the user's charts and tables, as a proposal to review. Not built yet; see [docs/ai-assisted-reports.md](docs/ai-assisted-reports.md).
