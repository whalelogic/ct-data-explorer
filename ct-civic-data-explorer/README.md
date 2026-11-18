# CT Civic Data Explorer

Follow the [local quickstart](../README.md#run-locally) to create your database and load sample data. Use the [Google Cloud guide](deploy/README.md) to host your own copy.

## Use the app

1. **Publish data.** In **Admin → Datasets**, upload a CSV or Excel (`.xlsx`) file, enter its source and reporting period, and choose the field that identifies each row. Approve fields in **Settings** before publishing. Signed-in users can upload their own private files under **My datasets**.
2. **Build a report.** In **Reports → Report builder**, choose a dataset and comparison values. Select fields and calculations under **Fields**, arrange charts, tables, and text under **Layout**, and save or export under **Finish**.
3. **Reopen reports.** **Reports → Explore reports** shows saved work. Guest reports are stored in the current browser. Account reports can be opened by signed-in users with access to the data. A report that uses a private dataset is visible only to its creator.

The uploader keeps repeated source rows. It enables Connecticut place comparisons when every row in the chosen field matches a recognized place. To align different datasets, enable **Compare datasets or aggregate rows**, add the datasets, then choose **Match fields** and select columns whose values match.

Dataset **Settings** control the shared names, field order, formatting, and appearance. The builder can override those defaults per report. Charts and PDFs carry dataset source and reporting-period details.

## Set up AI

Open **AI chat** to ask about published datasets or start a report. Answers link to the datasets used and show the source, reporting period, and relevant fields or places when available. Owners can opt in to AI use of private uploads for the current chat.

Add provider credentials to the app environment and restart it. Administrators choose the provider and model under **AI settings**.

| Provider | Environment variables | Default model |
| --- | --- | --- |
| Gemini | `GEMINI_API_KEY` | `gemini-3.5-flash-lite` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| OpenAI-compatible | `AI_COMPATIBLE_API_KEY`, `AI_COMPATIBLE_BASE_URL` | Set a model ID |

For compatible providers, use a trusted HTTPS API base such as `https://provider.example/v1` and a model with tool support. Set `AI_PROVIDER` and optionally `AI_MODEL` to choose initial defaults, or set `AI_PROVIDER=none` to start with AI disabled. Browsing, reporting, and PDF export work without an AI provider.

## Other local setups

**Existing MySQL server.** Create a database and a dedicated user with access to it. Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in `.env`, then follow the quickstart from `npm ci` and skip the Compose command.

**Run the app in Docker too.** In `.env`, set `DB_PASSWORD` and a random `SESSION_SECRET` such as the output of `openssl rand -hex 32`. Then run the following from this directory.

```sh
docker compose up -d --build
docker compose exec app node scripts/create-admin.js --email you@example.org --first Site --last Admin
docker compose cp ../sample-data app:/sample-data
docker compose exec app npm run seed:samples
```

Compose applies migrations at app startup. Wait for [localhost:3000/healthz](http://localhost:3000/healthz) to respond before creating the admin. If you publish a different port, use container port `3000` in the service environment and update `APP_BASE_URL` to the external URL.

## Development

- `public/` contains the browser UI. `src/routes/`, `src/services/`, and `src/repositories/` handle HTTP, application logic, and MySQL access.
- Add schema changes as new files under `migrations/`. Run `npm run migrate` to apply them.
- Run `npm test` and `npm run lint`. With a migrated local database, use `CT_CURATION_INTEGRATION=1 CT_USAGE_INTEGRATION=1 npm test` to include database integration tests.
- Use `npm run reset-password -- you@example.org` to generate a new one-time setup link from a Bash shell.

See the [HTTP API](docs/api-routes.md) for endpoint access and request formats.
