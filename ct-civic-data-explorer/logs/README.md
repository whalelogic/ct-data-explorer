## Logs

This folder contains logs from the server, database and docker-compose. The server logs are here for reference and to help debug issues. See information below about how to read them and how to write/run any kind of query. 

## 1. Sign-in events from the request log

Every sign-in, sign-out and password action goes through a path that starts with `/api/auth/`. Start the server and save only those lines:

```sh
npm run dev --silent 2>&1 | tee server.log | grep --line-buffered ' /api/auth/' > auth.log
```

Or pull them out of a `server.log` you already saved:

```sh
grep ' /api/auth/' server.log > auth.log
```

How to read each line:

| Line | Meaning |
| --- | --- |
| `POST /api/auth/login 200` | Sign-in worked |
| `POST /api/auth/login 401` | Wrong email or password |
| `POST /api/auth/login 423` | Account locked after too many failed tries |
| `POST /api/auth/login 429` | Rate limit: too many attempts from your connection |
| `POST /api/auth/login 400` | The form data was invalid, e.g. a badly formed email |
| `POST /api/auth/logout 200` | Signed out |
| `POST /api/auth/token` | Someone opened an invite or reset link. 400 means the link was invalid or expired. |
| `POST /api/auth/set-password 200` | A password was set from a link |
| `GET /api/auth/me 401` | A page checked for a signed-in user and found none. This is normal before sign-in. |

To show only failures:

```sh
grep -E ' /api/auth/[a-z-]+ (4|5)[0-9]{2} ' server.log
```

## 2. Account and session details from the database

Run these from `ct-civic-data-explorer/` while the database container is running. `-p` makes MySQL ask for the password; type the `DB_PASSWORD` from your `.env`. `civicdata` is the `DB_NAME` from `.env`.

```sh
# Failed sign-in counts and lockouts for each account
docker compose exec db mysql -uctdata -p civicdata -e \
  "SELECT id, email, role, is_active, failed_login_count, first_failed_login_at, locked_until FROM users;"

# Invite and password-reset link history (created, used, expired)
docker compose exec db mysql -uctdata -p civicdata -e \
  "SELECT t.id, u.email, t.purpose, t.created_at, t.expires_at, t.used_at FROM user_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC;"

# Current sign-in sessions and when they expire
docker compose exec db mysql -uctdata -p civicdata -e \
  "SELECT sid, expire, sess FROM session ORDER BY expire DESC;"
```

