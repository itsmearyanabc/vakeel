# Cloudflare — vakeelsaathi.in

Free tier throughout. Most of the work here is stopping Cloudflare from breaking
things it does not understand, so the order below matters: DNS and TLS first,
then the rules that keep the webhooks and the chat stream working.

---

## 1. Move the domain to Cloudflare

The domain is registered at Hostinger; only the **nameservers** change, not the
registration.

1. Cloudflare → Add a site → `vakeelsaathi.in` → Free plan.
2. Cloudflare gives two nameservers, e.g. `xxx.ns.cloudflare.com`.
3. Hostinger → Domains → `vakeelsaathi.in` → DNS / Nameservers → **Change
   nameservers** → paste both.

Propagation is usually under an hour. Until it completes, everything below is
inert — Cloudflare is not in the path yet.

## 2. DNS records

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `vakeelsaathi.in` | *your VPS IPv4* | **Proxied** (orange cloud) |
| A | `www` | *your VPS IPv4* | **Proxied** |

Proxied is what puts Cloudflare in front. A grey cloud exposes the origin IP and
skips every protection below.

## 3. TLS

**SSL/TLS → Overview → Full (strict).**

Not Flexible. Flexible encrypts browser→Cloudflare and leaves
Cloudflare→origin in plain text, while the padlock tells the advocate the whole
path is secure. On a service carrying legal research and session cookies that is
the wrong lie to tell.

Full (strict) requires a certificate on the origin. Use a **Cloudflare Origin
Certificate** — free, valid 15 years, and trusted by Cloudflare specifically,
which is the only thing that should ever connect to the origin.

**SSL/TLS → Origin Server → Create Certificate.** Accept the defaults, then on
the VPS:

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/vakeelsaathi.in.pem   # paste the certificate
sudo nano /etc/ssl/cloudflare/vakeelsaathi.in.key   # paste the private key
sudo chmod 600 /etc/ssl/cloudflare/vakeelsaathi.in.key
```

Then reload nginx or Caddy — see `deploy/nginx-vakeelsaathi.conf` or
`deploy/Caddyfile`.

Also enable **Always Use HTTPS** and set **Minimum TLS Version 1.2**.

---

## 4. Do not break the webhooks

> This is the single most common way a WhatsApp integration dies behind
> Cloudflare. Bot Fight Mode classifies Meta's servers as bots and blocks the
> webhook. Deliveries start failing, Meta throttles and then **disables** the
> subscription, and nothing appears in the application logs — because the
> requests never arrive.

**Security → WAF → Custom rules → Create rule:**

- Name: `Allow webhooks`
- Expression: `(starts_with(http.request.uri.path, "/webhooks/"))`
- Action: **Skip** → tick *All remaining custom rules*, *Rate limiting*,
  *Managed rules*, *Bot Fight Mode*, *Security Level*
- Place it **first** in the rule order.

After every Cloudflare change, re-test from Meta: **WhatsApp → Configuration →
Webhook → Verify and save**. Not once — every time.

## 5. Let the chat stream through

The chat uses server-sent events. Two things must be true or an answer hangs
mid-flight.

**Rules → Cache Rules → Create rule:**

- Name: `Bypass cache for API`
- Expression:
  `(starts_with(http.request.uri.path, "/api/")) or (starts_with(http.request.uri.path, "/admin")) or (starts_with(http.request.uri.path, "/webhooks/"))`
- Action: **Bypass cache**

**Speed → Optimization:** turn **off** Rocket Loader, Auto Minify and Email
Obfuscation. Each rewrites responses, and a rewriter buffers — which is exactly
what turns a live stream into one delivery at the end.

The application already sends `Cache-Control: no-transform` and a heartbeat
comment every 15 seconds, which is the other half of keeping the stream alive
through the proxy.

## 6. Rate limiting

The free plan allows **one** rate-limiting rule. Spend it where a stranger can
guess at something.

**Security → WAF → Rate limiting rules:**

- Expression: `(starts_with(http.request.uri.path, "/api/auth/"))`
- Rate: 20 requests per 10 seconds, per IP
- Action: Managed Challenge, 10 seconds

The application already limits sign-ins per IP and per account. This is the
outer layer that stops the traffic before it costs any CPU — which matters more
than usual, because password hashing is deliberately expensive.

## 7. The admin panel

`/admin` is a login form on a public domain. Either:

- **Security → WAF → Custom rules:** challenge `/admin` from outside India —
  `(starts_with(http.request.uri.path, "/admin")) and (ip.geoip.country ne "IN")`
  → Managed Challenge; or
- Cloudflare Access (free for up to 50 users) in front of `/admin*`, which is
  stronger and adds a second identity check.

---

## Verify

```bash
# Cloudflare is in front (expect a cf-ray header)
curl -sI https://vakeelsaathi.in | grep -i 'cf-ray\|server'

# The origin is reachable and healthy
curl -s https://vakeelsaathi.in/health/ready

# The webhook path is not challenged (expect 403 from the app, not a Cloudflare
# HTML challenge page — a 403 here means the app rejected an unsigned request,
# which is correct)
curl -sI https://vakeelsaathi.in/webhooks/whatsapp | head -1
```

Then point Meta at `https://vakeelsaathi.in/webhooks/whatsapp` with your
`WHATSAPP_VERIFY_TOKEN`, and set `APP_PUBLIC_URL=https://vakeelsaathi.in` in
`.env` before the final deploy.

> **Once `APP_PUBLIC_URL` is https, signing in over `http://<ip>:3001` stops
> working.** Session cookies are marked `Secure`, which browsers discard on a
> plain-http origin — sign-in appears to succeed and the next request is
> anonymous. Test through the domain, not the IP.
