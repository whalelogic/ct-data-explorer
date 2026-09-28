# CT Data Explorer

#### A capstone project for the SCSU Computer Science program: an internal web app for CTData Collaborative staff to upload Connecticut town-level datasets, build data cards (text, charts and tables for chosen towns), and export them as PDFs.

#### __Contributors:__

- Names here

| Path | What it is |
| --- | --- |
| [`ct-civic-data-explorer/`](ct-civic-data-explorer/) | The application. Its [README](ct-civic-data-explorer/README.md) explains how it works. |
| [`sample-data/`](sample-data/) | The ACS 2024 sample CSV used by `npm run seed` and the tests |
| `SRS.docx` | The software requirements specification |

## Local setup

**You need:** Git, Node.js 22 or newer (`node -v`), and Docker Desktop (Windows/macOS) or Docker Engine with Compose v2 (Linux).

Run everything from the `ct-civic-data-explorer/` folder.

```sh
git clone https://github.com/whalelogic/ct-data-explorer.git
cd ct-data-explorer/ct-civic-data-explorer

cp .env.example .env        # Windows PowerShell: copy .env.example .env
```

Open `.env` and set `DB_PASSWORD` to anything you like. It is only for your local database. Leave `AI_PROVIDER=none`.

```sh
npm install
docker compose up -d --wait db     # starts PostgreSQL 16 in Docker on port 5433
npm run migrate                    # creates the tables
npm run create-admin -- --email you@example.org --first First --last Last
npm run seed                       # loads the sample ACS data for all 169 towns
npm run dev                        # http://localhost:3000
```

`create-admin` prints a one-time link. Open it to set your password, then sign in.

### Every day after that

```sh
git pull
npm install                        # only if package.json changed
docker compose up -d --wait db
npm run migrate                    # applies any new migrations
npm run dev
```

### Before you open a pull request

```sh
npm run lint
npm test                           # no database needed
```

CI runs the same checks, plus `npm audit`, on every pull request.

### Good to know

- **Your database is yours alone.** Accounts, uploads and saved cards live only on your machine, so each person creates their own admin.
- **Port 5433 already in use?** Change `DB_PORT` in `.env`.
- **To start the database over:** `docker compose down -v` deletes all local data. Then run `migrate`, `create-admin` and `seed` again.
- **Schema changes go in a new file** `migrations/NNN_description.sql`. Never edit a migration that has already been pushed.
- **On Windows,** `npm run reset-password` is a bash script, so run it from Git Bash or WSL.
- **AI summaries are optional.** To try them, set `AI_PROVIDER=anthropic` and your own `ANTHROPIC_API_KEY` in `.env`. Never commit `.env`.
