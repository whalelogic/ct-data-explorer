#!/usr/bin/env bash
#
# List every HTTP route the API defines, with its full path, who can call it,
# and where it is defined. Reads src/app.js for each router's mount prefix and
# src/routes/*.js for the routes themselves.
#
#   ./scripts/list-routes.sh             # coloured table
#   ./scripts/list-routes.sh --no-color  # plain text, e.g. to save to a file
#
# Colour is also turned off when output is not a terminal or NO_COLOR is set.
# Works with the bash 3.2 that ships with macOS and with GNU or BSD awk.

set -euo pipefail

readonly APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/list-routes.sh [--no-color]

  --no-color   Print without colours.
  -h, --help   Show this message.
USAGE
}

use_color=true
case "${1:-}" in
  --no-color) use_color=false ;;
  -h | --help) usage; exit 0 ;;
  '') ;;
  *) usage >&2; exit 2 ;;
esac
[[ -t 1 && -z "${NO_COLOR:-}" ]] || use_color=false

if $use_color; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RESET=$'\e[0m'
  GREEN=$'\e[32m' YELLOW=$'\e[33m' BLUE=$'\e[34m' MAGENTA=$'\e[35m' RED=$'\e[31m' CYAN=$'\e[36m'
else
  BOLD='' DIM='' RESET='' GREEN='' YELLOW='' BLUE='' MAGENTA='' RED='' CYAN=''
fi

cd "$APP_DIR"

# One tab-separated line per route: method, full path, access, file:line.
# Mount prefixes come from lines like: app.use('/api/towns', townsRouter);
routes="$(
  awk '
    FNR == NR {
      if (match($0, /app\.use\(.\/api[^"'\'']*.,[ ]*[A-Za-z]+Router/)) {
        call = substr($0, RSTART, RLENGTH)
        split(call, parts, /[(,'\''"]+/)
        name = call; sub(/.*[ ,]/, "", name)
        prefix[name] = parts[2]
      }
      next
    }
    FNR == 1 { router_admin = 0 }
    /Router\.use\(requireRole\(.admin.\)\)/ { router_admin = 1 }
    match($0, /[A-Za-z]+Router\.(get|post|put|patch|delete)\(/) {
      call = substr($0, RSTART, RLENGTH - 1)
      name = call; sub(/\..*/, "", name)
      method = toupper(substr(call, index(call, ".") + 1))
      line = FNR; text = $0
      # A route can span several lines; read up to its handler so the path
      # and any requireRole() further down are included.
      while (text !~ /=>/ && (getline nextline) > 0) text = text " " nextline
      path = ""
      if (match(text, /\([ ]*.\/[A-Za-z0-9_:\/-]*/)) {
        path = substr(text, RSTART, RLENGTH); sub(/^\([ ]*./, "", path)
      }
      full = prefix[name] (path == "/" ? "" : path)
      if (full == "") full = "/"
      if (router_admin || text ~ /requireRole\(.admin.\)/) access = "admin"
      else if (prefix[name] == "/api/auth" && text !~ /requireAuth/) access = "public"
      else access = "signed in"
      printf "%s\t%s\t%s\t%s:%d\n", method, full, access, FILENAME, line
    }
  ' src/app.js src/routes/*.js | sort -t $'\t' -k2,2 -k1,1
)"

method_color() {
  case "$1" in
    GET) printf '%s' "$GREEN" ;;
    POST) printf '%s' "$YELLOW" ;;
    PUT | PATCH) printf '%s' "$BLUE" ;;
    DELETE) printf '%s' "$RED" ;;
  esac
}

access_color() {
  case "$1" in
    public) printf '%s' "$CYAN" ;;
    admin) printf '%s' "$MAGENTA" ;;
  esac
}

# Pad before adding colour codes, so the invisible escape bytes don't break alignment.
printf '%s%-7s %-36s %-10s %s%s\n' "$BOLD" METHOD PATH ACCESS DEFINED "$RESET"
printf '%s%s%s\n' "$DIM" "$(printf '%.0s─' {1..90})" "$RESET"

count=0
while IFS=$'\t' read -r method path access where; do
  printf '%s%-7s%s %-36s %s%-10s%s %s%s%s\n' \
    "$(method_color "$method")" "$method" "$RESET" \
    "$path" \
    "$(access_color "$access")" "$access" "$RESET" \
    "$DIM" "$where" "$RESET"
  count=$((count + 1))
done <<<"$routes"

printf '%s%s%s\n' "$DIM" "$(printf '%.0s─' {1..90})" "$RESET"
printf '%s%d routes.%s Also served: /healthz (public) and static files from public/.\n' "$BOLD" "$count" "$RESET"
