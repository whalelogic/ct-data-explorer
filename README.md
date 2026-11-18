# CT Data Explorer

Browse Connecticut datasets, compare places, and build reports with charts, tables, and PDF exports. Guests can use published data and save reports in their browser. Signed-in users can upload private data and save reports to their accounts.

An SCSU Computer Science capstone for CTData Collaborative.

## Run locally

Install Git, Node.js 22 or later, and Docker with Compose v2. These commands use the current feature branch.

```sh
git clone --branch feature/ai-dataset-workspace https://github.com/whalelogic/ct-data-explorer.git
cd ct-data-explorer/ct-civic-data-explorer
cp .env.example .env
```

In `.env`, set `DB_PASSWORD` to a local password and `DB_HOST=127.0.0.1`. Add `GEMINI_API_KEY` if you want AI chat and report summaries.

```sh
npm ci
docker compose up -d --wait db
npm run migrate
npm run create-admin -- --email you@example.org --first Site --last Admin
npm run seed:samples
npm run dev
```

Open [localhost:3000](http://localhost:3000) to try ACS, Industry Jobs, Key Employers, and Population Within 45 Minutes as a guest. To sign in as an administrator, open the one-time setup link printed by `create-admin` after the server starts.

If a port is in use, change `DB_PORT` for MySQL or change both `PORT` and `APP_BASE_URL` for the web app in `.env`.

## Work on the app

Run `npm run lint` and `npm test` from `ct-civic-data-explorer/`. The default tests run without a database.

- [Application guide](ct-civic-data-explorer/README.md) covers uploads, reporting, AI, and other local setups.
- [Google Cloud deployment](ct-civic-data-explorer/deploy/README.md) covers provisioning and releasing your own staging and production sites.
- [HTTP API](ct-civic-data-explorer/docs/api-routes.md) documents routes and access rules.
- [Sample data](sample-data/) and the [software requirements](SRS.docx) are included in the repository.

## Contributors

- [Keith Thomson](https://github.com/whalelogic) · Architecture, infrastructure, and CI
- [Paul Robinson](https://github.com/pjr8) · Backend, database, and API
- [Kieran Veter](https://github.com/marsh-meadows) · Frontend, reports, and charts
