#!/usr/bin/env bash
#
# One-shot VPS setup for Vakeel Saathi on a host that runs other applications.
#
#   bash scripts/vps-setup.sh
#
# ## What this will and will not do
#
# It automates everything that cannot disturb a neighbouring app: an nvm-local
# Node 22, this repository, its two pm2 processes, the database migrations.
#
# It deliberately does NOT install or reconfigure a web server. Ports 80 and 443
# can only be held by one process, so installing Caddy next to a running nginx
# takes the running site down. That step is reported, not performed — on a
# shared host the script that improvises is the script that causes the outage.
#
# It records the other pm2 processes before it starts and checks them again at
# the end, so "did this touch anything else" is answered by evidence.

set -euo pipefail

APP_NAME="vakeel"
APP_DIR="${APP_DIR:-$HOME/$APP_NAME}"
REPO="${REPO:-https://github.com/itsmearyanabc/vakeel.git}"
DOMAIN="${DOMAIN:-vakeelsaathi.in}"
PORT="${PORT:-3001}"
NODE_MAJOR=22

bold()  { printf '\n\033[1;36m── %s\033[0m\n' "$1"; }
ok()    { printf '   \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '   \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
bold "Recording the state of other applications"
# ---------------------------------------------------------------------------
# Captured now so the end of this script can prove nothing else was disturbed,
# rather than assuring you of it.
OTHERS_BEFORE="$(pm2 jlist 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s).filter(p=>!p.name.startsWith("vakeel")).forEach(p=>console.log(p.name+":"+p.pid))}catch{}})' \
  2>/dev/null || true)"

if [ -n "$OTHERS_BEFORE" ]; then
  echo "$OTHERS_BEFORE" | while read -r line; do ok "leaving alone: $line"; done
else
  warn "no other pm2 apps detected (or pm2 not running yet)"
fi

# ---------------------------------------------------------------------------
bold "Node ${NODE_MAJOR} — installed privately, system Node untouched"
# ---------------------------------------------------------------------------
# nvm installs under $HOME. The pm2 daemon and every other app keep running on
# whatever Node they were started with; only this app's two processes are
# pointed at the new one, via `interpreter` in ecosystem.config.js.
export NVM_DIR="$HOME/.nvm"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

nvm install "$NODE_MAJOR" >/dev/null
NODE_BIN="$(nvm which "$NODE_MAJOR")"
[ -x "$NODE_BIN" ] || die "nvm did not produce a Node ${NODE_MAJOR} binary"

export NODE_INTERPRETER="$NODE_BIN"
export PATH="$(dirname "$NODE_BIN"):$PATH"
ok "using $("$NODE_BIN" -v) at $NODE_BIN"

# Deliberately NOT running `nvm alias default`. Doing so would make Node 22 the
# default for new shells, and a later `pm2 update` would move the daemon — and
# every other app on this host — onto it.
ok "system Node left as $(command -v node >/dev/null && /usr/bin/node -v 2>/dev/null || echo 'unchanged')"

# ---------------------------------------------------------------------------
bold "Repository"
# ---------------------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard origin/main --quiet
  ok "updated $APP_DIR to origin/main"
else
  git clone --quiet "$REPO" "$APP_DIR"
  ok "cloned into $APP_DIR"
fi

cd "$APP_DIR"

# The single reliable signal that the new code actually arrived. Everything
# below assumes the Redis-free build.
[ -f ecosystem.config.js ] || die "This checkout predates the rewrite (no ecosystem.config.js).
   Push your local commits to GitHub first, then re-run."
ok "confirmed the current build is present"

# ---------------------------------------------------------------------------
bold "Configuration"
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  cat > .env <<ENVTEMPLATE
NODE_ENV=production
PORT=${PORT}
LOG_LEVEL=info

# Must match how the site is actually reached. Once Cloudflare and TLS are up
# this is correct; until then, signing in over http://<ip>:${PORT} will NOT work,
# because an https value here makes the browser drop the session cookie.
APP_PUBLIC_URL=https://${DOMAIN}

DATABASE_URL=
# Direct connection (port 5432) — migrations run DDL, which the pooler on 6543
# cannot do reliably.
DIRECT_URL=

JWT_SECRET=
ENCRYPTION_KEY=

WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_PHONE_NUMBER_ID=
# Left blank on purpose: outbound messages are logged instead of sent until set.
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_DISPLAY_NUMBER=

LLM_SYNTHESIS_PROVIDER=openai
LLM_ROUTER_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_SYNTHESIS_MODEL=gpt-4o
OPENAI_ROUTER_MODEL=gpt-4o-mini

KANOON_API_KEY=
PRECEDENT_SOURCE=auto

ADMIN_EMAIL=
ADMIN_PASSWORD=

CREDITS_FREE_MONTHLY=30
# The default of 120 is a testing value that re-onboards advocates mid-thought.
SESSION_TTL_SECONDS=1800
ENVTEMPLATE

  die "Wrote a .env template to $APP_DIR/.env — fill it in, then re-run this script.
   nano $APP_DIR/.env"
fi

grep -qE '^DATABASE_URL=.+'                  .env || die "DATABASE_URL is empty in .env"
grep -qE '^JWT_SECRET=.{16,}'                .env || die "JWT_SECRET is missing or under 16 characters"
grep -qE '^ENCRYPTION_KEY=[0-9a-fA-F]{64}$'  .env || die "ENCRYPTION_KEY must be exactly 64 hex characters"
grep -qE '^WHATSAPP_VERIFY_TOKEN=.+'         .env || die "WHATSAPP_VERIFY_TOKEN is empty in .env"
ok ".env has the four required values"

grep -qE '^REDIS_URL=.+' .env && warn "REDIS_URL is set but nothing reads it — safe to delete" || true

ENV_PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '\r' || true)"
PORT="${ENV_PORT:-$PORT}"

# ---------------------------------------------------------------------------
bold "Checking the port is free"
# ---------------------------------------------------------------------------
if ss -ltn "( sport = :$PORT )" 2>/dev/null | grep -q ":$PORT"; then
  # Ours from a previous run is fine; anyone else's is not.
  if pm2 pid "${APP_NAME}-web" >/dev/null 2>&1; then
    ok "port $PORT held by our own vakeel-web (will be reloaded)"
  else
    die "Port $PORT is already in use by another process.
   Pick a different PORT in .env and re-run."
  fi
else
  ok "port $PORT is free"
fi

# ---------------------------------------------------------------------------
bold "Retiring the old single-process app, if present"
# ---------------------------------------------------------------------------
# Scoped by exact name. Nothing here can match a neighbour's process.
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 delete "$APP_NAME" >/dev/null
  ok "removed the old '$APP_NAME' process (replaced by vakeel-web + vakeel-worker)"
else
  ok "nothing to retire"
fi

# ---------------------------------------------------------------------------
bold "Building and deploying"
# ---------------------------------------------------------------------------
chmod +x scripts/deploy.sh
NODE_INTERPRETER="$NODE_BIN" ./scripts/deploy.sh

# ---------------------------------------------------------------------------
bold "Confirming nothing else moved"
# ---------------------------------------------------------------------------
OTHERS_AFTER="$(pm2 jlist 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s).filter(p=>!p.name.startsWith("vakeel")).forEach(p=>console.log(p.name+":"+p.pid))}catch{}})' \
  2>/dev/null || true)"

if [ "$OTHERS_BEFORE" = "$OTHERS_AFTER" ]; then
  ok "other applications unchanged (same pids)"
else
  warn "another app's pid changed — inspect before continuing:"
  printf '     before: %s\n     after:  %s\n' "$OTHERS_BEFORE" "$OTHERS_AFTER"
fi

# ---------------------------------------------------------------------------
bold "What is serving ports 80 and 443"
# ---------------------------------------------------------------------------
# Reported rather than acted on. See the header for why.
HTTP_HOLDER="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $NF}' | grep -oP 'users:\(\("\K[^"]+' | sort -u | tr '\n' ' ' || true)"

if [ -z "$HTTP_HOLDER" ]; then
  echo "   Nothing is on 80/443. Caddy is the simplest option:"
  echo "     sudo apt install -y caddy"
  echo "     sudo cp deploy/Caddyfile /etc/caddy/Caddyfile"
  echo "     # install the Cloudflare origin cert, then: sudo systemctl reload caddy"
else
  echo "   Held by: $HTTP_HOLDER"
  echo "   Do NOT install a second web server. Add a vhost to the existing one:"
  echo "     sudo cp deploy/nginx-vakeelsaathi.conf /etc/nginx/sites-available/${DOMAIN}"
  echo "     sudo ln -s /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/"
  echo "     sudo nginx -t && sudo systemctl reload nginx"
fi

printf '\n\033[1;32mApplication is up on 127.0.0.1:%s\033[0m\n' "$PORT"
echo "Next: deploy/cloudflare.md — DNS, origin certificate, and the WAF rule that"
echo "stops Cloudflare from blocking Meta's webhook."
printf '\n'
