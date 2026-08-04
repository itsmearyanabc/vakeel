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
| Tests (`npm test`) | ✅ 90 passing |
| Both entrypoints boot from compiled output | ✅ `node dist/main.js` resolves every module and reaches config validation |
| Migrations executed against a live Postgres | ⚠️ **not yet — see below** |
| End-to-end run against real Supabase/Redis/Meta | ⚠️ not yet |

**The SQL migrations have not been executed.** Docker would not start on the
development machine, so there was no Postgres to apply them to. They are
written carefully — including the `halfvec` workaround that 3072-dimension
HNSW indexes require — but treat the first `npm run db:migrate` as the real
test. It is the first thing to do, and it takes about a minute:

```bash
npm run db:migrate
```

If anything fails there, it will fail loudly with the offending statement.

---

## How it works

```
WhatsApp user
      │  message
      ▼
Meta Cloud API ──webhook──► web service (NestJS + Fastify)
                              │  1. verify HMAC signature
                              │  2. drop duplicate deliveries
                              │  3. enqueue
                              │  4. return 200  (< 200ms)
                              ▼
                         Redis (BullMQ)
                              │
                              ▼
                        worker service
                              │
      ┌───────────────────────┼───────────────────────┐
      ▼                       ▼                       ▼
 intent router          hybrid retrieval          eCourts adapter
 (cheap model)                │                   (CNR lookup)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     pgvector dense search          tsvector lexical search
              └───────────────┬───────────────┘
                              ▼
                    RRF fusion (in SQL)
                              ▼
                  prompt + anti-hallucination rules
                              ▼
                     synthesis model
                              ▼
              ╔═══════════════════════════════╗
              ║  CITATION GUARDRAIL           ║
              ║  every citation and section   ║
              ║  checked against the corpus   ║
              ╚═══════════════════════════════╝
                              ▼
                        WhatsApp reply
```

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
these endpoints do the job. Auth is a bearer token equal to `JWT_SECRET`.

```bash
curl -H "Authorization: Bearer $JWT_SECRET" https://<domain>/admin/verifications
curl -X POST -H "Authorization: Bearer $JWT_SECRET" \
     https://<domain>/admin/verifications/<userId>/approve
curl -H "Authorization: Bearer $JWT_SECRET" https://<domain>/admin/stats
```

Approving sends the advocate a WhatsApp message and lifts their daily quota.

Alternatively, put your own number in `ADMIN_PHONE_NUMBERS` to get
`SUPER_ADMIN` automatically.

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
| Razorpay credit wallet | Role-based daily quotas | You asked to skip billing. Quotas cap LLM spend in the meantime. When you add Razorpay, add a `wallet_ledger` table *alongside* `daily_usage` — quotas stop abuse, credits price usage, and they answer different questions. |
| eCourts scraper + CAPTCHA solving | Adapter with `mock` / `http` modes | eCourts has no free public API and the portal is CAPTCHA-protected. Defeating a government portal's bot protection is a legal exposure the product does not need. Subscribe to a provider and map its fields in `mapProviderResponse()`. |
| Next.js portals | Not built | Out of scope for this pass, by your choice. |

---

## Not built yet

- **Next.js user dashboard and admin governance portal** — the backend APIs and
  the `user_role` enum are in place for them.
- **Razorpay billing** — see the deviations table for where it should slot in.
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

90 tests, no database or network required. They concentrate on the parts where
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
