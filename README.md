# CT Data Explorer

#### A capstone project for the SCSU Computer Science program: an internal web app for CTData Collaborative staff to upload datasets, build reports (text, charts and tables for chosen towns), and publish them as interactive web pages.

#### __Contributors:__

- Names here

| Path | What it is |
| --- | --- |
| [`ct-civic-data-explorer/`](ct-civic-data-explorer/) | The application. Its [README](ct-civic-data-explorer/README.md) explains how it works. |
| [`sample-data/`](sample-data/) | The ACS 2024 sample CSV used by `npm run seed` and the tests |
| `SRS.docx` | The software requirements specification |

## Local setup

**You need:** Git, Node.js 22 or newer (`node -v`), and Docker Desktop (Windows/macOS) or Docker Engine with Compose v2 (Linux).

The database is **MySQL 8.4**. Docker runs it for you, so you don't install MySQL yourself, and `npm install` adds the `mysql2` driver the app uses to connect. Already have MySQL installed and would rather not use Docker? See [Using your own MySQL](#using-your-own-mysql-instead-of-docker).

Run everything from the `ct-civic-data-explorer/` folder.

```sh
git clone -b demo https://github.com/whalelogic/ct-data-explorer.git
cd ct-data-explorer/ct-civic-data-explorer

cp .env.example .env        # Windows PowerShell: copy .env.example .env
```

Open `.env` and set `DB_PASSWORD` to anything you like. It is only for your local database. Leave `AI_PROVIDER=none`.

```sh
npm install                        # includes the mysql2 driver
docker compose up -d --wait db     # starts MySQL 8.4 in Docker on port 3307 (first start takes ~20 s)
npm run migrate                    # creates the tables
npm run create-admin -- --email you@example.org --first First --last Last
npm run seed                       # loads the sample ACS data for all 169 towns
npm run dev                        # http://localhost:3000
```

`create-admin` prints a one-time link. Open it to set your password, then sign in.

### Using your own MySQL instead of Docker

Any MySQL 8.0.19 or newer works (8.4 recommended). Create the database and a user once, as a MySQL admin:

```sql
CREATE DATABASE civicdata CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
CREATE USER 'ctdata'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON civicdata.* TO 'ctdata'@'localhost';
```

In `.env`, set `DB_HOST=localhost`, `DB_PORT=3306` (or your server's port), and `DB_USER`, `DB_PASSWORD` and `DB_NAME` to match. Then skip the `docker compose` step and run `npm run migrate`, `create-admin`, `seed` and `npm run dev` as above.

### Switching from the PostgreSQL version

Earlier versions of this branch used PostgreSQL. If you set it up before the switch:

```sh
git pull
npm install                        # swaps the pg driver for mysql2
docker compose up -d --wait db     # replaces the PostgreSQL container with MySQL
npm run migrate
npm run create-admin -- --email you@example.org --first First --last Last
npm run seed
```

The MySQL database starts empty; nothing is copied from PostgreSQL. Your existing `.env` keeps working. Once you no longer need the old data, `docker volume rm ct-civic-data-explorer_pgdata` frees its disk space.

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

- **Your database is yours alone.** Accounts, uploads and saved reports live only on your machine, so each person creates their own admin.
- **Port 3307 already in use?** Change `DB_PORT` in `.env`.
- **To start the database over:** `docker compose down -v` deletes all local data. Then run `migrate`, `create-admin` and `seed` again.
- **Schema changes go in a new file** `migrations/NNN_description.sql`. Never edit a migration that has already been pushed.
- **On Windows,** `npm run reset-password` is a bash script, so run it from Git Bash or WSL.
- **AI summaries are optional.** To try them, set `AI_PROVIDER=anthropic` and your own `ANTHROPIC_API_KEY` in `.env`. Never commit `.env`.


### DB Tables 

<img width="926" height="586" alt="image" src="https://github.com/user-attachments/assets/c4088302-cbd2-4ddd-96b5-656d27e8a23b" />

