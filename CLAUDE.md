# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CT Civic Data Explorer is an internal web app for CTData Collaborative (ctdata.org) staff. It stores uploaded Connecticut town-level datasets, lets staff build "data cards" (towns, indicators, chart and table blocks), drafts an optional AI summary, and exports each card as a PDF. It is a CSC400 student project (Fall 2026) that will be handed off to one client engineer, so keep dependencies few, boring and readable.

`SRS.docx` (repo root) is the spec. It has user stories US001–US009 (MVP), the schema (§5.3), the architecture (§5.4), the testing strategy (§6.3), and open questions OQ-1..OQ-6 with a default for each. Read the relevant section before building a feature. `ct-civic-data-explorer/README.md` covers how the app works, the configuration, and the decisions that deviate from the SRS.

## Layout

- `.github/workflows/ci.yml`: CI (lint, tests, `npm audit`) runs in `ct-civic-data-explorer/` on every PR and push to main.
- `ct-civic-data-explorer/`: the application (Node 22+, ESM, Express 5, `pg`, zod, pdfkit, Chart.js). Run all commands from this directory.
- `sample-data/acs2024_sample.csv`: 170 rows (169 towns plus `Connecticut`). `npm run seed` loads it, and a test validates it.
- `sample-data/ct-school-enrollments`: a CSV with no file extension. It has a UTF-8 BOM, 5 title rows before the header, and blank suppressed cells. It is keyed by school district, not town, so it does not fit the town upload format as-is.

## Commands

```sh
docker compose up -d --wait db    # Postgres 16 on 127.0.0.1:${DB_PORT} (5433)
npm run migrate                   # apply migrations/NNN_*.sql (forward-only, tracked in schema_migrations)
npm run create-admin -- --email a@b.org --first A --last B   # prints a one-time set-password link
npm run seed                      # upload the ACS sample as a new active dataset version
npm run dev                       # node --watch src/server.js
npm test                          # node:test + supertest; needs no database
node --test test/csv-validation.test.js                        # one file
node --test --test-name-pattern="poverty rate" test/format.test.js   # one test
npm run lint
```

`npm test` covers only pure services and the HTTP boundary. Anything that touches SQL has to be exercised against a real database. Use a throwaway container (for example `docker run --rm -d -p 127.0.0.1:5544:5432 ... postgres:16`) with `DB_PORT`/`DB_PASSWORD` overridden in the environment; dotenv never overrides variables that are already set.

A `pgdata` volume created by the original scaffold (with its old `init.sql` tables) makes migration 001 fail. It must be recreated before migrating.

## Architecture

**Layers.** `routes/` → `services/` → `repositories/` → PostgreSQL, and each layer calls only the one below it.
- Routes validate with the `validate(schema, source)` middleware and read only `req.valid.*`, because Express 5 makes `req.query` read-only.
- Repositories take an optional `db` argument, the pool by default. Pass the transaction client from `withTransaction()` so several calls share one transaction.
- Throw `HttpError(status, userMessage, details)` for anything the user should see. Anything else becomes a generic 500 and is logged.

**Middleware order** is set in `src/app.js`: helmet → static files (`public/`, `/shared` → `src/shared`, `/vendor/chart.js` → node_modules) → `/api`: JSON parsing, session → `/api/auth` (public) → `requireAuth` + `csrfProtection` for all other `/api` routes. Role checks (`requireRole`) and ownership checks happen per route or in services. `requireAuth` reloads the user on every request, so deactivation and role changes take effect immediately.

**The long-format data model is the core design choice.** Tables: `sources` (name unique ignoring case; an upload's free-text source is matched or created by `sources.findOrCreate`), `datasets` (a versioned upload referencing `source_id`, with at most one active version per name and vintage, enforced by a partial unique index), `towns` (with `geo_type` `town` or `state`), `indicators` (`derivation` is `direct`, or `ratio` with `numerator_key`/`denominator_key`), and `observations` (one value per dataset × indicator × town). Consequences:
- A new dataset or indicator is an insert, never a migration.
- Uploads are validated completely before any write, and a file with any problem is rejected whole.
- Each upload creates a new version, and versions are deactivated rather than deleted.
- CSV column names map to indicator keys case-insensitively, and blank cells mean "unavailable".

**The card selection is the single contract.** `services/selection.js` (zod) defines it. Its `layout` is an ordered list of `text` (Markdown subset, parsed by `services/markup.js` into nodes), `chart` and `table` blocks; `upgradeLegacySelection()` converts saved cards from the older `blocks`/`chart`/`notes` shape. The builder page produces it, `cards.selection` (JSONB) stores it, and `buildCard()` in `services/cards.service.js` resolves it against the active dataset version. The resulting card-data object goes both to the preview (JSON rendered by `public/js/card-view.js`) and to `services/pdf/`, which is why the PDF cannot disagree with the preview. If you change the card-data shape, update `card-view.js`, `pdfkit-renderer.js` and `test/pdf.test.js` together. Saved cards store only the selection and re-render against whichever version is active now.

**Shared browser/server modules.** `src/shared/format.js` and `theme.js` are imported by both Node and the browser, where they are served as-is. They must stay dependency-free and must not use Node globals.

**AI summary (`services/ai/`)** never sits in the render path. It only proposes text, which the user can add as a text block.
- `summaryFacts()` defines exactly what leaves the server: public figures and labels only.
- `crossCheckFigures()` flags any number in the draft that doesn't match a card value.
- The provider is chosen by `AI_PROVIDER` (`none` by default, which hides the button, or `anthropic`, which uses `claude-opus-5` with `fallbacks: "default"`).
- A card must always build and export with no provider configured.

**Frontend** is plain HTML plus ES modules with no build step and no framework. `public/js/dom.js`'s `h()` inserts text only. Keep it that way: no `innerHTML` with API data. Helmet's CSP forbids inline scripts, so all JS goes in files.

## Data correctness rules

- Derived rates are computed on the server (`services/compute.js`), never stored and never computed client-side. The poverty denominator is intentionally smaller than `pop` because group quarters are excluded.
- `test/format.test.js` asserts the hand-computed values: Hamden 5,126 / 55,147 = 9.3%, West Hartford 3,953 / 62,469 = 6.3%, Connecticut 353,604 / 3,530,170 = 10.0%. Keep these tests passing.
- Formatting lives only in `src/shared/format.js`: separators for counts and currency, and the indicator's `decimals` for rates, density and area.
- Darien's `$250,001` is a Census top-code meaning "$250,000 or more" (US013 data-quality notes are not built yet).
- The `Connecticut` row is only ever a benchmark, labeled "(statewide)". It is rejected if passed as a town.
- The source footer (dataset name, vintage, version, source, generation date) is mandatory on every card and every PDF page.

## SRS targets to keep in mind

- Speed: preview under 1s, PDF under 10s for a four-town card, AI draft under 15s (the provider timeout is 15s with no retries).
- Accessibility: WCAG 2.1 AA, including chart values available as a table.
- Sessions: 30-minute idle timeout (rolling cookie `maxAge`) and 8-hour absolute lifetime (checked in `requireAuth`).
- Lockout: 5 failures in 15 minutes locks the account for 15 minutes.
- Invite-only accounts, `/healthz` for deploys, parameterized SQL only, and CI running lint, tests and `npm audit` on every PR.
