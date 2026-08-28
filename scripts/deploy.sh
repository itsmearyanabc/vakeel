#!/usr/bin/env bash
#
# Deploy Vakeel Saathi on a shared VPS.
#
# Written for a host that runs other people's production apps. Every step is
# scoped to this application by name or by path, and the script refuses rather
# than guesses whenever it is not certain — a deploy script on a shared box
# should fail loudly, never improvise.
#
#   ./scripts/deploy.sh
#
# It will: verify the Node version, install, build, run migrations, and reload
# the two pm2 apps. It will not touch pm2 processes it does not own, it will not
# change system Node, and it will not restart anything else.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

WEB_APP="vakeel-web"
WORKER_APP="vakeel-worker"
REQUIRED_NODE_MAJOR=22

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mxx\033[0m %s\n\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Node
#
# The OpenAI SDK refuses to run below 22, and this box's system Node is 20
# because other applications depend on it. NODE_INTERPRETER points at an
# nvm-managed 22 used by these two apps only.
# ---------------------------------------------------------------------------
say "Checking Node"

if [ -z "${NODE_INTERPRETER:-}" ]; then
  # Best effort: find the newest nvm-installed v22 without sourcing nvm, which
  # would alter this shell's PATH and could leak into anything it starts.
  CANDIDATE="$(ls -d "$HOME"/.nvm/versions/node/v22.*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$CANDIDATE" ]; then
    NODE_INTERPRETER="$CANDIDATE"
  else
    NODE_INTERPRETER="$(command -v node || true)"
  fi
fi

[ -x "$NODE_INTERPRETER" ] || die "No Node binary found. Install Node ${REQUIRED_NODE_MAJOR} with nvm and set NODE_INTERPRETER."

NODE_MAJOR="$("$NODE_INTERPRETER" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  die "Node $("$NODE_INTERPRETER" -v) is too old; ${REQUIRED_NODE_MAJOR}+ is required.
   Do NOT upgrade system Node — other apps on this host run on it.
   Instead:  nvm install 22 && export NODE_INTERPRETER=\"\$(nvm which 22)\""
fi

export NODE_INTERPRETER
NPM_BIN="$(dirname "$NODE_INTERPRETER")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm)"

say "Using $("$NODE_INTERPRETER" -v) at $NODE_INTERPRETER"

# ---------------------------------------------------------------------------
# 2. Configuration
# ---------------------------------------------------------------------------
[ -f .env ] || die ".env is missing. Copy .env.example and fill in DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY and WHATSAPP_VERIFY_TOKEN."

grep -qE '^DATABASE_URL=.+' .env || die "DATABASE_URL is not set in .env"
grep -qE '^JWT_SECRET=.{16,}' .env || die "JWT_SECRET is missing or shorter than 16 characters"
grep -qE '^ENCRYPTION_KEY=[0-9a-fA-F]{64}$' .env || die "ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32)"

# An unsubstituted placeholder is the most likely thing to be wrong in a
# hand-edited .env, and it fails deep inside a library with `ERR_INVALID_URL`
# and a stack trace that says nothing about which variable is at fault. Caught
# here instead, by name.
for var in DATABASE_URL DIRECT_URL APP_PUBLIC_URL OPENAI_API_KEY KANOON_API_KEY \
           LEGAL_OPERATOR_NAME LEGAL_CONTACT_EMAIL WHATSAPP_DISPLAY_NUMBER; do
  if grep -qE "^${var}=.*[<>]" .env; then
    die "${var} still contains a <placeholder> from the template. Replace it, or delete the line if it is optional."
  fi
done

# The two legal fields are the ones a placeholder does the most damage to. The
# others fail loudly at runtime - a bad DATABASE_URL cannot connect - while
# these render straight onto a public page that Meta reads during app review,
# and the deployment goes on looking perfectly healthy while doing it.
if grep -qE '^WHATSAPP_DISPLAY_NUMBER=.*[^0-9=]' .env; then
  warn "WHATSAPP_DISPLAY_NUMBER should be digits only (919876543210), with no +, spaces or brackets.
   It is used to build wa.me links; anything else produces a link that opens nothing."
fi

# DIRECT_URL is only consulted by the migration runner, and only because the
# Supabase transaction pooler (port 6543) cannot run DDL reliably. Pointing it
# at 6543 defeats the entire reason it exists.
if grep -qE '^DIRECT_URL=.*:6543' .env; then
  warn "DIRECT_URL points at the transaction pooler (6543). Migrations need the session port (5432);
   DDL on 6543 fails intermittently, which is worse than failing outright."
fi

if grep -qE '^REDIS_URL=.+' .env; then
  warn "REDIS_URL is set but nothing reads it any more (migration 0013). Safe to delete."
fi

# ---------------------------------------------------------------------------
# 3. Build
#
# `npm ci` rather than `npm install`: it installs exactly the lockfile and
# fails if package.json and the lock disagree, which is what makes a deploy
# reproducible instead of "whatever resolved today".
# ---------------------------------------------------------------------------
say "Installing dependencies"
PATH="$(dirname "$NODE_INTERPRETER"):$PATH" "$NPM_BIN" ci

say "Building"
PATH="$(dirname "$NODE_INTERPRETER"):$PATH" "$NPM_BIN" run build

[ -f dist/main.js ] || die "Build produced no dist/main.js"
[ -f dist/worker.js ] || die "Build produced no dist/worker.js"

# ---------------------------------------------------------------------------
# 4. Migrations
#
# Before the new code starts, and additive-only, so the currently running old
# code keeps working through the window between the two.
# ---------------------------------------------------------------------------
say "Applying database migrations"
PATH="$(dirname "$NODE_INTERPRETER"):$PATH" "$NPM_BIN" run db:migrate

# ---------------------------------------------------------------------------
# 5. pm2
#
# `startOrReload` on the ecosystem file, which only ever names this app's two
# processes. Nothing here can match another application, and nothing calls
# `pm2 restart all`.
# ---------------------------------------------------------------------------
say "Reloading pm2 apps ($WEB_APP, $WORKER_APP)"
command -v pm2 >/dev/null || die "pm2 is not installed"

pm2 startOrReload ecosystem.config.js --update-env
pm2 save

# ---------------------------------------------------------------------------
# 6. Prove it came up
#
# A deploy that reports success without checking is a deploy that reports
# success when the process is crash-looping.
# ---------------------------------------------------------------------------
PORT_IN_USE="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '\r' || true)"
PORT_IN_USE="${PORT_IN_USE:-3000}"

say "Waiting for health check on port $PORT_IN_USE"
for attempt in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT_IN_USE}/health/ready" >/dev/null 2>&1; then
    say "Healthy. Deployed."
    pm2 list | grep -E "$WEB_APP|$WORKER_APP" || true
    exit 0
  fi
  sleep 2
done

warn "No healthy response after 60s. The processes are running but not serving."
echo "  pm2 logs $WEB_APP --lines 50 --nostream"
exit 1
