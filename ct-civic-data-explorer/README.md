# CT Civic Data Explorer

An internal web app for CTData Collaborative staff. Staff upload town-level datasets, build a data card for one or more Connecticut towns, and export it as a PDF. Every card carries its dataset name, vintage and source. The specification is `SRS.docx` at the repository root.

## Quick start

Requires Node.js 22+ and Docker.

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

To run the app and database together in containers, use `docker compose up --build`. Migrations run on startup. Create the admin with `docker compose exec app node scripts/create-admin.js --email … --first … --last …`, then upload data on the Admin page.

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
- Every table uses the `utf8mb4_0900_as_cs` collation, so comparisons and unique keys are case-sensitive. Case-insensitive matching is written out explicitly: `LOWER()` for town names, emails and sources, and a `_ci` collation for card search.
- Each connection is set to UTC and READ COMMITTED isolation (`src/db/pool.js`). `DATETIME` values are always UTC.
- "One active version per name and vintage" and "source names unique ignoring case" are functional unique indexes, since MySQL has no partial indexes.
- MySQL commits `CREATE`/`ALTER` statements immediately, so a migration that fails partway can leave some of its schema changes behind. Keep each migration file to one logical step, and check for partial changes before re-running a failed one.
- `key` is a reserved word, so the `indicators.key` column is always written as `` `key` ``.

**Long-format data.** Tables are `sources` (the agency or survey a dataset comes from, unique ignoring case), `datasets` (one row per uploaded version, referencing its source), `towns` (169 towns plus one `state` row), `indicators` and `observations` (one value per dataset × indicator × town). A new dataset or indicator is an insert, never a schema change. Uploads are validated in full before anything is written (`csv-validation.js`), and every problem is reported at once. Each upload becomes a new version. Versions are activated or deactivated, never edited or deleted, and only one version per name and vintage can be active.

**Derived values are computed on the server.** Ratio indicators, such as poverty rate = `povnumerator / povdenominator`, are computed in `services/compute.js` when a card is built. They are never stored or computed in the browser. `src/shared/format.js` holds the number formatting rules. The browser (preview) and pdfkit (PDF) import the same file, so a figure looks identical on screen and on paper.

**One selection object.** The card builder produces a *selection*: dataset, towns, benchmark, indicators, title, subtitle and a *layout*. The layout is an ordered list of text, chart and table blocks, and a card can hold any number of each (up to 30 blocks). `services/selection.js` validates it and `cards.selection` stores it. `buildCard()` resolves it into card data, and that one object is returned as JSON for the live preview and passed to the PDF renderer. Saved cards store only the selection, so reopening a card re-renders it against the currently active dataset version.

**Text blocks.** Text uses a small Markdown subset: `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists, `**bold**`, `*italic*` and `[links](https://…)` (http, https and mailto only). `services/markup.js` parses it on the server into a node tree, which the preview renders with text-only DOM calls and the PDF draws with pdfkit, so user text never becomes HTML. Anything else (nested lists, images, raw HTML) shows as plain text. Cards saved before layouts existed are converted when read: their chart, table and notes become blocks in that order.

**PDF.** `services/pdf/index.js` is the boundary. The current renderer draws with pdfkit vector primitives, needs no headless browser, and gives the same bytes for the same card data. Swap the renderer there if faithful HTML-to-PDF output is ever needed (SRS OQ-4).

**AI summary (optional).** `services/ai/` drafts two to four sentences, which the user can add to the card as a text block. It is outside the render path: figures, tables and charts always come from the database. Only public aggregate figures and labels are sent. Every number in the draft is checked against the card's computed values, and mismatches are flagged before the user accepts the text. With `AI_PROVIDER=none` (the default), the button is hidden and text is written by hand. With `AI_PROVIDER=anthropic`, the server calls Claude (`claude-opus-5` by default, with server-side refusal fallback enabled) using `ANTHROPIC_API_KEY`. To add another provider, add a module exposing `draft(facts) => Promise<string>` and register it in `services/ai/index.js`.

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
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | | `DB_PORT` is also the host port docker compose publishes |
| `SESSION_SECRET` | random per start (dev only) | Required when `NODE_ENV=production` |
| `COOKIE_SECURE` | `true` in production | Set `false` only for plain-HTTP local development |
| `TRUST_PROXY` | `false` | Set `true` behind Nginx |
| `AI_PROVIDER` | `none` | `none` or `anthropic` |
| `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT` | –, `claude-opus-5`, `low` | Used only when `AI_PROVIDER=anthropic` |

## Extending

- **New data with known columns:** upload it on the Admin page (a `town` column plus one column per indicator key).
- **A new column:** add the indicator on the Admin page first. It can be uploaded directly or computed as a ratio of two uploaded indicators.
- **Schema change:** add `migrations/NNN_description.sql`. Migrations are forward-only; never edit one that has been applied.

## Decisions to review with the client

These choices go beyond, or resolve ambiguity in, SRS draft v1.0:

- **No email is sent.** Admins copy invite and password-reset links from the Admin page. The SRS assumes emailed reset tokens.
- **Dataset upload is admin-only.** This follows SRS §4.2 (CRUD), although US003 says "staff member".
- **Duplicating cards.** Any signed-in user can duplicate any card, and the copy belongs to them. Only the creator can rename, edit or delete a card.
- **Source footer is mandatory.** It appears on every card and PDF page and cannot be removed from the layout.
- **One unit per chart.** A chart plots one unit, so mixed units are refused with a message naming the indicators.
- **New unit and schema columns.** An `area` unit was added for land area. `users.password_hash` is nullable until an invite is accepted, and lockout state lives on `users`.
- **Top-coded values shown as-is.** Values such as Darien's $250,001 median income are displayed unchanged; automatic data-quality notes (US013) are not built yet.

## Planned

- **AI-written text between charts.** The AI would write headings, paragraphs and lists from the card's own figures and place them between the user's charts and tables, as a proposal to review. Not built yet; see [docs/ai-assisted-cards.md](docs/ai-assisted-cards.md).
