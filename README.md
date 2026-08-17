# Vakeel Saathi (वकील साथी)

AI legal research and case intelligence for Indian advocates, delivered over
WhatsApp.

Ask a question in English, Hindi or Hinglish and get back cited precedents,
statutory explanations with IPC↔BNS mappings, or case status by CNR — with
every citation verified against the database before it is sent.

Built from `Vakeel_Saathi_Enterprise_Architecture.pdf`, adapted to
**Supabase + Railway** (see [Deviations from the spec](#deviations-from-the-spec)).

---

## Status

| Area | State |
|---|---|
| Type check (`tsc --noEmit`) | ✅ clean |
| Build (`npm run build`) | ✅ emits `dist/main.js`, `dist/worker.js` |
| Tests (`npm test`) | ✅ 403 passing |
| Migrations applied to live Supabase | ✅ through `0011` |
| Web app verified end to end | ✅ signup, sign-in, session cookie, live answer, credits charged and refunded |
| WhatsApp bot | ✅ running on the Meta test number |
| Google sign-in | ⚠️ built, unconfigured — set `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` |
| Transactional email | ⚠️ built, unconfigured — `EMAIL_PROVIDER=log` writes links to the log |
| Razorpay payments | ❌ schema and admin reporting only, no gateway calls |
| Judgment corpus | ⚠️ empty — case-law search returns nothing until you ingest or set `KANOON_API_KEY` |

Anything marked ⚠️ is **off, and says so in the interface**. An unconfigured
Google button does not render, password reset refuses with an explanation rather
than pretending to send mail, mock LLM answers are labelled as placeholders, and
a case-law search with no corpus refunds the credits and explains why. Nothing
in the product claims to have done something it did not.

---

## How it works

Two front doors onto one pipeline. They differ in *how the work is scheduled*,
not in what it does.

```
 WhatsApp user                              Browser  (/app)
      │  message                                 │  POST /api/chat/ask
      ▼                                          │
 Meta Cloud API                                  │
      │  webhook                                 │
      ▼                                          ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  web service  (NestJS + Fastify)                            │
 │                                                             │
 │  webhook: verify HMAC ─► drop duplicates ─► enqueue ─► 200  │
 │           (must ack in < 200ms or Meta throttles us)        │
 │                                                             │
 │  /api/chat/ask: answer on this connection, stream progress  │
 └─────────────────────────────────────────────────────────────┘
           │ enqueue                             │ direct
           ▼                                     │
    Redis (BullMQ)                               │
           │                                     │
           ▼                                     │
    worker service                               │
           │                                     │
           └──────────────┬──────────────────────┘
                          ▼
      ┌───────────────────┼───────────────────┐
      ▼                   ▼                   ▼
 intent router     hybrid retrieval     eCourts adapter
 (cheap model)            │             (CNR lookup, free)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   pgvector dense search      tsvector lexical search
            └─────────────┬─────────────┘
                          ▼
                RRF fusion (in SQL)
                          ▼
            prompt + anti-hallucination rules
                          ▼
                  synthesis model
                          ▼
            ╔═════════════════════════════╗
            ║  CITATION GUARDRAIL         ║
            ║  every citation and section ║
            ║  checked against the corpus ║
            ╚═════════════════════════════╝
                          ▼
          ┌───────────────┴───────────────┐
          ▼                               ▼
    WhatsApp reply                 SSE: answer + cards
```

**Why the queue on one side and not the other.** Meta expects a webhook
acknowledged in well under a second and throttles — then disables — subscriptions
that are slow, so all slow work has to happen after the 200. A browser waiting on
its own fetch has no such deadline, and the advocate is watching, so the answer is
produced on the open connection and progress is streamed back. A queue there would
add a polling loop to solve a problem that does not exist.

### The guardrail is the point

An advocate who repeats a fabricated citation in court has a professional
problem. Prompt instructions reduce how often a model invents one; they do not
prevent it. So every generated answer is parsed for case citations and section
numbers, and each is checked against the database:

- **Not in the corpus at all** → struck from the answer, replaced with
  `[unverified]`, and the user is told something was removed.
- **Real, but not among the passages retrieved for this query** → kept (it is a
  genuine case) but flagged in `search_history` for auditor review.

This is why the sample corpus in `data/samples/` is aggressively fake — see
that folder's README.

---

## Prerequisites

| | |
|---|---|
| Node | 22+ |
| Supabase | a project (free tier is fine to start) |
| Railway | an account |
| Meta | a Business account with WhatsApp Cloud API access |
| LLM provider | optional — runs in mock mode without one |

---

## 1. Supabase

**Create the project**, then from **Project Settings → Database → Connection
string** collect two URLs:

- **Transaction pooler**, port `6543` → `DATABASE_URL` (what the app uses)
- **Direct connection**, port `5432` → `DIRECT_URL` (what migrations use)

The pooler matters: Railway containers are ephemeral and scale horizontally, and
connecting every replica straight to Postgres exhausts the connection limit
fast. The pooler runs in transaction mode, which is why the app disables
prepared statements — see the comment in `src/database/database.service.ts`.

**Apply the schema:**

```bash
cp .env.example .env      # fill in DATABASE_URL and DIRECT_URL
npm install
npm run db:migrate
```

Or paste `supabase/migrations/*.sql` into the Supabase SQL Editor in filename
order — they are plain SQL with no tooling dependency.

Check it worked:

```bash
npm run db:migrate -- --status
```

### About the 3072-dimension vector columns

pgvector stores up to 16000 dimensions but its **HNSW index caps at 2000**. A
plain `USING hnsw (embedding vector_cosine_ops)` on a 3072-dim column fails
with `column cannot have more than 2000 dimensions for hnsw index`.

The migrations index a `halfvec` cast expression instead (16-bit floats, 4000-dim
index limit, negligible recall loss at this width). The consequence you must
remember: **queries have to use the identical expression** —

```sql
ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072)
```

Write `embedding <=> $1` and Postgres silently ignores the index and
sequentially scans. The functions in `0004_search_functions.sql` are correct; if
you hand-write a vector query, mirror them and confirm with `EXPLAIN`.

---

## 2. WhatsApp (Meta Cloud API)

This is the fiddliest part. Order matters.

**a. Create the app** — [developers.facebook.com](https://developers.facebook.com)
→ My Apps → Create App → **Business** → add the **WhatsApp** product.

**b. Collect credentials:**

| Variable | Where |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup (the numeric ID, *not* the phone number) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | same page |
| `WHATSAPP_APP_SECRET` | App Settings → Basic → App Secret |
| `WHATSAPP_ACCESS_TOKEN` | see below |
| `WHATSAPP_VERIFY_TOKEN` | you invent this — any long random string |

**c. Get a permanent access token.** The token on the API Setup page expires in
24 hours. For anything real: Business Settings → Users → **System Users** →
create one → Add Assets (your WhatsApp app) → Generate token with
`whatsapp_business_messaging` and `whatsapp_business_management`. Choose
**Never** for expiry.

**d. Deploy first** (section 3) so you have an HTTPS URL — Meta will not accept
a webhook it cannot reach.

**e. Register the webhook.** WhatsApp → Configuration → Edit:

- Callback URL: `https://<your-railway-domain>/webhooks/whatsapp`
- Verify token: your `WHATSAPP_VERIFY_TOKEN`

Click **Verify and save**. Meta sends a `GET` with a challenge; the app echoes
it back. If this fails, `WHATSAPP_VERIFY_TOKEN` does not match, or the service
is not reachable.

**f. Subscribe to the `messages` field.** Easy to miss, and without it the
webhook verifies successfully and then never receives anything.

**g. Test.** Message your test number from the WhatsApp account you added as a
recipient.

> Until your number is approved for production, Meta only delivers to phone
> numbers explicitly added as recipients in the API Setup page.

---

## 3. Railway

Two services from **this one repository**, plus Redis.

**a. Redis** — New → Database → Redis.

**b. Web service** — New → GitHub Repo → this repo.

- Variables → add everything from `.env.example`
- `REDIS_URL` = `${{Redis.REDIS_URL}}` (Railway substitutes the private URL)
- Settings → Config-as-code → `railway.web.json`
- Settings → Networking → Generate Domain, then set `APP_PUBLIC_URL` to it

**c. Worker service** — New → GitHub Repo → **the same repo again**.

- Same variables (use a Railway shared variable group so there is one copy)
- Settings → Config-as-code → `railway.worker.json`
- **No public domain** — it serves no HTTP

Both build from the same `Dockerfile`; the start command differs
(`dist/main.js` vs `dist/worker.js`).

**Why two services rather than one process doing both:** they scale on
different signals. Web scales on inbound webhook volume, worker on queue depth.
Combined, every webhook replica also competes for jobs, and a web restart
mid-deploy interrupts message processing.

Verify:

```bash
curl https://<your-domain>/health/ready
curl https://<your-domain>/health/queue
```

---

## 4. Local development

```bash
docker compose up -d          # Postgres 5433, Redis 6380 — non-default ports
cp .env.example .env
```

Point `.env` at the local containers:

```
DATABASE_URL=postgresql://vakeel:vakeel@localhost:5433/vakeel_saathi
DIRECT_URL=postgresql://vakeel:vakeel@localhost:5433/vakeel_saathi
DATABASE_SSL=disable
REDIS_URL=redis://localhost:6380
```

Then:

```bash
npm run db:migrate
npm run ingest -- --file data/samples/judgments.sample.jsonl
npm run dev          # terminal 1 — web
npm run dev:worker   # terminal 2 — worker
```

Ports are deliberately off the defaults so this project cannot collide with
another Postgres or Redis you already run.

**Without any API keys**, everything works: `mock` providers give deterministic
answers, `ECOURTS_MODE=mock` gives deterministic case data, and outbound
WhatsApp messages are logged instead of sent. Every mocked reply says so in the
message body.

To exercise the webhook without Meta, expose it with
[ngrok](https://ngrok.com) (`ngrok http 3000`) and register the ngrok URL.

---

## 5. Corpus

The bot is only as good as what it can retrieve. The migrations seed ~28 statute
sections (IPC, BNS, CrPC, BNSS, Evidence Act) with IPC↔BNS mappings, which makes
section lookup work immediately. Case law you must supply.

```bash
npm run ingest -- --file data/samples/judgments.sample.jsonl   # fictional samples
npm run ingest -- --file data/judgments.jsonl                  # your corpus
npm run ingest -- --statutes                                   # embed the seeded statutes
npm run ingest -- --stats                                      # counts
```

Format and sourcing notes: `data/samples/README.md`.

Re-running is safe — judgments are keyed by a hash of their full text, so
unchanged documents are skipped.

> **Bulk loading:** build the HNSW index *after* ingesting a large corpus. On an
> empty table then 10M inserts it is dramatically slower than the reverse.

---

## 6. LLM providers

Nothing is required. Set a key and flip the corresponding provider:

```
LLM_SYNTHESIS_PROVIDER=anthropic   # legal analysis
LLM_ROUTER_PROVIDER=anthropic      # intent classification (high volume, cheap)
EMBEDDING_PROVIDER=openai          # dense vectors
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

**Anthropic has no embeddings endpoint** — use OpenAI or Google for
`EMBEDDING_PROVIDER`. Selecting `anthropic` there logs a warning and falls back
to mock.

Defaults are `claude-opus-5` for synthesis and `claude-haiku-4-5` for routing.
Note `src/ai/providers/anthropic.provider.ts` detects model capability: Haiku 4.5
rejects `thinking: adaptive` and `output_config.effort` (those are 4.6+), so they
are only sent to models that accept them.

A provider selected without its key falls back to mock with a warning rather
than crashing — a misconfigured key should not take the webhook offline and get
your number throttled.

**Latency note.** The spec targets <2.5s p95. `claude-opus-5` at high effort
with adaptive thinking will not hit that. `ANTHROPIC_SYNTHESIS_EFFORT` is the
dial; `medium` is a reasonable starting point and `low` is noticeably faster.
Measure on your own queries before tuning.

---

## 7. Admin API

Bar council verification needs something to approve it. Until the portal exists,
these endpoints do the job. Auth is a bearer token equal to `ADMIN_SERVICE_TOKEN`.

```bash
curl -H "Authorization: Bearer $ADMIN_SERVICE_TOKEN" https://<domain>/admin/verifications
curl -X POST -H "Authorization: Bearer $ADMIN_SERVICE_TOKEN" \
     https://<domain>/admin/verifications/<userId>/approve
curl -H "Authorization: Bearer $ADMIN_SERVICE_TOKEN" https://<domain>/admin/stats
```

> **This used to be `JWT_SECRET`, and still is on a deployment that has not set
> `ADMIN_EMAIL`/`ADMIN_PASSWORD` yet.** Once those are set, `JWT_SECRET` is no
> longer accepted as a bearer token — it signs admin sessions, so anything
> holding it can mint a SUPER_ADMIN session with any expiry, and revoking a
> leaked copy would mean rotating the signing key and logging every admin out.
> Set `ADMIN_SERVICE_TOKEN` (≥ 24 chars) to keep scripted access working, or
> leave it blank for browser sessions only.

Approving sends the advocate a WhatsApp message and lifts their daily quota.

Alternatively, put your own number in `ADMIN_PHONE_NUMBERS` to get
`SUPER_ADMIN` automatically.

---

## 8. The web app

Served at `/app` by the same web process. No build step, no CDN, no framework —
see the deviations table.

### What an advocate can do

| | |
|---|---|
| Sign up | Email and password, or Google if it is configured |
| Ask | Section lookups, case-law search, case status by CNR — the same pipeline the WhatsApp bot uses |
| See | Threads in a sidebar, precedents as cards, court records as a table, sources behind every answer |
| Credits | Live balance, full history, and what each action cost |
| Link WhatsApp | One account across both channels, sharing credits and history |
| Account | Password change, signed-in devices with individual revoke |

### Credits, in one paragraph

Two buckets. **Free** credits are the daily allowance (`QUOTA_GUEST_DAILY`),
reset each day and never accumulated. **Durable** credits — purchased, granted
or the signup bonus — never expire. A spend draws down free first, so a purchase
is never burned while an allowance expires beside it. Every movement is a row in
`credit_ledger` with an idempotency key the database enforces, so a redelivered
webhook or a double-clicked button collides on an index instead of charging
twice. Refunds reverse the original entries rather than crediting a flat amount,
because a spend can straddle both buckets and both ways of guessing cost someone
real money.

Case status is free. Section lookups and case-law searches cost 2. A search that
returns no authorities is refunded automatically.

### Linking a WhatsApp number

The code travels *outward*: the advocate is shown a six-digit code in the browser
and sends it to the bot from their handset.

Texting them a code instead would fail for most people who need it — WhatsApp
refuses free-form messages outside a 24-hour window — and proves less. A received
code shows someone can read messages sent to a number; a sent code shows they can
send *from* it, which is what "this is my WhatsApp account" means.

When the number already has an account, the two merge: the WhatsApp account
survives and absorbs the web one, with threads, ledger and orders re-pointed
before the delete so a cascade cannot take an advocate's research history with
it.

### Sessions

Opaque random tokens in `web_sessions`, stored only as SHA-256, delivered in an
HttpOnly `SameSite=Lax` cookie. Not JWTs — the deciding property is revocation.
A stolen JWT is valid until it expires and nothing can stop it; here "sign out
everywhere" is a `DELETE`.

`Secure` is derived from `APP_PUBLIC_URL` rather than configured, because the two
cannot usefully disagree: `Secure` on a plain-http origin makes the browser
silently discard the cookie, so sign-in appears to succeed and the next request
is anonymous, with nothing in any log to explain it.

### Why answers do not stream token by token

The citation guardrail runs on the **complete** answer and strips citations that
are not in the corpus. Streaming raw model output would put unverified citations
on screen and then remove them — showing an advocate a case that does not exist,
however briefly, is the exact failure this system is built to prevent.

What does stream is progress, and it is real: `RagService` reports each stage as
it begins (`retrieving` → `generating` → `verifying`) and those events go straight
out over SSE. They are not a timer.

---

### Deploying on Render's free tier

The free tier shapes three real behaviours. None is a bug, and all three are
easier to live with once you know which is which.

**1. One service, not two.** Render's free tier has no background-worker type,
so the blueprint's web + worker split is not available. The deployed shape is a
single web service running `npm run start:all`, which supervises both processes
in one container. The consequence: when the container sleeps, the BullMQ
consumer sleeps with it. Inbound webhooks are still accepted and queued — the
web half wakes to serve them — but queued jobs are not drained until something
wakes the container, so a WhatsApp reply can arrive minutes late or on the next
message. A paid always-on plan is the fix; nothing in the code can work around
a sleeping process.

**2. Cold starts.** A container waking from spin-down takes roughly 30–60
seconds on the first request. Two visible effects:

- The web app's first load, and its first question, simply take that long. The
  interface shows its spinner and waits; nothing times out.
- Meta expects a fast webhook acknowledgement and throttles subscriptions that
  are slow. A cold start counts against that. This is the strongest single
  argument for the cheapest paid plan once real advocates are using the bot.

**3. Memory.** 512 MB, shared by both processes. Password hashing is the one
thing here with a deliberate memory appetite: scrypt at `N=2^15, r=8` uses
32 MiB per hash *while it runs*, which is what makes a stolen database
expensive to attack. Two node processes plus a couple of concurrent sign-ins
sits comfortably inside 512 MB, and the sign-in rate limiter (20 per IP, 10 per
account, per 15 minutes) is what stops a flood turning that into an OOM. If you
ever do see the container restarting under load during sign-ins, lower the cost
in `src/auth/password.ts` — every hash records the parameters it was made with,
so changing them is safe and old passwords keep verifying.

**Supabase free tier** pauses a project after 7 days with no activity. The
service will come back with connection errors that look alarming and are not;
unpause it from the Supabase dashboard. Note also that the connection string on
port 6543 is the transaction pooler — the app detects that and disables prepared
statements automatically, but `npm run db:migrate` needs the direct connection on
port 5432, so set `DIRECT_URL` before running migrations.

---

## Deviations from the spec

Each of these is a deliberate call, not an omission.

| Spec | Built | Why |
|---|---|---|
| AWS EKS + Terraform + Helm + ArgoCD | Railway, two services, one Dockerfile | You chose Railway. Kubernetes for a service with no traffic yet is cost and operational burden with no benefit. |
| Aurora PostgreSQL | Supabase Postgres | You chose Supabase. |
| Qdrant (vector) | Supabase pgvector | One less service, one less bill, no network hop mid-query. The retriever is behind an interface — swapping Qdrant in later is one class. |
| Elasticsearch (lexical) | Postgres `tsvector` + GIN | Same reasoning. ES is memory-hungry and expensive to run before you have traffic to justify it. |
| ES synonym filter | Query-side expansion in TypeScript | Postgres' equivalent is a thesaurus dictionary, which needs a file on the DB server's filesystem — impossible on managed Supabase. Same recall benefit, no infrastructure. |
| Cross-encoder re-ranker (BGE) | RRF fusion only | RRF over a 50+50 candidate pool gets a large fraction of the quality at none of the latency or GPU cost. The obvious next upgrade once there is traffic to measure against. |
| Prisma ORM | postgres.js + raw SQL | Every interesting query here is pgvector/tsvector/RRF, which would be `$queryRaw` anyway. Prisma has no native `vector` type, so the columns would be `Unsupported(...)` and unreadable by the client regardless. Drops a generate step from the Docker build too. |
| Razorpay credit wallet | Two-bucket credit ledger; no gateway | The ledger is built and authoritative. Payments are not: no Razorpay call is made anywhere. The schema commits to what is expensive to change later — integer paise, unique receipts, deduplicated webhooks, tax split out for GST — so wiring the gateway is an integration rather than a migration. |
| eCourts scraper + CAPTCHA solving | Adapter with `mock` / `http` modes | eCourts has no free public API and the portal is CAPTCHA-protected. Defeating a government portal's bot protection is a legal exposure the product does not need. Subscribe to a provider and map its fields in `mapProviderResponse()`. |
| Next.js portals | Vanilla HTML/CSS/JS, served by Nest | The web app ships inside the existing service. A React build means a stage in the Dockerfile, a second thing that fails on deploy, and a CDN in front of an interface holding advocates' sessions and legal research. It is one screen with a list beside it; a framework would not make it shorter. |

---

## Not built yet

- **Razorpay payments.** The ledger, the order table, the webhook dedupe table
  and the admin reporting all exist; nothing calls Razorpay. What remains is
  order creation, checkout, and a signature-verified webhook that calls
  `credit_grant()` with the payment id as its idempotency key. The
  "paid but not credited" report in the admin panel is already there, because
  that is the failure nobody sees until it has happened.
- **A marketing site.** `/` serves the app; there is no public landing page.
- **ID card upload to Supabase Storage.** The bot accepts the image and queues
  the verification, but does not persist the file. Storing identity documents
  before there is a review UI to look at them is the wrong order — the DPDP Act
  cuts against holding PII nobody uses. `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` are already wired for when the portal lands.
- **Cross-encoder re-ranking.**
- **Prometheus / Grafana / Loki.** Logs are structured JSON to stdout, which
  Railway captures; `/health/*` exposes readiness and queue depth.

---

## Testing

```bash
npm test
npm run test:cov
```

403 tests, no database or network required. They concentrate on the parts where
a silent bug is expensive: the citation guardrail, webhook signature
verification, PII encryption, WhatsApp field limits, and the legal-text
patterns.

They earned their keep — writing them surfaced four real bugs, including a
section-number regex that parsed `"section 302 IPC"` as section `302I`, and
overlapping citation patterns that extracted `"2018 SC 1234"` alongside
`"AIR 2018 SC 1234"`, then "removed" the fragment and corrupted a valid
citation on the way out.

---

## Layout

```
src/
├── main.ts                 web entrypoint (Fastify, raw-body parser for HMAC)
├── auth/                   end-user accounts: scrypt, sessions, Google, phone linking
├── credits/                the two-bucket credit wallet over credit_ledger
├── web/                    the advocate-facing app — API, SSE chat, inlined assets
├── worker.ts               worker entrypoint (no HTTP server)
├── app.module.ts           AppModule (web) and WorkerModule (worker)
├── config/                 zod-validated environment, fails fast at boot
├── common/                 logger, response envelope, error filter, circuit breaker
├── database/               postgres.js pool + repositories
├── redis/                  connection, distributed lock, atomic quota, BullMQ
├── security/               AES-256-GCM, blind index, webhook HMAC
├── ai/                     providers, embeddings, intent, RAG, guardrails, prompts
├── whatsapp/               webhook, Meta client, message builders, state machine
├── ecourts/                CNR adapter with circuit breaker
├── users/  quota/  admin/  jobs/
supabase/migrations/        the schema — plain SQL, paste-able
scripts/                    migrate, ingest
data/samples/               fictional corpus for pipeline testing
```

---

## Security notes

- Webhook HMAC is verified over **raw request bytes**. `JSON.stringify(body)`
  re-serialises with different whitespace and key order and never matches — see
  the content-type parser in `main.ts`.
- Bar council numbers are stored as AES-256-GCM ciphertext plus an HMAC blind
  index. Uniqueness and lookup run against the HMAC, so a duplicate
  registration is detected without ever decrypting.
- RLS is enabled on every table. The backend connects as the owner and bypasses
  it; the point is that Supabase also exposes these tables over PostgREST using
  the anon key, which ships in browser code. Only the bare acts are readable.
- Phone numbers are masked in logs; tokens and secrets are redacted by pino.
- `purge_expired_data()` runs nightly in the worker (DPDP Act 2023).
  `delete_user_data(phone)` handles erasure requests.

---

## Licence

UNLICENSED — private project.
