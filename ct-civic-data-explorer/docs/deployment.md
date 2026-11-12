# Deploying to production

How to run CT Civic Data Explorer for real users: what to set, what to put in front of it, how to back it up and how to upgrade it. For local development see the [root README](../../README.md).

## What you are running

Two containers from `docker-compose.yml`:

| Service | What it is | Listens on |
| --- | --- | --- |
| `app` | The Node.js server. Applies pending migrations, then serves pages and the API. | `127.0.0.1:${PORT}` on the host |
| `db` | MySQL 8.4 with its data in the `mysqldata` volume | `127.0.0.1:${DB_PORT}` on the host |

Both bind to localhost only. A reverse proxy on the same host (Nginx, Caddy, or a cloud load balancer) terminates HTTPS and forwards to the app. Neither container should be reachable from the internet directly.

The app keeps sign-in sessions in MySQL but rate-limit counters in memory, so run **one** app container. That is ample for a staff tool; running several needs a shared rate-limit store first.

## Before the first start

1. **Create `.env`** from `.env.example` and set every value below. The server checks them at startup and lists every problem at once instead of starting half-configured.

   | Setting | Production value |
   | --- | --- |
   | `APP_BASE_URL` | The public address, e.g. `https://data.example.org`. Invite and password links are built from it. |
   | `SESSION_SECRET` | `openssl rand -hex 32`. Changing it signs everyone out. |
   | `COOKIE_SECURE` | `true` |
   | `TRUST_PROXY` | `true` (the app sits behind your proxy) |
   | `DB_PASSWORD` | A long random password. It is only used between the two containers. |
   | `DB_USER`, `DB_NAME` | Leave as in `.env.example` unless you use an existing MySQL |
   | `AI_PROVIDER` | `none`, or `anthropic` with `ANTHROPIC_API_KEY` to turn on summaries and the assistant |

   Keep `.env` readable only by the deploying account (`chmod 600 .env`). It is never committed and never copied into the image.

2. **Configure the reverse proxy.** It must forward the original scheme and client address, and allow 10 MB uploads. For Nginx:

   ```nginx
   server {
     listen 443 ssl http2;
     server_name data.example.org;
     # ssl_certificate / ssl_certificate_key ...

     client_max_body_size 11m;            # dataset uploads are limited to 10 MB by the app

     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 130s;           # assistant replies and large PDFs can take a while
     }
   }
   ```

   If `X-Forwarded-Proto` is missing, sign-in appears to succeed and then nothing happens: the app only issues its `Secure` session cookie when it knows the request arrived over HTTPS. The startup log warns about the settings that cause this.

3. **Start it and create the first administrator.**

   ```sh
   docker compose up -d --build
   docker compose exec app node scripts/create-admin.js --email you@example.org --first First --last Last
   ```

   Open the printed link to set a password. Everyone else is invited from **People**.

4. **Check it.** `curl -fsS https://data.example.org/healthz` returns `{"status":"ok"}`; `docker compose ps` shows both services `healthy`.

## Day to day

### Logs

`docker compose logs -f app` shows one line per request, with a timestamp, the signed-in user id and a request id:

```
2026-11-11T14:03:22.118Z POST /api/datasets 201 412.6ms user=7 id=3f9c2a71b0de
```

When something fails on the server, the person sees *"Something went wrong on our side… (Reference: 3f9c2a71b0de)"*. Search the log for that reference to find the request and, on the line after it, the error. Container logs rotate at 5 × 10 MB per service. Health checks are not logged while they pass.

### Activity (audit trail)

Administrators can read **Datasets › Activity**: sign-ins (including failed ones), invitations, role changes, deactivations, dataset uploads, field approvals, publishing, and report creation and deletion, each with who, when and from which address. Entries live in the `audit_log` table and are removed after two years. Passwords and report contents are never recorded.

### Backups

All state is in MySQL: accounts, uploaded datasets, saved reports, sessions and the audit trail. Nothing is stored on the app container's disk.

```sh
# Back up (safe while the app is running)
docker compose exec -T db sh -c 'mysqldump --single-transaction --no-tablespaces -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  | gzip > "civicdata-$(date +%F).sql.gz"

# Restore into an empty database (stop the app first: docker compose stop app)
gunzip -c civicdata-2026-11-11.sql.gz \
  | docker compose exec -T db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

Run the backup nightly from cron or a systemd timer, copy the file off the host, and restore one into a scratch database every so often to prove it works. A backup that has never been restored is a hope, not a backup.

### Upgrading

```sh
# 1. Back up (above)   2. Get the new code   3. Rebuild and restart
git pull
docker compose up -d --build
```

The app container applies new migrations before it starts serving. Migrations are forward-only, so rolling back means deploying the previous code **and** restoring the backup taken in step 1 if that release changed the schema. If you run the server outside Docker, it logs a warning at startup when migrations are pending; apply them with `npm run migrate`.

### Locked out

If no administrator can sign in, issue a link from the host:

```sh
docker compose exec app node scripts/reset-password.js --email you@example.org
```

## What protects the app

| Concern | What is in place |
| --- | --- |
| Sign-in | Invite-only accounts, bcrypt (cost 12), 12-character minimum, lockout after 5 failures in 15 minutes, per-address limit on credential endpoints |
| Sessions | Server-side in MySQL, HttpOnly + SameSite=Lax (+ Secure on HTTPS), 30 minutes idle, 8 hours absolute. Changing or resetting a password ends every other session. |
| Requests | CSRF token on every change, zod validation at every route, parameterized SQL only |
| Abuse | Per-person limits: 600 requests a minute overall, 60 PDFs, 60 uploads and 20 AI summaries per 10 minutes, 40 assistant messages per 10 minutes |
| Browser | Content-Security-Policy with no inline scripts, no third-party requests, same-origin framing only, HSTS on HTTPS deployments |
| Process | Runs as the unprivileged `node` user; exits and restarts on an unhandled error; finishes in-flight requests on stop |

## Not included

- **Email.** Invite and reset links are copied by an administrator, not mailed.
- **Public access.** Saved reports are public through `/embed/<report>.html`; everything else requires sign-in. Set `EMBED_FRAME_ANCESTORS` to the sites allowed to frame them, or leave it at `*`.
- **Off-host backup storage, monitoring and alerting.** Point your uptime monitor at `/healthz` (it returns 503 when the database is unreachable).
