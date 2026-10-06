#!/usr/bin/env bash
#
# Reset the password on a CT Civic Data Explorer account, for when nobody can
# sign in to use the admin UI. Run it on the machine that can reach the
# database; it reads the same .env the app does.
#
#   ./scripts/reset-password.sh admin@ctdata.org            # print a one-time set-password link
#   ./scripts/reset-password.sh -p admin@ctdata.org         # type a new password now
#
# The password is prompted for without echo and handed to Node on stdin, so it
# never lands in the process list or your shell history.

set -euo pipefail

readonly APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly MIN_PASSWORD_LENGTH=12

usage() {
  cat <<'USAGE'
Usage: scripts/reset-password.sh [-p] <email>

  -p, --password   Set a new password now (prompted twice, not echoed).
                   Without it, a one-time set-password link is printed instead.
  -h, --help       Show this message.

The link expires in 1 hour for an account that already has a password, or in
7 days for one that has never set one. Either way the reset clears any lockout
and ends that account's other sessions.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

main() {
  local email='' set_password=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -p | --password) set_password=true ;;
      -h | --help)
        usage
        return 0
        ;;
      -*) die "unknown option: $1 (try --help)" ;;
      *)
        [[ -n "$email" ]] && die "only one email address is expected"
        email="$1"
        ;;
    esac
    shift
  done

  [[ -n "$email" ]] || {
    usage >&2
    return 2
  }

  command -v node >/dev/null 2>&1 || die "node is not on PATH"
  [[ -d "$APP_DIR/node_modules" ]] || die "dependencies are missing; run npm ci in $APP_DIR first"
  [[ -f "$APP_DIR/.env" ]] || echo "warning: no .env in $APP_DIR; using DB_* from the environment" >&2

  # dotenv reads .env from the working directory, so the app directory has to be
  # the working directory no matter where this script was invoked from.
  cd "$APP_DIR"

  if [[ "$set_password" != true ]]; then
    node scripts/reset-password.js --email "$email"
    return
  fi

  local password
  password="$(read_password)"
  printf '%s' "$password" |
    node scripts/reset-password.js --email "$email" --password-stdin
}

# Prompt for the new password twice on the terminal, or take it from stdin when
# there is no terminal, so the script can also be driven from a deploy runbook.
read_password() {
  if [[ ! -t 0 ]]; then
    local piped
    IFS= read -r piped || true
    [[ -n "$piped" ]] || die "no password on stdin"
    printf '%s' "$piped"
    return
  fi

  local first second
  # Leave echo on if the prompt is interrupted mid-read.
  trap 'stty echo 2>/dev/null; exit 130' INT TERM

  read -rs -p "New password (at least $MIN_PASSWORD_LENGTH characters): " first </dev/tty
  echo >&2
  [[ -n "$first" ]] || die "no password entered"

  read -rs -p "Repeat the password: " second </dev/tty
  echo >&2
  [[ "$first" == "$second" ]] || die "the two passwords do not match"

  trap - INT TERM
  printf '%s' "$first"
}

main "$@"
