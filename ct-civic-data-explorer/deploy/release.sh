#!/usr/bin/env bash
set -euo pipefail
umask 077

archive=$1
environment=$2
host=$3
admin_email=${4:-}
root=/opt/ctde

if [[ $environment != staging && $environment != production ]]; then
  echo "Invalid deployment environment" >&2
  exit 1
fi
if [[ ! $host =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "A static IPv4 address is required" >&2
  exit 1
fi

IFS= read -r gemini_key
gemini_key=${gemini_key%$'\r'}
if [[ ! $gemini_key =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Missing or invalid Gemini key" >&2
  exit 1
fi

exec 9>"$root/deploy.lock"
flock -n 9
release=$(mktemp -d "$root/release.XXXXXXXX")
tar -xzf "$archive" -C "$release" --no-same-owner
rm -f -- "$archive"

# Preserve the database password and session secret between releases.
runtime="$root/runtime.env"
next_runtime=$(mktemp "$root/runtime.XXXXXXXX")
if [[ -f $runtime ]]; then
  grep -qxF "CTDE_HOST=$host" "$runtime"
  grep -qxF "CTDE_ENV=$environment" "$runtime"
  sed '/^GEMINI_API_KEY=/d' "$runtime" > "$next_runtime"
else
  cat > "$next_runtime" <<EOF
NODE_ENV=production
CTDE_ENV=$environment
CTDE_HOST=$host
APP_BASE_URL=https://$host
TRUST_PROXY=true
COOKIE_SECURE=true
DB_NAME=ctde_$environment
DB_USER=ctde_$environment
DB_PASSWORD=$(openssl rand -hex 32)
DB_POOL_MAX=5
SESSION_SECRET=$(openssl rand -hex 32)
AI_PROVIDER=google
EOF
fi
printf 'GEMINI_API_KEY=%s\n' "$gemini_key" >> "$next_runtime"
unset gemini_key
mv -f -- "$next_runtime" "$runtime"

compose=(docker compose --project-name ctde --env-file "$runtime" -f "$release/deploy/compose.yml")
"${compose[@]}" build app
"${compose[@]}" up -d --wait --wait-timeout 180 db
"${compose[@]}" run --rm --no-deps -T app node scripts/migrate.js

if [[ -n $admin_email && ! -f $root/.admin-provisioned ]]; then
  if [[ ! -s $root/admin-invite.txt ]]; then
    "${compose[@]}" run --rm --no-deps -T app node scripts/create-admin.js \
      --email "$admin_email" --first "CT Data" --last "Admin" > "$root/admin-invite.txt"
  fi
  "${compose[@]}" run --rm --no-deps -T -v "$release/sample-data:/sample-data:ro" \
    app npm run seed:samples
  touch "$root/.admin-provisioned"
fi

"${compose[@]}" up -d --wait --wait-timeout 180 app proxy
ln -sfn -- "$release" "$root/current"

# Keep the running release only. The project name keeps database and TLS volumes stable.
find "$root" -maxdepth 1 -type d -name 'release.*' ! -path "$release" -exec rm -rf -- {} +
docker image prune -f
