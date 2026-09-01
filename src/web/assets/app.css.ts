/**
 * Styles for the advocate-facing web app.
 *
 * Lives in a .ts file for the same reason the admin panel's markup does:
 * `nest build` compiles TypeScript and copies nothing else, so a .css file
 * beside this one would exist in src/ and be missing from dist/ - working
 * locally and 404ing in production. Exporting it as a string makes it part of
 * the compiled output by construction.
 *
 * ## The palette is the landing page's
 *
 * `/` and `/app` are one product and used to look like two: the landing page is
 * neutral - near-black on white, with a single green reserved for verification -
 * and this file was the admin panel's olive-on-cream. Crossing from the front
 * page into the app changed every colour on the screen, which reads as leaving
 * the site rather than entering the product.
 *
 * The values below are landing.css's, token for token. The *names* here are
 * unchanged, so the four hundred lines of rules underneath did not have to be
 * rewritten to adopt it.
 *
 * ## Why --accent and --olive are now separate
 *
 * One token used to carry two jobs: it painted the primary button *and* the
 * "verified" pill. The landing page keeps those deliberately apart - actions are
 * near-black, and green means one thing only, which is why a green badge there
 * is worth reading. Collapsing them back into one token would make the accent
 * ambient, and a colour that appears everywhere confirms nothing.
 *
 *   --accent   primary action: buttons, focus rings, the send key, active nav
 *   --olive    verification, success, and link affordance - never navigation
 *              state, which is what --surface-3 and --accent are for
 *
 * Both themes are defined in full rather than one overriding the other, so a
 * token can never be left holding a value from the wrong theme.
 */
export const APP_CSS = String.raw`
:root {
  --bg:#FFFFFF; --surface:#FFFFFF; --surface-2:#F7F7F8; --surface-3:#F0F0F1;
  --border:rgba(13,13,13,.09); --border-soft:rgba(13,13,13,.055);
  --text:#0D0D0D; --muted:#6B6B6B; --dim:#9B9B9B;

  /* Primary action. Near-black, as on the landing page. */
  --accent:#0D0D0D; --accent-ink:#FFFFFF; --accent-hover:#2B2B2B;

  /* Verification only. */
  --olive:#12805C; --olive-dark:#0E6A4C; --olive-light:rgba(18,128,92,.09);
  --red:#C0392B; --red-dark:#96271C; --red-light:rgba(192,57,43,.08);

  --ok:#12805C; --warn:#B35C00; --bad:var(--red);

  --radius:12px; --radius-lg:20px; --radius-sm:8px;
  --shadow:0 1px 2px rgba(13,13,13,.04), 0 8px 28px rgba(13,13,13,.06);
  --shadow-lg:0 8px 30px rgba(13,13,13,.10);
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",
         Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
  --sidebar-width:264px;
}

[data-theme="dark"] {
  --bg:#0A0A0A; --surface:#151515; --surface-2:#1D1D1D; --surface-3:#262626;
  --border:rgba(255,255,255,.11); --border-soft:rgba(255,255,255,.07);
  --text:#F5F5F5; --muted:#A1A1A1; --dim:#6E6E6E;

  /* Inverted, so a primary button stays the highest-contrast thing on screen. */
  --accent:#FFFFFF; --accent-ink:#0A0A0A; --accent-hover:#E2E2E2;

  --olive:#3DD68C; --olive-dark:#3DD68C; --olive-light:rgba(61,214,140,.12);
  --red:#FF7B6B; --red-dark:#FF7B6B; --red-light:rgba(255,123,107,.12);

  --ok:#3DD68C; --warn:#E0A44A; --bad:var(--red);
  --shadow:0 1px 2px rgba(0,0,0,.5), 0 12px 40px rgba(0,0,0,.4);
  --shadow-lg:0 12px 40px rgba(0,0,0,.5);
}

* { box-sizing:border-box; }
html, body { height:100%; }
body {
  margin:0; background:var(--bg); color:var(--text);
  font:15px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased;
}
a { color:var(--olive-dark); }
[data-theme="dark"] a { color:var(--olive); }
button, input, textarea, select { font:inherit; color:inherit; }
button { cursor:pointer; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }

/* ==========================================================================
   Shared controls
   ========================================================================== */
.btn {
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  border:1px solid transparent; border-radius:var(--radius-sm);
  padding:10px 16px; font-weight:600; font-size:14px;
  background:var(--accent); color:var(--accent-ink); transition:background .12s, opacity .12s;
}
.btn:hover { background:var(--accent-hover); }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.btn.secondary { background:var(--surface); color:var(--text); border-color:var(--border); }
.btn.secondary:hover { background:var(--surface-2); }
.btn.danger { background:var(--red); }
.btn.danger:hover { background:var(--red-dark); }
.btn.ghost { background:transparent; color:var(--muted); }
.btn.ghost:hover { background:var(--surface-2); color:var(--text); }
.btn.block { width:100%; }
.btn.small { padding:6px 11px; font-size:13px; }

.field { display:block; margin-bottom:14px; }
.field label { display:block; font-size:13px; font-weight:600; color:var(--muted); margin-bottom:6px; }
.field input, .field select, .field textarea {
  width:100%; background:var(--surface); border:1px solid var(--border);
  border-radius:var(--radius-sm); padding:11px 13px; font-size:15px;
}
.field input:focus { border-color:var(--accent); outline:none; box-shadow:0 0 0 3px var(--border); }
.field .hint { font-size:12px; color:var(--dim); margin-top:5px; }

.alert {
  border-radius:var(--radius-sm); padding:11px 13px; font-size:13.5px;
  margin-bottom:14px; border:1px solid transparent; line-height:1.5;
}
.alert.error { background:var(--red-light); border-color:var(--red); color:var(--red-dark); }
.alert.info { background:var(--olive-light); border-color:var(--olive); color:var(--olive-dark); }
.alert.warn { background:#FFF4E0; border-color:#E0A44A; color:#8A5200; }
[data-theme="dark"] .alert.error { color:var(--red); }
[data-theme="dark"] .alert.info { color:var(--olive); }
[data-theme="dark"] .alert.warn { background:#332612; color:#E8C288; }

.pill {
  display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600;
  padding:3px 9px; border-radius:999px; background:var(--surface-2);
  border:1px solid var(--border); color:var(--muted);
}
.pill.good { background:var(--olive-light); border-color:var(--olive); color:var(--olive-dark); }
.pill.bad  { background:var(--red-light); border-color:var(--red); color:var(--red-dark); }
[data-theme="dark"] .pill.good { color:var(--olive); }
[data-theme="dark"] .pill.bad { color:var(--red); }

.spinner {
  width:14px; height:14px; border-radius:50%; flex:0 0 auto;
  border:2px solid var(--border); border-top-color:var(--accent);
  animation:spin .7s linear infinite;
}
@keyframes spin { to { transform:rotate(360deg); } }

/* ==========================================================================
   Sign in / sign up
   ========================================================================== */
#auth {
  min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px;
  background:
    radial-gradient(1100px 520px at 12% -10%, var(--surface-2) 0%, transparent 62%),
    radial-gradient(900px 460px at 105% 108%, var(--olive-light) 0%, transparent 58%),
    var(--bg);
}
.auth-card {
  width:100%; max-width:430px; background:var(--surface);
  border:1px solid var(--border); border-radius:var(--radius-lg);
  padding:32px; box-shadow:var(--shadow-lg);
}
.brand { display:flex; align-items:center; gap:11px; margin-bottom:22px; }
.brand-mark {
  width:38px; height:38px; border-radius:11px; flex:0 0 auto;
  background:var(--accent);
  display:flex; align-items:center; justify-content:center;
  font-weight:800; color:var(--accent-ink); font-size:15px; letter-spacing:-.02em;
}
.brand-text b { display:block; font-size:16px; letter-spacing:-.2px; }
.brand-text span { font-size:12.5px; color:var(--muted); }

.auth-card h1 { font-size:21px; margin:0 0 4px; letter-spacing:-.3px; }
.auth-card .sub { font-size:14px; color:var(--muted); margin:0 0 22px; }

.oauth-btn {
  display:flex; align-items:center; justify-content:center; gap:10px; width:100%;
  background:var(--surface); color:var(--text);
  border:1px solid var(--border); border-radius:var(--radius-sm);
  padding:11px 16px; font-weight:600; font-size:14.5px; text-decoration:none;
}
.oauth-btn:hover { background:var(--surface-2); }
.oauth-btn svg { width:18px; height:18px; flex:0 0 auto; }

.divider { display:flex; align-items:center; gap:12px; margin:18px 0; color:var(--dim); font-size:12px; }
.divider::before, .divider::after { content:""; flex:1; height:1px; background:var(--border); }

.auth-switch { text-align:center; font-size:13.5px; color:var(--muted); margin-top:18px; }
.auth-switch button { background:none; border:none; color:var(--olive-dark); font-weight:600; padding:0; }
[data-theme="dark"] .auth-switch button { color:var(--olive); }
.forgot { background:none; border:none; padding:0; font-size:13px; color:var(--muted); text-decoration:underline; }

/* ==========================================================================
   App shell
   ========================================================================== */
#app { display:none; height:100dvh; }
#app.ready { display:flex; }

.sidebar {
  width:var(--sidebar-width); flex:0 0 auto; background:var(--surface-2);
  border-right:1px solid var(--border); display:flex; flex-direction:column;
}
.sidebar-head { padding:14px; border-bottom:1px solid var(--border-soft); }
.sidebar-head .brand { margin-bottom:14px; }

.thread-list { flex:1; overflow-y:auto; padding:8px; }
.thread-group-label {
  font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase;
  color:var(--dim); padding:12px 10px 6px;
}
.thread {
  display:flex; align-items:center; gap:8px; width:100%; text-align:left;
  padding:9px 10px; border-radius:var(--radius-sm); border:none; background:none;
  color:var(--text); font-size:13.5px; margin-bottom:1px;
}
.thread:hover { background:var(--surface-3); }
.thread.active { background:var(--surface-3); color:var(--text); font-weight:600; }
.thread .title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.thread .menu-btn { opacity:0; border:none; background:none; color:var(--muted); padding:2px 4px; border-radius:4px; }
.thread:hover .menu-btn, .thread.active .menu-btn { opacity:1; }
.thread .menu-btn:hover { background:var(--surface); color:var(--text); }

.sidebar-foot { border-top:1px solid var(--border-soft); padding:10px; }
.credit-chip {
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  width:100%; padding:10px 12px; border-radius:var(--radius-sm);
  background:var(--surface); border:1px solid var(--border); margin-bottom:8px;
  font-size:13px; text-align:left;
}
.credit-chip .amount { font-weight:700; font-size:15px; }
.credit-chip .label { color:var(--muted); font-size:12px; }

.account-btn {
  display:flex; align-items:center; gap:10px; width:100%; padding:8px 10px;
  border-radius:var(--radius-sm); border:none; background:none; text-align:left; font-size:13.5px;
}
.account-btn:hover { background:var(--surface-3); }
.avatar {
  width:28px; height:28px; border-radius:50%; flex:0 0 auto; object-fit:cover;
  background:var(--accent); color:var(--accent-ink); display:flex; align-items:center; justify-content:center;
  font-weight:700; font-size:12px;
}
.account-btn .who { flex:1; overflow:hidden; }
.account-btn .who b { display:block; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.account-btn .who span { font-size:11.5px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }

/* ==========================================================================
   Conversation
   ========================================================================== */
.main { flex:1; display:flex; flex-direction:column; min-width:0; background:var(--bg); }

.topbar {
  display:flex; align-items:center; gap:10px; padding:11px 18px;
  border-bottom:1px solid var(--border); background:var(--surface);
}
.topbar .thread-title { flex:1; font-weight:600; font-size:14.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hamburger { display:none; border:none; background:none; padding:6px; border-radius:6px; color:var(--muted); }

.messages { flex:1; overflow-y:auto; padding:26px 18px 8px; }
.messages-inner { max-width:780px; margin:0 auto; }

.msg { display:flex; gap:13px; margin-bottom:26px; }
.msg .who-mark {
  width:29px; height:29px; border-radius:8px; flex:0 0 auto;
  display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700;
}
.msg.user .who-mark { background:var(--surface-3); color:var(--muted); }
.msg.assistant .who-mark { background:var(--olive); color:#FFFFFF; }
.msg .body { flex:1; min-width:0; padding-top:3px; }
.msg .body > *:first-child { margin-top:0; }
.msg .body > *:last-child { margin-bottom:0; }
.msg .body p { margin:0 0 11px; }
.msg .body ul, .msg .body ol { margin:0 0 11px; padding-left:22px; }
.msg .body li { margin-bottom:4px; }
.msg .body h3 { font-size:14.5px; margin:18px 0 8px; letter-spacing:-.1px; }
.msg .body code { font-family:var(--mono); font-size:.9em; background:var(--surface-2); padding:1px 5px; border-radius:4px; }
.msg .body strong { font-weight:650; }
.msg.user .body { color:var(--text); }

.msg-meta { display:flex; align-items:center; gap:8px; margin-top:11px; flex-wrap:wrap; }
.msg-meta .cost { font-size:12px; color:var(--dim); }
.copy-btn { border:none; background:none; color:var(--dim); font-size:12px; padding:3px 7px; border-radius:5px; }
.copy-btn:hover { background:var(--surface-2); color:var(--text); }

/* Precedent cards */
.precedent {
  border:1px solid var(--border); border-radius:var(--radius); background:var(--surface);
  padding:15px 17px; margin-bottom:11px;
}
.precedent .case-title { font-weight:650; font-size:14.5px; margin-bottom:9px; letter-spacing:-.1px; }
.precedent .case-meta { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:9px; }
/* The seven required fields, as a label/value grid. Shares the case-status
   layout so a court record and a judgment read the same way down the page. */
.precedent .case-rows { margin:0 0 11px; }
.precedent .case-rows dt { padding:6px 0; font-size:11.5px; letter-spacing:.03em; }
.precedent .case-rows dd { padding:6px 0 6px 14px; font-size:13px; }
.precedent .holding { font-size:13.5px; color:var(--muted); line-height:1.6; }
.precedent .holding b { color:var(--text); font-weight:600; }
.precedent .excerpt {
  font-size:13px; color:var(--muted); line-height:1.6; margin-top:9px;
  padding-left:11px; border-left:2px solid var(--border);
}
.precedent .sections { margin-top:9px; display:flex; flex-wrap:wrap; gap:5px; }

/* Case status */
.case-card { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); overflow:hidden; }
.case-card .head { padding:14px 17px; background:var(--surface-2); border-bottom:1px solid var(--border); }
.case-card .head .cnr { font-family:var(--mono); font-size:12.5px; color:var(--muted); }
.case-card .head .parties { font-weight:650; font-size:14.5px; margin-top:3px; }
.case-rows { display:grid; grid-template-columns:auto 1fr; gap:0; }
.case-rows dt { padding:9px 17px; font-size:12.5px; color:var(--muted); border-bottom:1px solid var(--border-soft); }
.case-rows dd { padding:9px 17px; margin:0; font-size:13.5px; border-bottom:1px solid var(--border-soft); }
.case-rows dt:last-of-type, .case-rows dd:last-of-type { border-bottom:none; }

/* Sources and citations */
.sources { margin-top:13px; border-top:1px solid var(--border-soft); padding-top:11px; }
.sources summary { font-size:12.5px; color:var(--muted); cursor:pointer; font-weight:600; }
.sources ul { margin:9px 0 0; padding-left:19px; }
.sources li { font-size:12.5px; color:var(--muted); margin-bottom:4px; }

.caveat {
  margin-top:13px; font-size:12px; color:var(--dim); line-height:1.55;
  border-top:1px solid var(--border-soft); padding-top:10px;
}

/* Live progress */
.stages { display:flex; flex-direction:column; gap:7px; }
.stage-line { display:flex; align-items:center; gap:9px; font-size:13.5px; color:var(--muted); }
.stage-line.done { color:var(--dim); }
.stage-line .tick { width:14px; height:14px; flex:0 0 auto; color:var(--ok); }

/* Empty state */
.empty { max-width:640px; margin:56px auto 0; text-align:center; }
.empty h2 { font-size:23px; margin:0 0 8px; letter-spacing:-.4px; }
.empty p { color:var(--muted); margin:0 0 26px; font-size:14.5px; }
.suggestions { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; text-align:left; }
.suggestion {
  border:1px solid var(--border); border-radius:var(--radius); background:var(--surface);
  padding:14px 15px; font-size:13.5px; line-height:1.5;
}
.suggestion:hover { border-color:var(--accent); background:var(--surface-2); }
.suggestion b { display:block; font-size:12px; color:var(--text); margin-bottom:4px; font-weight:700;
  letter-spacing:.4px; text-transform:uppercase; }

/* Composer */
.composer-wrap { padding:12px 18px 18px; background:var(--bg); }
.composer-inner { max-width:780px; margin:0 auto; }
.composer {
  display:flex; align-items:flex-end; gap:9px; background:var(--surface);
  border:1px solid var(--border); border-radius:var(--radius-lg);
  padding:9px 9px 9px 15px; box-shadow:var(--shadow);
}
.composer:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--border); }
.composer textarea {
  flex:1; border:none; background:none; resize:none; outline:none;
  font-size:15px; line-height:1.5; max-height:190px; padding:6px 0;
}
.send-btn {
  width:34px; height:34px; flex:0 0 auto; border-radius:9px; border:none;
  background:var(--accent); color:var(--accent-ink); display:flex; align-items:center; justify-content:center;
}
.send-btn:disabled { background:var(--border); color:var(--dim); }
.composer-note { font-size:11.5px; color:var(--dim); text-align:center; margin-top:9px; line-height:1.5; }

/* ==========================================================================
   Modals
   ========================================================================== */
.modal-backdrop {
  position:fixed; inset:0; background:rgba(20,24,14,.5); backdrop-filter:blur(2px);
  display:flex; align-items:center; justify-content:center; padding:20px; z-index:50;
}
.modal {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
  width:100%; max-width:520px; max-height:86dvh; overflow-y:auto; box-shadow:var(--shadow-lg);
}
.modal-head {
  display:flex; align-items:center; gap:10px; padding:17px 20px;
  border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--surface);
}
.modal-head h2 { flex:1; font-size:16.5px; margin:0; letter-spacing:-.2px; }
.modal-body { padding:20px; }
.modal-section { margin-bottom:26px; }
.modal-section:last-child { margin-bottom:0; }
.modal-section h3 {
  font-size:12px; text-transform:uppercase; letter-spacing:.6px;
  color:var(--dim); margin:0 0 12px; font-weight:700;
}

.row {
  display:flex; align-items:center; gap:12px; padding:11px 0;
  border-bottom:1px solid var(--border-soft); font-size:13.5px;
}
.row:last-child { border-bottom:none; }
.row .grow { flex:1; min-width:0; }
.row .grow b { display:block; font-weight:600; }
.row .grow span { font-size:12.5px; color:var(--muted); }

.tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); padding:0 20px; }
.tab {
  border:none; background:none; padding:11px 12px; font-size:13.5px; font-weight:600;
  color:var(--muted); border-bottom:2px solid transparent; margin-bottom:-1px;
}
.tab.active { color:var(--text); border-bottom-color:var(--accent); }

.ledger { font-size:13px; }
.ledger .entry { display:flex; align-items:baseline; gap:11px; padding:9px 0; border-bottom:1px solid var(--border-soft); }
.ledger .entry:last-child { border-bottom:none; }
.ledger .delta { font-weight:700; font-variant-numeric:tabular-nums; min-width:38px; }
.ledger .delta.plus { color:var(--ok); }
.ledger .delta.minus { color:var(--muted); }
.ledger .what { flex:1; min-width:0; }
.ledger .when { font-size:11.5px; color:var(--dim); white-space:nowrap; }

.code-display {
  font-family:var(--mono); font-size:29px; font-weight:700; letter-spacing:7px;
  text-align:center; padding:19px; background:var(--olive-light);
  border:1px solid var(--olive); border-radius:var(--radius); color:var(--olive-dark);
  margin:14px 0;
}
[data-theme="dark"] .code-display { color:var(--olive); }

.steps { counter-reset:step; margin:0; padding:0; list-style:none; }
.steps li {
  counter-increment:step; position:relative; padding-left:32px; margin-bottom:13px;
  font-size:13.5px; line-height:1.55; color:var(--muted);
}
.steps li::before {
  content:counter(step); position:absolute; left:0; top:0;
  width:21px; height:21px; border-radius:50%; background:var(--surface-3);
  color:var(--text); font-size:11.5px; font-weight:700;
  display:flex; align-items:center; justify-content:center;
}

/* ==========================================================================
   Responsive — the sidebar becomes a drawer
   ========================================================================== */
@media (max-width:860px) {
  .hamburger { display:flex; }
  .sidebar {
    position:fixed; inset:0 auto 0 0; z-index:40; transform:translateX(-100%);
    transition:transform .2s ease; box-shadow:var(--shadow-lg);
  }
  .sidebar.open { transform:translateX(0); }
  .scrim { position:fixed; inset:0; background:rgba(20,24,14,.45); z-index:35; }
  .messages { padding:18px 14px 8px; }
  .composer-wrap { padding:10px 12px 14px; }
  .empty { margin-top:32px; }
}

@media (prefers-reduced-motion:reduce) {
  * { animation-duration:.01ms !important; transition-duration:.01ms !important; }
}
`;
