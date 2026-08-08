# 🧠 brain.md — Vakeel Saathi project ledger

> **What this file is.** The single place that records what exists, what changed,
> why each non-obvious decision was made, and what is still missing. Read this
> first when you come back to the project after a break, or when handing it to
> someone else.
>
> **Keep it current.** When you change something structural, add a row to
> [Change log](#-change-log) and update the affected table. A stale ledger is
> worse than none, because it gets trusted.

**Last updated:** 2026-08-07
**Repo:** `github.com/itsmearyanabc/vakeel` · branch `main`
**Stack:** NestJS 11 (Fastify) · Supabase Postgres + pgvector · Redis + BullMQ · WhatsApp Cloud API · Railway

---

## 📍 Current status at a glance

| Area | State | Notes |
|---|---|---|
| Backend code | 🟢 Complete | 99 files, compiles clean, 111 tests passing |
| Database schema | 🟢 **Applied** | Supabase `biwncplbeatjuaixcekf` · PG 17.6 · 12 tables · both HNSW indexes live · 31 statutes seeded |
| WhatsApp connection | 🔴 Not connected | Needs Meta credentials — [walkthrough below](#-connecting-whatsapp-step-by-step) |
| Admin panel | 🟢 Built | Served at `/admin`, no separate deploy |
| Feature 1 — CNR case status | 🟡 Works, mock data | Real data needs an eCourts provider subscription |
| Feature 2 — Law sections | 🟡 Works, thin corpus | 10 seeded sections; needs bulk bare-act ingestion |
| Feature 3 — Precedents | 🟢 Built | Needs judgment corpus loaded to return anything |
| AI providers | 🔴 All on `mock` | No API keys yet — answers are placeholders |
| Deployment | 🟡 Render — builds, won't boot | Image builds fine; needs env vars **and a pooler DB URL** (IPv6 trap) |
| Billing / payments | ⚫ Out of scope | Deliberately skipped — see [Not built](#-deliberately-not-built) |

**Legend:** 🟢 done · 🟡 partial / needs data · 🔴 blocked on you · ⚫ intentionally excluded

---

## 🎯 The three priority features

These are the product. Everything else exists to serve them.

### 1. Case status by CNR

**What it does.** User sends a 16-character CNR (e.g. `BRMG030000191989`); bot
returns case stage, next hearing date, judge, parties and advocates.

| Piece | File | State |
|---|---|---|
| CNR validation | `src/ai/legal-patterns.ts` → `isValidCnr()` | 🟢 Validates 4 letters + 2 alphanumeric + 10 digits, with a 1950–next-year sanity check on the year |
| Extraction from free text | `src/ai/legal-patterns.ts` → `extractCnr()` | 🟢 Finds a CNR inside a sentence |
| Lookup adapter | `src/ecourts/ecourts.service.ts` | 🟡 `mock` and `http` modes |
| Reply formatting | `src/whatsapp/replies.ts` → `formatCaseStatus()` | 🟢 |
| Caching | Redis, 1 hour | 🟢 Cause lists move daily, not hourly |
| Failure isolation | `src/common/circuit-breaker.ts` | 🟢 A dead provider stops being called rather than timing out every request |

**⚠️ The honest limitation.** India's eCourts has **no free public API**. In
`mock` mode the bot returns realistic, deterministic, entirely fabricated case
data — clearly labelled as sample data in the reply. To get real data you must
subscribe to a commercial eCourts provider, then set mode to `http` and point it
at them in the admin panel.

Scraping the eCourts portal is not implemented on purpose: it is CAPTCHA-guarded
and changes without notice, and defeating a government portal's bot protection is
a legal exposure this product does not need.

**Verify it:** send `BRMG030000191989` to the bot. You should get a formatted
case card ending with a sample-data notice.

---

### 2. Law section lookup

**What it does.** "What is IPC 420", "punishment for cheating", "section 302
under BNS" → returns the section with summary, key elements and practical use.

| Piece | File | State |
|---|---|---|
| Section/act extraction | `src/ai/legal-patterns.ts` | 🟢 Handles `420`, `s.420`, `sec 420 IPC`, `498A` |
| Act aliases | same | 🟢 IPC, BNS, CrPC, BNSS, IEA, BSA + long names |
| Statute search | `search_statutes()`, migration 0004 | 🟢 Full-text + trigram fuzzy on section number |
| Explanation prompt | `src/ai/prompts.ts` | 🟢 |
| Hallucination guard | `verify_statute_refs()` + `guardrails.service.ts` | 🟢 A section reference not in the DB is stripped before send |
| **Corpus** | `supabase/migrations/0006_seed_statutes.sql` | 🟡 **31 sections seeded** (verified live) |

**⚠️ The gap that matters.** The retrieval and guardrails are done; the *content*
is not. 31 sections is a demo, not a product — unless the government API supplies
this live, in which case see [Government API](#-government-api-integration-pending).

**Verified live against Supabase:** `search_statutes('cheating')` returns
**IPC 420** and **BNS 318(4)** — so plain-language lookup and the IPC↔BNS
mapping both work.

**IPC↔BNS mapping is already modelled** (`corresponding_act` /
`corresponding_section` columns) because "what is 302 IPC now?" is the single
most common question since the 2023 recodification — but it is only populated for
the seeded rows.

---

### 3. Case law / precedent search

**What it does.** Natural-language research question → **up to 15 precedents per
session, newest first, with citations**, paged 5 at a time.

| Piece | File | State |
|---|---|---|
| Judgment-level search | `search_precedents()`, migration **0008** | 🟢 New |
| Repository call | `corpus.repository.ts` → `searchPrecedents()` | 🟢 New |
| Service + formatting | `src/ai/precedents.service.ts` | 🟢 New |
| Chat paging (`more`) | `conversation.service.ts` → `SHOWING_PRECEDENTS` | 🟢 New |
| Direct citation fetch | `lookup_judgment_by_citation()` | 🟢 New |
| Tests | `precedents.format.spec.ts` | 🟢 20 cases |
| **Corpus** | — | 🔴 **Empty until you ingest judgments** |

#### Three design decisions worth knowing

**One row per judgment, not per passage.** The general RAG path retrieves
*passages* to feed a model — and three of them can come from the same case. For a
precedent list that is wrong: the advocate sees the same authority three times and
gets three fewer. Collapsing happens in SQL via `DISTINCT ON (judgment_id)`,
keeping the best-scoring passage as the synopsis.

**Relevance decides membership; chronology decides order.** Sorting the corpus by
date alone returns whatever is newest regardless of subject. So it is a two-stage
sort: rank by relevance → keep top 15 → re-sort those by `judgment_date DESC`.
That is also the order you cite in, since the court's latest position governs.

**No LLM call produces the list.** Each entry is assembled from corpus rows — the
synopsis is the judgment's own ratio or headnote. This means **every citation is
real by construction** (nothing is generated, so nothing can be invented), and
the feature keeps working with zero AI providers configured. The RAG path cannot
claim either.

**What the user sees:**

```
*Case law — 12 precedents*
_bail in NDPS commercial quantity_

Showing 1–5 of 12, newest first.

*1. State of Maharashtra v. ABC*
Supreme Court of India · 2024
📑 2024 INSC 452
⚖️ 3-judge bench
Result: allowed

Bail may be granted where the accused has no antecedents...

_Provisions: NDPS 37, NDPS 8(c)_
_Decided 2024-03-15_

────────
   ... 4 more entries ...

_7 more — reply *more* to continue._

_Results come from the loaded judgment corpus and may not be
exhaustive. Always verify before citing._
```

---

## 🖥 Admin panel

**URL:** `https://<your-app>.up.railway.app/admin` (locally `http://localhost:3000/admin`)
**Login:** paste your `JWT_SECRET` value. Held in `sessionStorage`, cleared when the tab closes.

| Page | What it gives you |
|---|---|
| **Dashboard** | KPI tiles, 14-day query line chart, intent donut, daily table, delivery outcomes. Red banners when WhatsApp is disconnected / AI is on mock / corpus is empty |
| **Verifications** | Bar-council review queue — approve or reject, advocate notified automatically |
| **Users** | Search, role changes, per-day usage, verification status |
| **Queries** | Every question asked, with a **flagged-only** filter = the hallucination review queue |
| **Messages** | Raw inbound/outbound log — first place to look when "the bot didn't reply" |
| **Corpus** | Judgment/passage/statute counts, **% embedded**, breakdown by court |
| **Settings** | ⭐ Paste WhatsApp credentials, AI keys, tuning, quotas — **no redeploy** |
| **Audit log** | Every config change, who and when. Secret *values* never recorded |

### How the Settings page works (the important bit)

Configuration used to come only from environment variables, which are **frozen at
process boot** — so "switch the bot to a different WhatsApp number" meant editing
Railway variables and waiting for two services to restart.

There is now an override layer. Resolution order:

```
app_settings table  →  environment variable  →  schema default
```

- Saving a setting writes to Postgres and publishes on Redis; **both** web and
  worker re-read within ~1 second (60s poll as backstop).
- **Secrets are encrypted** with AES-256-GCM before storage and are **never
  returned** by the API — you get "is it set" and a 4-character hint only.
- **Blank secret = keep existing.** The form cannot show you a stored secret, so
  submitting blank leaves it alone. Use **Reset** to genuinely clear one.
- **Reset** deletes the row, reverting that key to the Railway env value.

**Deliberately NOT settable from the panel:** `DATABASE_URL`, `REDIS_URL`,
`ENCRYPTION_KEY`, `JWT_SECRET`. They are needed to reach or decrypt the settings
table itself, so storing them there is circular — and one bad paste would lock
you out of the form that fixes it. Those stay on Railway.

---

## 📱 Connecting WhatsApp — step by step

This is the part that blocks everything else. Budget ~30 minutes.

### Prerequisites

| Need | Where | Cost |
|---|---|---|
| Facebook/Meta account | facebook.com | Free |
| Meta Business account | business.facebook.com | Free |
| A phone number **not** on regular WhatsApp | — | See ⚠️ below |
| Deployed app with a public HTTPS URL | Railway | ~$5/mo |

> ⚠️ **The number must not currently be registered on WhatsApp or WhatsApp
> Business.** If it is, delete that account first (WhatsApp → Settings → Account →
> Delete my account) and wait a few minutes. This trips up most people. A cheap
> second SIM is the easiest path. Meta also gives you a free **test number** — use
> that first; it can message up to 5 pre-approved recipients.

---

### Step 1 — Create the Meta app

1. Go to **developers.facebook.com** → *My Apps* → **Create App**
2. Use case: **Other** → Type: **Business**
3. Name it (e.g. "Vakeel Saathi"), link your Business account
4. On the dashboard, find **WhatsApp** → **Set up**

### Step 2 — Collect four values

Meta's dashboard → **WhatsApp → API Setup**:

| # | Value | Where exactly | Goes into |
|---|---|---|---|
| 1 | **Phone number ID** | Under "From" — the *numeric ID*, not the phone number | `WHATSAPP_PHONE_NUMBER_ID` |
| 2 | **Business account ID** | Same page, labelled WABA ID | `WHATSAPP_BUSINESS_ACCOUNT_ID` |
| 3 | **Access token** | "Temporary access token" — ⚠️ expires in 24h, see Step 5 | `WHATSAPP_ACCESS_TOKEN` |
| 4 | **App secret** | **App Settings → Basic** → *App Secret* → Show | `WHATSAPP_APP_SECRET` |

You also **invent** a fifth value:

| 5 | **Verify token** | Any long random string you make up. Generate one: `openssl rand -hex 24` | `WHATSAPP_VERIFY_TOKEN` |

### Step 3 — Deploy so you have a public URL

Meta must be able to reach your webhook over HTTPS. Local `localhost` will not
work (use `ngrok http 3000` if you want to test before deploying).

See [Deploying to Railway](#-deploying-to-railway) below, then note your URL:

```
https://<your-service>.up.railway.app
```

### Step 4 — Register the webhook

1. Meta dashboard → **WhatsApp → Configuration** → *Webhook* → **Edit**
2. **Callback URL:**
   ```
   https://<your-service>.up.railway.app/webhooks/whatsapp
   ```
3. **Verify token:** the string you invented in Step 2 (#5)
4. Click **Verify and save**

   Meta sends a `GET` with `hub.challenge`. Your app echoes it back. If this
   fails, the token does not match — it must be *byte-identical* on both sides.

5. Still on Configuration, under **Webhook fields**, click **Manage** and
   subscribe to **`messages`**.

   > 🔺 **This is the most-missed step.** Without the `messages` subscription the
   > webhook verifies successfully and then never fires. Everything looks correct
   > and nothing happens.

### Step 5 — Replace the temporary token (do this before you forget)

The dashboard token dies in 24 hours and the bot will stop with no obvious cause.

1. **business.facebook.com** → *Business Settings* → **Users → System Users**
2. **Add** → name it (e.g. "vakeel-bot") → role **Admin**
3. **Add Assets** → select your app → enable **Full control**
4. **Generate New Token** → pick your app → permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Set expiry to **Never**
6. Copy it — **it is shown once**

### Step 6 — Paste the credentials in

**Preferred — the admin panel** (no redeploy):

1. Open `https://<your-service>.up.railway.app/admin`
2. Sign in with your `JWT_SECRET`
3. **Settings → WhatsApp connection**
4. Paste all five values → **Save changes**
5. Click **Test connection**

You should see green ticks and your number's display name. If not, each failed
check tells you exactly which field to fix.

**Alternative — Railway variables.** Set the same keys under the service's
Variables tab. Requires a restart, and the panel overrides them if both are set.

### Step 7 — Prove it end to end

1. From your own phone, message the bot's number: `hi`
2. You should get the welcome + main menu
3. Try each priority feature:
   - `BRMG030000191989` → case status card
   - `what is IPC 420` → section explanation
   - `bail in NDPS commercial quantity` → precedent list (empty until you ingest)
4. Check **Admin → Messages** — you should see both directions logged

> 💡 **The 24-hour window.** WhatsApp only allows free-form messages within 24
> hours of the user last messaging you. Outside it you must use a pre-approved
> **template**. This is why the panel's "Send test message" can fail with a
> perfectly valid token — message the bot from that phone first.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Webhook won't verify | Verify token mismatch | Must be identical, no trailing spaces |
| Verified but no messages | Not subscribed to `messages` | Configuration → Webhook fields → Manage |
| Worked yesterday, dead today | Temporary token expired | Step 5 — permanent System User token |
| `error 190` | Invalid/expired token | Regenerate |
| `error 100` | Wrong phone number ID, or token from a different app | Both must be from the same app |
| `error 131030` | Recipient not in test-number allow-list | Add them, or use a real number |
| Bot receives but never replies | Worker not running | Check the Railway worker service logs |
| Replies only in logs, not WhatsApp | Credentials incomplete | Admin → Settings → Test connection |

---

## 🚀 Deploying to Render

> Blueprint: `render.yaml`. Railway config (`railway.*.json`) is kept for
> portability; Render ignores it and vice versa.

### The two failures you will hit, in order

**1. Missing environment variables** — the app refuses to boot and prints exactly
which are missing. This is the fail-fast guard in `src/config/env.ts` working as
intended: a missing `WHATSAPP_APP_SECRET` should crash the container at startup,
not surface three hours later as a stream of rejected webhooks.

Five are required:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **pooler** URL — see #2 below |
| `REDIS_URL` | From your Render Key Value instance |
| `JWT_SECRET` | `a8792423422e7b2318c3174a8d1050d63b2def4c8bc7fc7a8b67b7c554e31b26` |
| `ENCRYPTION_KEY` | `2c01fae8989e949e126b280562d1d3136981b3d6dcd39913aca1f5fb6de68245` |
| `WHATSAPP_VERIFY_TOKEN` | `9d59c2f4b8110c5ae98c3b4de6190804ca8b670b45df3673` |

**2. 🔴 The Supabase IPv6 trap** — this is the one that wastes an afternoon,
because it looks like a credentials problem.

Verified by DNS lookup on 2026-08-07:

```
db.biwncplbeatjuaixcekf.supabase.co   →  IPv6 only  (2406:da1c:16f1:f601:…)
aws-0-ap-south-1.pooler.supabase.com  →  IPv4       (65.0.195.55, 3.111.105.85)
```

Supabase's **direct** host is IPv6-only. **Render's outbound network is IPv4**,
so it cannot reach it — you get `ENETUNREACH` / `ETIMEDOUT` *after* your
credentials are correct.

Migrations ran fine from the dev machine only because it has IPv6. That does not
generalise to the deploy target.

**Fix:** use a **pooler** connection string. Supabase → Project Settings →
Database → Connection string → pooler tab:

| Use | Tab | Port | Goes in |
|---|---|---|---|
| App queries | Transaction pooler | 6543 | `DATABASE_URL` |
| Migrations | Session pooler | 5432 | `DIRECT_URL` |

```
postgresql://postgres.biwncplbeatjuaixcekf:PASSWORD@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Percent-encode the password: `?`→`%3F` `/`→`%2F` `:`→`%3A` `@`→`%40`

### Remaining Render steps

3. **Create a Key Value (Redis) instance.** ⚠️ Set `maxmemory-policy` to
   **`noeviction`**. BullMQ keeps job state in Redis; any eviction policy
   silently discards queued jobs, and the symptom is "message received, no
   reply" with nothing in the logs.
4. **Create the worker service** — same repo, same Dockerfile, start command
   `node dist/worker.js`. Without it the webhook accepts messages and nothing
   ever answers them.
5. Set `APP_PUBLIC_URL` to the web service's public URL, then register
   `<that URL>/webhooks/whatsapp` with Meta.

> 💡 Put the shared variables in a Render **environment group** attached to both
> services, so you maintain one copy rather than two that drift.

---

## 🚂 Deploying to Railway (alternative)

Two services from **one** repo and one Dockerfile — they differ only by start command.

| Service | Config file | Start command | Scales on |
|---|---|---|---|
| `web` | `railway.web.json` | `node dist/main.js` | inbound HTTP |
| `worker` | `railway.worker.json` | `node dist/worker.js` | queue depth |

> **Why split?** The webhook must answer Meta in well under a second or Meta
> throttles and eventually disables the subscription. All slow work — retrieval,
> LLM calls, eCourts — happens in the worker. If both ran in one process, a burst
> of AI calls would stall webhook acks.

1. Railway → **New Project → Deploy from GitHub** → this repo
2. Rename the service to `web`. Settings → *Config file path* → `railway.web.json`
3. **+ New → Database → Redis**
4. **+ New → GitHub Repo** (same repo) → name it `worker` → config file `railway.worker.json`
5. Set variables on **both** services (use a shared variable group):

```bash
DATABASE_URL=<supabase transaction pooler, port 6543>
DIRECT_URL=<supabase direct connection, port 5432>
REDIS_URL=${{Redis.REDIS_URL}}
JWT_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>       # exactly 64 hex chars
WHATSAPP_VERIFY_TOKEN=<openssl rand -hex 24>
APP_PUBLIC_URL=https://<your-web-service>.up.railway.app
NODE_ENV=production
```

6. Everything else goes in the admin panel afterwards.

> ⚠️ **`ENCRYPTION_KEY` is not rotatable in place.** Change it and every stored
> secret and encrypted bar-council ID becomes undecryptable. Generate once, store
> in a password manager.

---

## 🗄 Supabase setup

**You have not created the project yet — this is the next thing to do.**

1. **supabase.com** → New project. Pick a region near your users (Mumbai `ap-south-1`).
2. Save the database password immediately.
3. **Project Settings → Database → Connection string:**
   - *Transaction pooler* (port **6543**) → `DATABASE_URL` — Railway containers are
     short-lived and the pooler stops you exhausting Postgres connections
   - *Direct connection* (port **5432**) → `DIRECT_URL` — migrations need it
   - URL-encode the password if it contains `@ : / ? # [ ] %`
4. Run the migrations:

```bash
npm run db:migrate
```

Or paste each file from `supabase/migrations/` into the SQL Editor **in filename
order**.

### Schema map

| Table | Purpose | Migration |
|---|---|---|
| `users` | One row per phone number, created on first message | 0002 |
| `conversation_states` | Chat state machine, survives restarts | 0002 |
| `whatsapp_messages` | Append-only in/out log; unique `wa_message_id` = idempotency | 0002 |
| `search_history` | Every answered query; analytics + audit | 0002 |
| `daily_usage` | Durable quota ledger | 0002 |
| `processed_webhooks` | Second idempotency layer for status callbacks | 0002 |
| `statutes` | Bare act sections + IPC↔BNS mapping | 0003 |
| `judgments` | Case law metadata + full text | 0003 |
| `judgment_chunks` | Retrieval units: passage + embedding + tsvector | 0003 |
| `app_settings` | ⭐ Runtime config overrides (secrets encrypted) | 0007 |
| `settings_audit` | Who changed what config, when | 0007 |

### Key SQL functions

| Function | Does | Migration |
|---|---|---|
| `hybrid_search_judgments()` | Dense + lexical retrieval, RRF-fused, passage-level | 0004 |
| `search_statutes()` | Section lookup, full-text + fuzzy | 0004 |
| `verify_citations()` / `verify_statute_refs()` | Anti-hallucination existence checks | 0004 |
| `claim_daily_quota()` | Atomic quota claim under row lock | 0004 |
| `purge_expired_data()` | DPDP retention sweep | 0005 |
| `search_precedents()` | ⭐ Judgment-level, relevance→chronological | 0008 |
| `lookup_judgment_by_citation()` | Direct citation fetch | 0008 |

### 🔴 The pgvector trap (read before touching embeddings)

Embeddings are **3072-dimensional**. pgvector stores up to 16000 dims but its
**HNSW index caps at 2000**. A plain index fails with:

```
ERROR: column cannot have more than 2000 dimensions for hnsw index
```

The fix used here is `halfvec` — 16-bit floats, 4000-dim index limit, negligible
recall loss, half the index size. Full precision is kept in the column; the
**index is on a cast expression**:

```sql
CREATE INDEX ... USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
```

> ⚠️ **A cast-expression index is only used when the query expression matches
> exactly.** Every `ORDER BY` must be written
> `embedding::halfvec(3072) <=> $1::halfvec(3072)`, never `embedding <=> $1`, or
> Postgres silently falls back to a sequential scan over the whole corpus. The
> shipped functions are correct — if you hand-write a query, mirror them and check
> with `EXPLAIN`.

Changing embedding width means editing **every `3072` in migrations 0003 and
0008**, `EMBEDDING_DIMENSIONS`, and re-embedding the whole corpus.

---

## 📦 What you still need to supply

| # | Item | Blocks | Cost | Priority |
|---|---|---|---|---|
| 1 | **Supabase project + run migrations** | Everything | Free tier | 🔴 Now |
| 2 | **Railway deploy** (web + worker + Redis) | Public URL | ~$5/mo | 🔴 Now |
| 3 | **Meta WhatsApp credentials** | The entire bot | Free | 🔴 Now |
| 4 | **LLM API key** (any one) | Real answers vs placeholders | Pay-per-use | 🟠 High |
| 5 | **Embedding key** (OpenAI or Google) | Semantic search | ~$0.13/1M tokens | 🟠 High |
| 6 | **Judgment corpus** | Feature 3 returns nothing | Sourcing effort | 🟠 High |
| 7 | **Full bare acts** | Feature 2 beyond 10 sections | Sourcing effort | 🟠 High |
| 8 | **eCourts provider** | Real case status | Commercial | 🟡 Medium |

> ⚠️ **Anthropic has no embeddings endpoint.** If you use Claude for answers you
> still need OpenAI or Google for embeddings. Not a bug — Anthropic doesn't offer
> that product.

### Where to source Indian legal data

| Source | Content | Licence |
|---|---|---|
| **indiankanoon.org** | Judgments, all courts | ⚠️ Check ToS before bulk use |
| **main.sci.gov.in** | Supreme Court judgments + neutral citations | Public |
| **ecourts.gov.in** | High Court judgments | Public |
| **indiacode.nic.in** | Official bare acts | Government, public |
| **legislative.gov.in** | BNS/BNSS/BSA 2023 texts | Government, public |

Ingest format is JSONL — see `data/samples/judgments.sample.jsonl`:

```bash
npm run ingest -- --file data/corpus/judgments.jsonl
```

---

## 🏛 Government API integration (PENDING)

**Status:** 🔴 Blocked — awaiting API documentation from you.

You have been granted official government API access with a key, covering all
three priority features. This **changes the data architecture**, so nothing
should be ingested until it is wired in.

### What changes

The corpus tables were built on the assumption that there was no data source, so
we would have to hold Indian case law and bare acts ourselves and search them
with pgvector. If the government API serves that data live, that assumption is
wrong.

| Layer | Before | After |
|---|---|---|
| **Supabase** | Everything — app data *and* legal corpus | App data only: users, messages, quotas, settings, history, audit |
| **Legal data** | Ingested into `judgments` / `statutes`, embedded locally | Fetched live from the government API |
| `judgment_chunks` + embeddings | The retrieval engine | Possibly unnecessary, possibly a **cache** |

### The decision this forces: live-only, or cache?

| Approach | Good | Bad |
|---|---|---|
| **Live only** — call the API per query | Always current; no ingestion; no stale law | Latency on every message; breaks when API is down; rate limits; no semantic search unless *they* provide it |
| **Cache** — store responses in existing tables | Fast repeats; survives outages; semantic search stays possible | Staleness rules needed; more moving parts |
| **Hybrid** *(likely right)* | CNR live (changes daily), statutes+precedents cached (change rarely) | Two code paths |

My recommendation is **hybrid**: case status must be live because hearing dates
move; bare acts change once a decade and precedent text never changes once
reported, so both cache well. But this is genuinely your call, and it depends on
the API's rate limits.

### 🔴 What I need from you to build it

I cannot write the adapter without these — endpoint shapes are not guessable, and
wrong guesses produce code that compiles and fails at runtime.

1. **API documentation** — link or PDF. This is the main one.
2. **Base URL(s)** — one API for all three features, or three separate ones?
3. **Auth scheme** — header name and format. `X-API-Key: xxx`? `Authorization: Bearer xxx`? Query parameter?
4. **One sample response per feature** — redact the key, keep the JSON shape. A real response beats any spec.
5. **Rate limits** — requests/minute or /day. Directly determines the caching answer above.
6. **Search capability for precedents** — does it accept a natural-language query, or only structured filters (court, date, section)? If structured only, we keep local embeddings for semantic search and use the API for authoritative text.

**Do not paste the API key into chat** — put it in the admin panel once the
adapter exists, or in `.env` locally.

### What is already shaped to receive it

- `src/ecourts/ecourts.service.ts` — adapter pattern with `mock` / `http` modes,
  circuit breaker, and Redis caching. Its `mapProviderResponse()` is the single
  method to rewrite for the real CNR endpoint.
- Admin panel already exposes provider mode, base URL and API key as runtime
  settings, so switching from mock to live needs no redeploy.

---

## 📝 Change log

### 2026-08-07 (evening) — Render deploy

| # | Change | Why |
|---|---|---|
| 1 | Added `render.yaml` blueprint | Deploy target is Render, not Railway. Defines web + worker + Key Value, secrets as `sync: false` |
| 2 | Documented the **Supabase IPv6 trap** | Direct host is IPv6-only; Render is IPv4-only. Verified by DNS lookup. Presents as a credentials failure, isn't one |
| 3 | Documented `noeviction` requirement for Redis | Any eviction policy silently drops BullMQ jobs — symptom is a bot that receives and never replies |

**First deploy outcome:** image built and pushed successfully; container exited 1
at boot with `Invalid environment configuration` listing all five required
variables. That is the fail-fast guard behaving correctly, not a defect.

### 2026-08-07 (later) — Supabase live, reserved-keyword bug

| # | Change | Why |
|---|---|---|
| 1 | **Ran all 8 migrations** against Supabase `biwncplbeatjuaixcekf` | Schema had never touched a real Postgres |
| 2 | **Fixed: `exists` is a reserved word** — renamed to `found` in `verify_citations()` / `verify_statute_refs()`, plus `CitationCheck` / `StatuteRefCheck` and `guardrails.service.ts` | Migration 0004 failed with `syntax error at or near "exists"`. Postgres parses it as the EXISTS operator. Renamed rather than quoted — a quoted reserved word forces every future query to quote it too |
| 3 | Created `.env` with generated `JWT_SECRET`, `ENCRYPTION_KEY`, `WHATSAPP_VERIFY_TOKEN` | Gitignored |

**Verified live:** 12 tables · both `halfvec` HNSW indexes created · 31 statutes ·
`search_precedents()`, `verify_citations()`, `verify_statute_refs()`,
`search_statutes()` all execute · 111/111 tests pass.

> ✅ **The pgvector `halfvec` gamble paid off.** The 3072-dimension HNSW indexes
> built without error on Supabase's pgvector, confirming the cast-expression
> approach documented above actually works in production.

### 2026-08-07 — Admin panel, runtime settings, precedent feature

| # | Change | Files | Why |
|---|---|---|---|
| 1 | **Runtime settings store** | `settings/` (3 new), migration 0007 | WhatsApp credentials were frozen at boot; a Settings page that swaps the number was impossible without it |
| 2 | `SignatureService` takes secrets as **arguments** | `security/signature.service.ts` | A secret captured in the constructor keeps verifying against old credentials after a swap. Also makes it a pure function — tests need no DI |
| 3 | WhatsApp services read through settings | `whatsapp-api.service.ts`, `webhook.controller.ts` | So a credential change takes effect on the very next message |
| 4 | eCourts mode/URL/key read through settings | `ecourts/ecourts.service.ts` | Toggle mock↔http from the panel |
| 5 | **Admin panel UI** | `admin/admin-ui.html.ts`, `admin-ui.controller.ts` | Requested. Vanilla JS + inline SVG, no framework, no CDN |
| 6 | Admin API expanded | `admin.controller.ts`, `admin.repository.ts` | Dashboard, tables, settings CRUD, connection test |
| 7 | **`search_precedents()`** | migration 0008 | Feature 3 needed judgment-level, date-ordered results; passage search gave neither |
| 8 | Precedent service + paging | `ai/precedents.service.ts`, `conversation.service.ts` | 15 per session, 5 per message, `more` to continue |
| 9 | 20 formatting tests | `precedents.format.spec.ts` | Paging boundaries and truncation are exactly where this breaks |
| 10 | `PRECEDENT_*` env keys | `config/env.ts`, `.env.example` | Tunable caps |

**Verification:** `tsc --noEmit` clean · `jest` 111/111 pass · `nest build` succeeds.

<details>
<summary><strong>2026-08-04 — Initial build</strong> (click to expand)</summary>

- NestJS monorepo scaffold, web + worker split, Dockerfile, Railway config
- Migrations 0001–0006: extensions, core tables, corpus, search functions, RLS + retention, seed statutes
- Config with Zod validation, postgres.js pool, Redis + BullMQ, distributed locks
- WhatsApp: HMAC-verified webhook, Cloud API client, message builders, conversation state machine
- AI: provider registry (Anthropic/OpenAI/Google/mock), embeddings, intent classifier, hybrid RAG, citation guardrails
- Domain: users + bar-council verification, statutes, eCourts adapter, quotas
- Ingestion CLI, 91 tests, README

</details>

---

## 🧭 Architecture decisions (and what they cost)

| Decision | Instead of | Why | Trade-off |
|---|---|---|---|
| Supabase pgvector | Qdrant + Elasticsearch | Zero extra infra; RRF fusion in SQL | Won't match a tuned Qdrant cluster at 10M+ vectors |
| `postgres.js` + raw SQL | Prisma (per spec) | pgvector/tsvector/RRF are raw SQL anyway; Prisma 7 adds client-gen friction on Railway | No generated types — repositories are hand-typed |
| No cross-encoder re-ranker | BGE-reranker (per spec) | RRF over 50+50 candidates gets most of the quality at none of the latency | Measurably worse ordering on subtle queries |
| Query-side synonym expansion | Elasticsearch thesaurus | Postgres thesaurus dictionaries need filesystem access Supabase doesn't give you | Synonym list lives in code, not config |
| Admin panel inside web service | Separate Next.js app | One deploy, no CORS, no third-party JS in front of PII | Not a rich SPA; fine for tables and forms |
| Precedent list built without an LLM | Generated summaries | Citations are real by construction; works with zero AI keys | Synopses are extractive, not abstractive |
| Shared bearer token for admin | Per-user JWT + RBAC | No admin UI existed to issue sessions for | Single shared credential; roles exist in schema, unused |
| `halfvec` cast index | 1536-dim embeddings | Keeps 3072-dim quality within HNSW's limit | Query expression must match the index exactly |

---

## ⚫ Deliberately not built

| Thing | Why | To add later |
|---|---|---|
| **Billing / credit wallet** | You said skip it | Add `wallet_ledger` beside `daily_usage`; don't overload it |
| **Razorpay** | Follows billing | Adapter shape already sketched in spec §15 |
| **Next.js portals** | Admin panel covers governance | User dashboard is the real remaining gap |
| **eCourts scraper** | CAPTCHA-guarded, breaks constantly, legally exposed | Subscribe to a provider instead |
| **CAPTCHA solving** | Spec suggested it; declined on legal-risk grounds | — |
| **Voice notes** | Needs OpenAI Whisper key | `transcription.service.ts` is written and wired |
| **Multi-number routing** | One WABA per deployment | `phone_number_id` already flows through the job payload |

---

## ⚠️ Known risks

| Risk | Impact | Mitigation now | Still open |
|---|---|---|---|
| Meta token expiry | Bot dies silently | Permanent System User token documented | No expiry alert |
| 24-hour messaging window | Proactive messages fail | Explained in panel + this doc | No template management UI |
| Corpus gaps read as "no authority" | Advocate misled | Every reply carries a not-exhaustive caveat | Only fixable with more data |
| Model hallucinates a citation | Wrong law cited | Citations verified against DB, stripped if absent | Prose reasoning still unverified |
| `ENCRYPTION_KEY` loss | Secrets + bar IDs unreadable | Documented as non-rotatable | No key-rotation tooling |
| Embeddings missing on chunks | Invisible to semantic search | Panel shows **% embedded** per court | No auto-backfill job |
| Quota is per-phone | Multiple numbers = multiple quotas | Accepted | Real fix is bar-council-level identity |

---

## 🔧 Runbook

```bash
# Local dev (Postgres on 5433, Redis on 6380 — non-default so nothing collides)
docker compose up -d
cp .env.example .env
npm install
npm run db:migrate
npm run dev            # web  → http://localhost:3000
npm run dev:worker     # worker, separate terminal

# Quality gates
npx tsc --noEmit       # types
npm test               # 111 tests
npm run build          # production build

# Data
npm run seed:statutes
npm run ingest -- --file data/samples/judgments.sample.jsonl

# Health
curl localhost:3000/health/ready
```

**Admin API without the UI:**

```bash
curl -H "Authorization: Bearer $JWT_SECRET" localhost:3000/admin/dashboard
curl -X POST -H "Authorization: Bearer $JWT_SECRET" localhost:3000/admin/settings/whatsapp/test
```

---

## ➡️ Next actions, in order

1. ~~Create the Supabase project + run migrations~~ ✅ **Done 2026-08-07**
2. 🔴 **Send the government API documentation** — blocks all three features and
   decides whether corpus ingestion happens at all. Don't ingest anything until
   this is settled, or you may load data the API already serves.
3. **Deploy to Railway** (web + worker + Redis) for a public HTTPS URL
4. **Connect WhatsApp** — [walkthrough above](#-connecting-whatsapp-step-by-step); verify with **Test connection**
5. **Add one LLM key** in the panel, flip synthesis off `mock`
6. **Rotate the Supabase database password** — it was pasted into a chat transcript
7. Embedding key + corpus ingestion — **only if** the API turns out not to cover semantic precedent search
