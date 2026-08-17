/**
 * The admin panel, as a single self-contained HTML document.
 *
 * ## Why it lives in a .ts file
 *
 * `nest build` compiles TypeScript and copies nothing else, so a .html file
 * beside this one would exist in src/ and be missing from dist/ - the panel
 * would work locally and 404 in production. Exporting the markup as a string
 * makes it part of the compiled output by construction.
 *
 * ## Why there is no framework
 *
 * No React, no build step, no CDN. Three reasons, in order of weight:
 *
 *  1. It ships inside the existing web service. Adding a Next.js app means a
 *     third Railway service, a second deploy pipeline and CORS between them,
 *     to render eight tables.
 *  2. No external script tags means the panel keeps working when a CDN is
 *     blocked or slow, and there is no third-party JavaScript sitting in front
 *     of an interface that displays advocates' personal data.
 *  3. It is ~700 lines of vanilla DOM code. A framework would not make it
 *     shorter.
 *
 * Charts are hand-rolled inline SVG for the same reason - a charting library is
 * 200KB to draw one line and one donut.
 */
export const ADMIN_UI_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Vakeel Saathi — Control Panel</title>
<style>
  /* Palette: olive green (primary), white (surfaces), red (alerts + accent).
     Olive carries navigation and confirmation; red is reserved for things that
     are wrong or destructive, so it keeps its meaning instead of becoming
     decoration. */
  :root {
    --bg:#F4F6EC; --panel:#FFFFFF; --panel-2:#F0F4E4; --border:#D9E2C4;
    --text:#1C2411; --muted:#5A6B45; --dim:#8A9A72;

    --olive:#6B8E23; --olive-dark:#50691A; --olive-light:#E9F1D6;
    --red:#C1121F; --red-dark:#960D18; --red-light:#FCE4E6;

    --accent:var(--olive); --accent-dim:var(--olive-dark);
    --ok:#4F7A1F; --warn:#B35C00; --bad:var(--red);
    --radius:12px; --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --shadow:0 1px 2px rgba(28,36,17,.06),0 4px 14px rgba(28,36,17,.05);
  }
  :root[data-theme="dark"] {
    --bg:#14180E; --panel:#1D2315; --panel-2:#262E1B; --border:#3A462A;
    --text:#EDF2E2; --muted:#A7B893; --dim:#7C8C69;

    --olive:#9BC53D; --olive-dark:#7FA82B; --olive-light:#2B3519;
    --red:#F0555F; --red-dark:#C1121F; --red-light:#3A1A1D;

    --accent:var(--olive); --accent-dim:var(--olive-dark);
    --ok:#9BC53D; --warn:#E0A44A; --bad:var(--red);
    --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--olive-dark)}
  button{font:inherit;cursor:pointer}

  /* ---------- login ---------- */
  #login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;
    background:
      radial-gradient(1100px 520px at 12% -10%, var(--olive-light) 0%, transparent 62%),
      radial-gradient(900px 460px at 105% 108%, var(--red-light) 0%, transparent 58%),
      var(--bg)}
  .login-card{background:var(--panel);border:1px solid var(--border);border-radius:18px;
              padding:34px;width:100%;max-width:430px;box-shadow:var(--shadow)}
  .brand{display:flex;align-items:center;gap:11px;margin-bottom:6px}
  .brand-mark{width:38px;height:38px;border-radius:11px;flex:0 0 auto;
    background:linear-gradient(140deg,var(--olive) 0%,var(--olive-dark) 55%,var(--red) 100%);
    display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;
    font-size:15px;letter-spacing:.5px;box-shadow:0 2px 8px rgba(107,142,35,.35)}
  .brand h1{font-size:18px;margin:0;font-weight:700;letter-spacing:-.01em}
  .brand .tag{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;
    letter-spacing:.1em;margin-top:1px}
  .sub{color:var(--muted);font-size:13px;margin:0 0 24px}
  label{display:block;font-size:11.5px;font-weight:700;color:var(--muted);
        margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
  input,select,textarea{width:100%;background:var(--panel);border:1.5px solid var(--border);
    color:var(--text);padding:10px 12px;border-radius:9px;font:inherit;outline:none;
    transition:border-color .12s,box-shadow .12s}
  input:focus,select:focus,textarea:focus{
    border-color:var(--olive);box-shadow:0 0 0 3.5px var(--olive-light)}
  .btn{background:var(--olive);color:#fff;border:none;padding:10px 18px;
       border-radius:9px;font-weight:650;transition:background .12s,transform .06s}
  .btn:hover{background:var(--olive-dark)}
  .btn:active{transform:translateY(1px)}
  .btn.secondary{background:var(--panel);border:1.5px solid var(--border);color:var(--text)}
  .btn.secondary:hover{background:var(--panel-2);border-color:var(--olive)}
  .btn.danger{background:var(--red)}
  .btn.danger:hover{background:var(--red-dark)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.sm{padding:6px 11px;font-size:12px;border-radius:7px}

  /* ---------- shell ---------- */
  #app{display:none;grid-template-columns:228px 1fr;min-height:100vh}
  aside{background:linear-gradient(178deg,var(--olive-dark) 0%,#3E5214 100%);
        padding:18px 13px;display:flex;flex-direction:column;gap:3px}
  :root[data-theme="dark"] aside{background:linear-gradient(178deg,#232C15 0%,#161C0D 100%);
        border-right:1px solid var(--border)}
  aside .brand{padding:6px 8px 18px}
  aside .brand h1{color:#fff}
  aside .brand .tag{color:rgba(255,255,255,.62)}
  aside .brand-mark{background:#fff;color:var(--olive-dark)}
  nav button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;
    background:none;border:none;color:rgba(255,255,255,.8);padding:9px 11px;
    border-radius:9px;font-size:13.5px;font-weight:550;transition:background .12s}
  nav button:hover{background:rgba(255,255,255,.13);color:#fff}
  nav button.active{background:#fff;color:var(--olive-dark);font-weight:700;
    box-shadow:0 2px 8px rgba(0,0,0,.16)}
  nav button .ico{width:17px;text-align:center;opacity:.9}
  nav button .badge{margin-left:auto;background:var(--red);color:#fff;
    border-radius:11px;padding:1px 8px;font-size:11px;font-weight:800}
  nav button.active .badge{background:var(--red)}
  .spacer{flex:1}
  main{padding:24px 28px;overflow-x:hidden;min-width:0}
  .head{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .head h2{margin:0;font-size:21px;font-weight:750;letter-spacing:-.02em}
  .head .grow{flex:1}

  /* ---------- pieces ---------- */
  .card{background:var(--panel);border:1px solid var(--border);
        border-radius:var(--radius);padding:18px;min-width:0;box-shadow:var(--shadow)}
  .card h3{margin:0 0 3px;font-size:14px;font-weight:700}
  .card .hint{color:var(--muted);font-size:12px;margin:0 0 14px}
  .grid{display:grid;gap:14px}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(162px,1fr))}
  .kpi{position:relative;overflow:hidden}
  /* Olive rail on every tile; red only on the ones that need attention. */
  .kpi::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--olive)}
  .kpi.alert::before{background:var(--red)}
  .kpi .label{color:var(--muted);font-size:11px;text-transform:uppercase;
              letter-spacing:.07em;font-weight:700}
  .kpi .value{font-size:29px;font-weight:780;margin-top:6px;letter-spacing:-.03em;
              color:var(--olive-dark)}
  :root[data-theme="dark"] .kpi .value{color:var(--olive)}
  .kpi.alert .value{color:var(--red)}
  .kpi .foot{color:var(--dim);font-size:11.5px;margin-top:4px}
  .two{grid-template-columns:1.65fr 1fr}
  @media(max-width:1080px){.two{grid-template-columns:1fr}}
  @media(max-width:760px){#app{grid-template-columns:1fr}aside{display:none}}

  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--olive-dark);font-weight:750;font-size:11px;
     text-transform:uppercase;letter-spacing:.06em;background:var(--olive-light);
     padding:9px 10px;border-bottom:2px solid var(--olive);white-space:nowrap}
  :root[data-theme="dark"] th{color:var(--olive)}
  td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top}
  tbody tr:hover{background:var(--panel-2)}
  tbody tr:last-child td{border-bottom:none}
  .scroll{overflow-x:auto;margin:0 -18px;padding:0 18px}
  .mono{font-family:var(--mono);font-size:12px}
  .trunc{max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .pill{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;
        font-weight:700;white-space:nowrap}
  .pill.ok{background:var(--olive-light);color:var(--ok);border:1px solid var(--olive)}
  .pill.warn{background:#FFF3DC;color:var(--warn);border:1px solid #E8B76A}
  .pill.bad{background:var(--red-light);color:var(--red);border:1px solid var(--red)}
  .pill.neutral{background:var(--panel-2);color:var(--muted);border:1px solid var(--border)}
  .pill.info{background:var(--olive-light);color:var(--olive-dark);border:1px solid var(--olive)}
  :root[data-theme="dark"] .pill.warn{background:#3A2A12;color:var(--warn);border-color:#7A5A20}
  :root[data-theme="dark"] .pill.info{color:var(--olive)}

  .empty{text-align:center;padding:44px 20px;color:var(--muted)}
  .empty .big{font-size:34px;margin-bottom:10px;opacity:.4;color:var(--olive)}
  .err{background:var(--red-light);border:1.5px solid var(--red);color:var(--red-dark);
       padding:11px 14px;border-radius:9px;margin-bottom:14px;font-size:13px;font-weight:550}
  :root[data-theme="dark"] .err{color:var(--red)}
  /* Olive by default; red when it is a problem you must act on. */
  .note{background:var(--olive-light);border-left:4px solid var(--olive);
        padding:12px 15px;border-radius:0 9px 9px 0;margin-bottom:16px;
        color:var(--text);font-size:12.5px}
  .note.alert{background:var(--red-light);border-left-color:var(--red)}
  .note strong{color:var(--olive-dark);font-weight:700}
  .note.alert strong{color:var(--red-dark)}
  :root[data-theme="dark"] .note strong{color:var(--olive)}
  :root[data-theme="dark"] .note.alert strong{color:var(--red)}

  /* ---------- settings ---------- */
  .field{margin-bottom:17px}
  .field .help{color:var(--muted);font-size:12px;margin-top:5px;line-height:1.45}
  .field .row{display:flex;gap:8px;align-items:center}
  .field .row input,.field .row select{flex:1;min-width:0}
  .set-state{font-size:11px;font-weight:750;white-space:nowrap}
  .set-state.on{color:var(--olive-dark)}
  :root[data-theme="dark"] .set-state.on{color:var(--olive)}
  .set-state.off{color:var(--dim)}
  .sticky-save{position:sticky;bottom:0;background:var(--panel);
    border-top:2px solid var(--olive);padding:14px 18px;margin:18px -18px -18px;
    display:flex;gap:10px;align-items:center;border-radius:0 0 var(--radius) var(--radius)}
  /* Read-only credential rows */
  .cred{background:var(--panel-2);border:1px solid var(--border);border-radius:9px;padding:12px 14px}
  .cred-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .cred-name{font-weight:650;font-size:13px;display:flex;flex-direction:column;gap:2px}
  .cred-key{color:var(--muted);font-size:11px;font-weight:400}
  .cred-state{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px}
  .cred-state .mono{color:var(--muted)}

  /* Pagination */
  .pager{display:flex;gap:8px;align-items:center;margin-top:14px;font-size:12.5px;color:var(--muted)}
  .pager .grow{flex:1}

  .checks{list-style:none;padding:0;margin:12px 0 0}
  .checks li{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}
  .checks li:last-child{border-bottom:none}
  .checks .fix{color:var(--muted);font-size:12px;margin-top:3px}
  .toast{position:fixed;bottom:22px;right:22px;background:var(--panel);
    border:1px solid var(--border);border-left:4px solid var(--olive);
    padding:13px 17px;border-radius:10px;box-shadow:0 10px 30px rgba(28,36,17,.18);
    font-size:13px;z-index:50;max-width:390px;font-weight:550}
  .toast.bad{border-left-color:var(--red)}
  .loading{color:var(--muted);padding:30px;text-align:center;font-size:13px}
  svg{display:block;max-width:100%}
  .legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;font-size:12px}
  .legend span{display:flex;align-items:center;gap:6px;color:var(--muted)}
  .dot{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
</style>
</head>
<body>

<!-- ============================ LOGIN ============================ -->
<div id="login">
  <form class="login-card" onsubmit="doLogin(event)">
    <div class="brand">
      <div class="brand-mark">VS</div>
      <div>
        <h1>Vakeel Saathi</h1>
        <div class="tag">Control Panel</div>
      </div>
    </div>
    <p class="sub" id="loginSub">Sign in to manage the bot.</p>
    <div id="loginErr"></div>

    <!-- Email + password. Hidden when the service has no ADMIN_EMAIL /
         ADMIN_PASSWORD set, in which case the token field below is shown. -->
    <div id="emailFields" style="display:none">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com" autocomplete="username">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" placeholder="••••••••••" autocomplete="current-password">
      </div>
    </div>

    <!-- Legacy fallback for deployments where login is not configured yet. -->
    <div id="tokenFields" style="display:none">
      <div class="field">
        <label for="token">Admin token</label>
        <input id="token" type="password" placeholder="Your JWT_SECRET value" autocomplete="current-password">
        <p class="help" id="tokenHelp"></p>
      </div>
    </div>

    <button class="btn" style="width:100%;margin-top:4px" type="submit" id="loginBtn">Sign in</button>
  </form>
</div>

<!-- ============================ APP ============================ -->
<div id="app">
  <aside>
    <div class="brand">
      <div class="brand-mark">VS</div>
      <div>
        <h1>Vakeel Saathi</h1>
        <div class="tag">Control Panel</div>
      </div>
    </div>
    <nav id="nav"></nav>
    <div class="spacer"></div>
    <div id="whoami" style="color:rgba(255,255,255,.62);font-size:11px;padding:0 10px 8px;
         overflow:hidden;text-overflow:ellipsis"></div>
    <button class="btn secondary sm" onclick="toggleTheme()">Toggle theme</button>
    <button class="btn secondary sm" style="margin-top:6px" onclick="logout()">Sign out</button>
  </aside>
  <main id="main"><div class="loading">Loading…</div></main>
</div>

<script>
/* =========================================================================
   State + transport
   ========================================================================= */
var TOKEN       = sessionStorage.getItem('vs_admin_token') || '';
var ADMIN_EMAIL = sessionStorage.getItem('vs_admin_email') || '';
var EMAIL_LOGIN = false;
var VIEW        = 'dashboard';
var CACHE       = {};

var VIEWS = [
  { id:'dashboard',     label:'Dashboard',     icon:'◳' },
  { id:'system',        label:'System',        icon:'⬢' },
  { id:'verifications', label:'Verifications', icon:'✓' },
  { id:'users',         label:'Users',         icon:'●' },
  { id:'credits',       label:'Credits',       icon:'◆' },
  { id:'searches',      label:'Queries',       icon:'▤' },
  { id:'messages',      label:'Messages',      icon:'✉' },
  { id:'chats',         label:'Web chats',     icon:'▭' },
  { id:'corpus',        label:'Corpus',        icon:'▦' },
  { id:'settings',      label:'Settings',      icon:'⚙' },
  { id:'audit',         label:'Audit log',     icon:'⌚' }
];

/** Rows per page for the tables. */
var PAGE = 50;
/** Per-view offsets, so paging survives switching views and back. */
var OFFSET = { users:0, searches:0, messages:0, credits:0, chats:0 };
/** Dashboard auto-refresh handle, and whether it is enabled. */
var REFRESH_TIMER = null;
var AUTO_REFRESH = localStorage.getItem('vs_autorefresh') === '1';
var REFRESH_SECONDS = 30;

function api(path, options) {
  options = options || {};
  var headers = { 'authorization': 'Bearer ' + TOKEN };
  if (options.body) headers['content-type'] = 'application/json';
  return fetch('/admin' + path, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(function (r) {
    if (r.status === 401) { logout(); throw new Error('Session expired — sign in again.'); }
    return r.json().then(function (j) {
      if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Request failed (' + r.status + ')'));
      // The global ResponseInterceptor wraps successful payloads as
      // { success, data, meta }. Unwrap so views only see their own shape.
      return (j && Object.prototype.hasOwnProperty.call(j, 'data')) ? j.data : j;
    });
  });
}

/**
 * Ask the server which sign-in mode it is in and render the matching form.
 * Falls back to the token field if the probe itself fails, so a transient error
 * never leaves the page with no way in.
 */
function initLoginForm() {
  return fetch('/admin/auth/mode', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var d = (j && j.data) ? j.data : j;
      EMAIL_LOGIN = !!(d && d.emailLogin);
      document.getElementById('emailFields').style.display = EMAIL_LOGIN ? 'block' : 'none';
      document.getElementById('tokenFields').style.display = EMAIL_LOGIN ? 'none' : 'block';
      document.getElementById('loginSub').textContent = EMAIL_LOGIN
        ? 'Sign in to manage the bot.'
        : 'Token sign-in.';
      if (!EMAIL_LOGIN && d && d.hint) {
        document.getElementById('tokenHelp').textContent = d.hint;
      }
    })
    .catch(function () {
      EMAIL_LOGIN = false;
      document.getElementById('tokenFields').style.display = 'block';
    });
}

function doLogin(e) {
  e.preventDefault();
  var errBox = document.getElementById('loginErr');
  var btn = document.getElementById('loginBtn');
  errBox.innerHTML = '';

  var fail = function (msg) {
    TOKEN = '';
    btn.disabled = false;
    btn.textContent = 'Sign in';
    errBox.innerHTML = '<div class="err">' + esc(msg) + '</div>';
  };

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  if (EMAIL_LOGIN) {
    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;
    if (!email || !password) return fail('Enter your email and password.');

    fetch('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Sign-in failed.');
        return (j && j.data) ? j.data : j;
      });
    }).then(function (d) {
      TOKEN = d.token;
      ADMIN_EMAIL = d.email || email;
      sessionStorage.setItem('vs_admin_token', TOKEN);
      sessionStorage.setItem('vs_admin_email', ADMIN_EMAIL);
      btn.disabled = false;
      btn.textContent = 'Sign in';
      boot();
    }).catch(function (err) { fail(err.message); });
    return;
  }

  // Token mode: no login endpoint, so validate by calling a cheap guarded route.
  var value = document.getElementById('token').value.trim();
  if (!value) return fail('Enter your admin token.');
  TOKEN = value;
  api('/stats').then(function () {
    sessionStorage.setItem('vs_admin_token', TOKEN);
    btn.disabled = false;
    btn.textContent = 'Sign in';
    boot();
  }).catch(function (err) { fail(err.message); });
}

function logout() {
  sessionStorage.removeItem('vs_admin_token');
  sessionStorage.removeItem('vs_admin_email');
  TOKEN = '';
  ADMIN_EMAIL = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  var pw = document.getElementById('password');
  if (pw) pw.value = '';
  initLoginForm();
}

function boot() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'grid';
  document.getElementById('whoami').textContent = ADMIN_EMAIL ? 'Signed in as ' + ADMIN_EMAIL : '';
  renderNav();
  go(VIEW);
}

/* =========================================================================
   Helpers
   ========================================================================= */
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}
function num(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-IN'); }
function when(ts) {
  if (!ts) return '—';
  var d = new Date(ts), diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}
/* Phone numbers are personal data; show enough to identify a row, not enough
   to dial it from a screenshot. */
function maskPhone(p) {
  if (!p) return '—';
  var s = String(p);
  return s.length <= 5 ? s : s.slice(0, 3) + '•••••' + s.slice(-3);
}
function toast(msg, bad) {
  var el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, 4200);
}
function empty(msg, sub) {
  return '<div class="empty"><div class="big">∅</div><div>' + esc(msg) + '</div>' +
         (sub ? '<div style="font-size:12px;margin-top:6px">' + esc(sub) + '</div>' : '') + '</div>';
}
function statusPill(s) {
  var map = { VERIFIED:'ok', SENT:'ok', DELIVERED:'ok', READ:'ok',
              PENDING:'neutral', SUBMITTED:'warn', QUEUED:'info', PROCESSING:'info',
              RECEIVED:'info', REJECTED:'bad', FAILED:'bad' };
  return '<span class="pill ' + (map[s] || 'neutral') + '">' + esc(s) + '</span>';
}
function toggleTheme() {
  var root = document.documentElement;
  var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  localStorage.setItem('vs_theme', next);
  if (CACHE.dashboard && VIEW === 'dashboard') go('dashboard');
}

/* =========================================================================
   Navigation
   ========================================================================= */
function renderNav(pending) {
  document.getElementById('nav').innerHTML = VIEWS.map(function (v) {
    var badge = (v.id === 'verifications' && pending) ? '<span class="badge">' + pending + '</span>' : '';
    return '<button class="' + (v.id === VIEW ? 'active' : '') + '" onclick="go(\'' + v.id + '\')">' +
           '<span class="ico">' + v.icon + '</span>' + esc(v.label) + badge + '</button>';
  }).join('');
}

function go(view) {
  VIEW = view;
  renderNav(CACHE.pending);

  // Auto-refresh belongs to the dashboard only; leaving it running while the
  // operator is editing settings would blow away their half-typed form.
  if (REFRESH_TIMER) { clearInterval(REFRESH_TIMER); REFRESH_TIMER = null; }

  var main = document.getElementById('main');
  main.innerHTML = '<div class="loading">Loading…</div>';
  var fn = ({
    dashboard: viewDashboard, system: viewSystem, verifications: viewVerifications,
    users: viewUsers, credits: viewCredits, searches: viewSearches, messages: viewMessages,
    chats: viewChats, corpus: viewCorpus, settings: viewSettings, audit: viewAudit
  })[view];

  Promise.resolve()
    .then(fn)
    .catch(function (err) {
      // Per-view recovery: one failing endpoint must not leave a dead page with
      // no way back other than reloading.
      main.innerHTML = '<div class="err">' + esc(err.message) + '</div>' +
        '<button class="btn secondary" onclick="go(\'' + view + '\')">Retry</button> ' +
        '<button class="btn secondary" onclick="go(\'dashboard\')">Back to dashboard</button>';
    });
}

/** Shared next/previous controls for the paged tables. */
function pager(view, count) {
  var offset = OFFSET[view] || 0;
  var from = count === 0 ? 0 : offset + 1;
  return '<div class="pager">' +
    '<button class="btn secondary sm" ' + (offset === 0 ? 'disabled' : '') +
      ' onclick="pageBy(\'' + view + '\', -1)">← Previous</button>' +
    '<button class="btn secondary sm" ' + (count < PAGE ? 'disabled' : '') +
      ' onclick="pageBy(\'' + view + '\', 1)">Next →</button>' +
    '<span class="grow"></span>' +
    '<span>showing ' + from + '–' + (offset + count) + '</span>' +
    '</div>';
}

function pageBy(view, direction) {
  OFFSET[view] = Math.max(0, (OFFSET[view] || 0) + direction * PAGE);
  go(view);
}

/** Download the current table as CSV, for anything that needs a spreadsheet. */
function exportCsv(rows, filename) {
  if (!rows || !rows.length) { toast('Nothing to export.', true); return; }
  var cols = Object.keys(rows[0]);
  var esc2 = function (v) {
    if (v === null || v === undefined) return '';
    var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var csv = [cols.join(',')].concat(rows.map(function (r) {
    return cols.map(function (c) { return esc2(r[c]); }).join(',');
  })).join('\n');

  var url = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* =========================================================================
   Charts — hand-rolled inline SVG
   ========================================================================= */

/** Line + area chart. Points are [{label, value}]. */
function lineChart(points, opts) {
  opts = opts || {};
  var w = 100, h = 34, pad = 2;               // viewBox units; CSS scales it
  if (!points.length) return empty('No activity in this period');
  var max = Math.max.apply(null, points.map(function (p) { return p.value; })).valueOf() || 1;
  var step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;

  var coords = points.map(function (p, i) {
    var x = pad + i * step;
    var y = h - pad - (p.value / max) * (h - pad * 2);
    return [x, y];
  });
  var line = coords.map(function (c, i) { return (i ? 'L' : 'M') + c[0].toFixed(2) + ' ' + c[1].toFixed(2); }).join(' ');
  var area = line + ' L' + coords[coords.length - 1][0].toFixed(2) + ' ' + (h - pad) +
             ' L' + coords[0][0].toFixed(2) + ' ' + (h - pad) + ' Z';

  var dots = coords.map(function (c, i) {
    return '<circle cx="' + c[0].toFixed(2) + '" cy="' + c[1].toFixed(2) + '" r="0.5" fill="var(--accent)">' +
           '<title>' + esc(points[i].label) + ': ' + points[i].value + '</title></circle>';
  }).join('');

  // Label only the ends and middle — more than three labels is unreadable at
  // this width and they overlap on narrow screens.
  var marks = [0, Math.floor(points.length / 2), points.length - 1]
    .filter(function (v, i, a) { return a.indexOf(v) === i; })
    .map(function (i) {
      var anchor = i === 0 ? 'start' : (i === points.length - 1 ? 'end' : 'middle');
      return '<text x="' + (pad + i * step).toFixed(2) + '" y="' + (h + 3) + '" font-size="2.6" ' +
             'fill="var(--dim)" text-anchor="' + anchor + '">' + esc(points[i].label.slice(5)) + '</text>';
    }).join('');

  return '<svg viewBox="0 0 ' + w + ' ' + (h + 5) + '" style="width:100%;height:' + (opts.height || 190) + 'px">' +
    '<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>' +
    '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>' +
    '</linearGradient></defs>' +
    '<path d="' + area + '" fill="url(#lg)"/>' +
    '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="0.7" ' +
    'stroke-linejoin="round" stroke-linecap="round"/>' + dots + marks +
    '</svg>' +
    '<div class="legend"><span><i class="dot" style="background:var(--accent)"></i>' +
    esc(opts.seriesLabel || 'Queries') + '</span>' +
    '<span style="margin-left:auto">peak ' + max + '</span></div>';
}

/* Olive family first (the common intents), red last (the exceptional ones), with
   enough separation between adjacent entries to stay distinguishable. */
var SLICE_COLOURS = ['#6B8E23','#C1121F','#A3B858','#E07A5F','#4F6B18','#8A9A72','#F2A65A','#7D2E33'];

/** Donut chart. Slices are [{label, value}]. */
function donutChart(slices) {
  var total = slices.reduce(function (a, s) { return a + s.value; }, 0);
  if (!total) return empty('No queries yet');

  var cx = 21, cy = 21, r = 15.5, circ = 2 * Math.PI * r, offset = 0;

  var arcs = slices.map(function (s, i) {
    var frac = s.value / total;
    var seg = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" ' +
      'stroke="' + SLICE_COLOURS[i % SLICE_COLOURS.length] + '" stroke-width="6" ' +
      'stroke-dasharray="' + (frac * circ).toFixed(3) + ' ' + circ.toFixed(3) + '" ' +
      'stroke-dashoffset="' + (-offset).toFixed(3) + '" ' +
      'transform="rotate(-90 ' + cx + ' ' + cy + ')">' +
      '<title>' + esc(s.label) + ': ' + s.value + ' (' + Math.round(frac * 100) + '%)</title></circle>';
    offset += frac * circ;
    return seg;
  }).join('');

  var legend = slices.map(function (s, i) {
    return '<span><i class="dot" style="background:' + SLICE_COLOURS[i % SLICE_COLOURS.length] + '"></i>' +
           esc(s.label.replace(/_/g, ' ').toLowerCase()) + ' <b style="color:var(--text)">' + s.value + '</b></span>';
  }).join('');

  return '<svg viewBox="0 0 42 42" style="width:100%;max-width:190px;margin:6px auto">' + arcs +
    '<text x="21" y="20.6" text-anchor="middle" font-size="6.5" font-weight="700" fill="var(--text)">' +
    total + '</text>' +
    '<text x="21" y="25" text-anchor="middle" font-size="2.8" fill="var(--muted)">queries</text>' +
    '</svg><div class="legend">' + legend + '</div>';
}

/* =========================================================================
   Views
   ========================================================================= */

function viewDashboard() {
  return api('/dashboard?days=14').then(function (d) {
    CACHE.dashboard = d;
    CACHE.pending = d.pendingVerifications;
    renderNav(CACHE.pending);

    var p = d.platform, c = d.corpus;
    var embedPct = c.chunks ? Math.round((c.embedded / c.chunks) * 100) : 0;

    // Two things silently make the bot useless, so they get called out at the
    // top rather than buried: no WhatsApp credentials (cannot send), and a
    // mock synthesis provider (answers are placeholders).
    var warnings = [];
    if (!d.whatsapp.configured) {
      warnings.push('WhatsApp is not connected — replies are written to the log instead of sent. ' +
                    'Open Settings to paste your credentials.');
    }
    if (d.providers.synthesis === 'mock') {
      warnings.push('Synthesis provider is set to <strong>mock</strong> — answers are canned placeholders, ' +
                    'not real legal analysis. Add an API key in Settings.');
    }
    // Only a problem when precedent search actually depends on the local
    // corpus. With Indian Kanoon configured, an empty corpus is the normal
    // state and telling the operator to ingest would be wrong.
    var pre = d.precedents || {};
    if (c.judgments === 0 && pre.needsLocalCorpus) {
      warnings.push('The judgment corpus is empty and no case law source is configured — ' +
                    'precedent search cannot return anything. Either add an ' +
                    '<strong>Indian Kanoon API key</strong> in Settings for live case law, ' +
                    'or run <code class="mono">npm run ingest</code> to load a local corpus.');
    }
    if (pre.kanoonDegraded) {
      warnings.push('Indian Kanoon is failing and has been temporarily taken out of use. ' +
                    'Precedent search is falling back to the local corpus until it recovers.');
    }

    // The alert flag turns a tile's rail and figure red. Reserved for numbers
    // that mean something is wrong, so red keeps its meaning across the panel.
    // (No backticks anywhere in this file - it is one big String.raw literal,
    // and a stray backtick silently terminates it.)
    var kpis = [
      { label:'Total users',     value:num(p.totalUsers),   foot:num(p.verifiedUsers) + ' verified' },
      { label:'Active (14d)',    value:num(p.activeUsers),  foot:'distinct advocates' },
      { label:'Queries (14d)',   value:num(p.queries),      foot:'answered' },
      { label:'Avg latency',     value:p.avgLatencyMs ? p.avgLatencyMs + 'ms' : '—',
        foot:'target < 2500ms', alert: p.avgLatencyMs > 2500 },
      { label:'Guardrail hits',  value:num(p.guardrailFlagged),
        foot:'ungrounded citations blocked', alert: p.guardrailFlagged > 0 },
      // Not red when Kanoon is serving case law - an empty local corpus is the
      // expected state then, not a fault.
      { label:'Local corpus',    value:num(c.judgments),
        foot: pre.kanoonConfigured
          ? 'Kanoon is the live source'
          : num(c.chunks) + ' chunks · ' + embedPct + '% embedded',
        alert: c.judgments === 0 && pre.needsLocalCorpus }
    ];

    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Dashboard</h2><div class="grow"></div>' +
      '<span class="pill ' + (d.whatsapp.configured ? 'ok' : 'bad') + '">WhatsApp ' +
      (d.whatsapp.configured ? 'connected' : 'not connected') + '</span>' +
      '<span class="pill ' + (d.providers.synthesis === 'mock' ? 'warn' : 'ok') + '">AI: ' +
      esc(d.providers.synthesis) + '</span>' +
      '<span class="pill ' + (pre.kanoonConfigured ? 'ok' : 'neutral') + '">Case law: ' +
      esc(pre.kanoonConfigured ? 'Indian Kanoon' : 'local corpus') + '</span>' +
      '<button class="btn secondary sm" onclick="toggleAutoRefresh()">' +
      (AUTO_REFRESH ? '⏸ Auto-refresh on' : '▶ Auto-refresh off') + '</button></div>' +

      warnings.map(function (w) { return '<div class="note alert">' + w + '</div>'; }).join('') +

      '<div class="grid kpis" style="margin-bottom:14px">' +
        kpis.map(function (k) {
          return '<div class="card kpi' + (k.alert ? ' alert' : '') + '">' +
                 '<div class="label">' + esc(k.label) + '</div>' +
                 '<div class="value">' + k.value + '</div>' +
                 '<div class="foot">' + esc(k.foot) + '</div></div>';
        }).join('') +
      '</div>' +

      '<div class="grid two" style="margin-bottom:14px">' +
        '<div class="card"><h3>Query volume</h3>' +
        '<p class="hint">Answered queries per day, last 14 days.</p>' +
        lineChart(d.series.map(function (s) { return { label:s.day, value:s.queries }; })) + '</div>' +

        '<div class="card"><h3>What people ask</h3>' +
        '<p class="hint">Intent mix over the same period.</p>' +
        donutChart(d.intents.map(function (i) { return { label:i.intent, value:i.count }; })) + '</div>' +
      '</div>' +

      '<div class="grid two">' +
        '<div class="card"><h3>Daily detail</h3><p class="hint">Latency is the end-to-end answer time.</p>' +
        '<div class="scroll"><table><thead><tr><th>Day</th><th>Queries</th><th>Users</th>' +
        '<th>Flagged</th><th>Avg latency</th></tr></thead><tbody>' +
        d.series.slice().reverse().map(function (s) {
          return '<tr><td class="mono">' + esc(s.day) + '</td><td>' + s.queries + '</td>' +
                 '<td>' + s.users + '</td>' +
                 '<td>' + (s.flagged ? '<span class="pill warn">' + s.flagged + '</span>' : '0') + '</td>' +
                 '<td>' + (s.avgLatencyMs ? s.avgLatencyMs + 'ms' : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' +

        '<div class="card" id="deliveryCard"><h3>Message delivery</h3>' +
        '<p class="hint">Outbound failures usually mean an expired token or the 24-hour window.</p>' +
        (d.messages.length
          ? '<table><tbody>' + d.messages.map(function (m) {
              return '<tr><td>' + esc(m.direction) + '</td><td>' + statusPill(m.status) + '</td>' +
                     '<td style="text-align:right">' + num(m.count) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : empty('No messages yet')) +
        '</div>' +
      '</div>';

    scheduleAutoRefresh();
  });
}

/**
 * Re-run the dashboard on a timer.
 *
 * Only ever armed from the dashboard, and cleared by go() on navigation, so it
 * cannot fire while the operator is halfway through the settings form and wipe
 * what they typed.
 */
function scheduleAutoRefresh() {
  if (REFRESH_TIMER) { clearInterval(REFRESH_TIMER); REFRESH_TIMER = null; }
  if (!AUTO_REFRESH) return;

  REFRESH_TIMER = setInterval(function () {
    // Refreshing a hidden tab burns database queries for nobody.
    if (document.hidden || VIEW !== 'dashboard') return;
    viewDashboard().catch(function () { /* transient - the next tick retries */ });
  }, REFRESH_SECONDS * 1000);
}

function toggleAutoRefresh() {
  AUTO_REFRESH = !AUTO_REFRESH;
  localStorage.setItem('vs_autorefresh', AUTO_REFRESH ? '1' : '0');
  go('dashboard');
}

/**
 * Runtime health.
 *
 * The queue numbers are the ones that matter operationally: a rising "waiting"
 * with a flat "completed" means the worker is dead or wedged, which otherwise
 * shows up only as users saying the bot ignored them.
 *
 * (No backticks in this file - it is one String.raw literal.)
 */
function viewSystem() {
  return api('/system').then(function (s) {
    var q = s.queue || {}, dep = s.dependencies || {}, p = s.process || {}, c = s.config || {};

    var waiting = Number(q.waiting || 0);
    var failed = Number(q.failed || 0);

    var tiles = [
      { label:'Queue waiting',  value:num(waiting), foot:'jobs not yet picked up', alert: waiting > 50 },
      { label:'Active',         value:num(q.active || 0), foot:'being processed now' },
      { label:'Completed',      value:num(q.completed || 0), foot:'since worker start' },
      { label:'Failed',         value:num(failed), foot:'dead-lettered', alert: failed > 0 },
      { label:'Uptime',         value:Math.floor((p.uptimeSeconds||0)/60) + 'm', foot:'this web process' },
      { label:'Heap',           value:(p.heapUsedMb||0) + 'MB', foot:'of ' + (p.heapTotalMb||0) + 'MB · RSS ' + (p.rssMb||0) + 'MB' }
    ];

    var row = function (label, ok, detail) {
      return '<tr><td>' + esc(label) + '</td>' +
        '<td><span class="pill ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'ok' : 'problem') + '</span></td>' +
        '<td class="mono">' + esc(detail) + '</td></tr>';
    };

    document.getElementById('main').innerHTML =
      '<div class="head"><h2>System</h2><div class="grow"></div>' +
      '<button class="btn secondary sm" onclick="go(\'system\')">Refresh</button></div>' +

      (waiting > 50
        ? '<div class="note alert"><strong>' + waiting + ' jobs are waiting.</strong> ' +
          'If this keeps climbing while <em>Completed</em> stays flat, the worker process is not ' +
          'consuming the queue — check that it is running.</div>' : '') +
      (failed > 0
        ? '<div class="note alert"><strong>' + failed + ' failed jobs.</strong> ' +
          'These exhausted their retries and will not be delivered. Check Messages for the errors.</div>' : '') +

      '<div class="grid kpis" style="margin-bottom:14px">' +
        tiles.map(function (t) {
          return '<div class="card kpi' + (t.alert ? ' alert' : '') + '">' +
            '<div class="label">' + esc(t.label) + '</div>' +
            '<div class="value">' + t.value + '</div>' +
            '<div class="foot">' + esc(t.foot) + '</div></div>';
        }).join('') +
      '</div>' +

      '<div class="grid two">' +
        '<div class="card"><h3>Dependencies</h3><p class="hint">Live connectivity from this process.</p>' +
        '<table><tbody>' +
          row('PostgreSQL (Supabase)', dep.database, dep.database ? 'reachable' : 'UNREACHABLE') +
          row('Redis', dep.redis, dep.redis ? 'reachable' : 'UNREACHABLE') +
          row('WhatsApp credentials', c.whatsappConfigured, c.whatsappPhoneNumberId || 'not configured') +
        '</tbody></table></div>' +

        '<div class="card"><h3>Active configuration</h3>' +
        '<p class="hint">What the bot is actually using right now.</p>' +
        '<table><tbody>' +
          '<tr><td>Case law source</td><td class="mono">' + esc(c.precedentSource) + '</td>' +
            '<td>' + (c.kanoonConfigured
              ? '<span class="pill ' + (c.kanoonDegraded ? 'bad' : 'ok') + '">Kanoon ' +
                (c.kanoonDegraded ? 'degraded' : 'live') + '</span>'
              : '<span class="pill neutral">local corpus</span>') + '</td></tr>' +
          '<tr><td>Synthesis model</td><td class="mono">' + esc(c.synthesisProvider) + '</td>' +
            '<td>' + (c.synthesisProvider === 'mock' ? '<span class="pill warn">placeholder answers</span>' : '') + '</td></tr>' +
          '<tr><td>Router model</td><td class="mono">' + esc(c.routerProvider) + '</td><td></td></tr>' +
          '<tr><td>Embeddings</td><td class="mono">' + esc(c.embeddingProvider) + '</td>' +
            '<td>' + (c.embeddingProvider === 'mock' ? '<span class="pill warn">keyword-only search</span>' : '') + '</td></tr>' +
          '<tr><td>Chat memory</td><td class="mono">' + (c.memoryEnabled ? 'on' : 'off') + '</td><td></td></tr>' +
          '<tr><td>Node</td><td class="mono">' + esc(p.nodeVersion) + '</td>' +
            '<td class="mono">' + esc(p.environment) + '</td></tr>' +
        '</tbody></table></div>' +
      '</div>';
  });
}

function viewVerifications() {
  return api('/verifications').then(function (rows) {
    CACHE.pending = rows.length;
    renderNav(rows.length);
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Verification queue</h2></div>' +
      '<div class="note">Advocates submit a bar council number and ID card from WhatsApp. ' +
      'Approving grants <strong>unlimited daily queries</strong> and notifies them immediately.</div>' +
      '<div class="card">' +
      (rows.length
        ? '<div class="scroll"><table><thead><tr><th>Name</th><th>Phone</th><th>Bar council ID</th>' +
          '<th>State</th><th>Submitted</th><th></th></tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr><td>' + esc(r.full_name || '—') + '</td>' +
              '<td class="mono">' + esc(r.phone) + '</td>' +
              '<td class="mono">' + esc(r.bar_council_id || '—') + '</td>' +
              '<td>' + esc(r.bar_council_state || '—') + '</td>' +
              '<td>' + when(r.submitted_at) + '</td>' +
              '<td style="white-space:nowrap">' +
              '<button class="btn sm" onclick="approve(\'' + r.id + '\')">Approve</button> ' +
              '<button class="btn sm danger" onclick="reject(\'' + r.id + '\')">Reject</button></td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('Nothing awaiting review', 'Submissions from WhatsApp appear here.')) +
      '</div>';
  });
}

function approve(id) {
  api('/verifications/' + id + '/approve', { method:'POST', body:{} })
    .then(function () { toast('Approved — the advocate has been notified.'); go('verifications'); })
    .catch(function (e) { toast(e.message, true); });
}
function reject(id) {
  var notes = prompt('Reason for rejection (sent to the advocate):', 'Details could not be verified');
  if (notes === null) return;
  api('/verifications/' + id + '/reject', { method:'POST', body:{ notes:notes } })
    .then(function () { toast('Rejected — the advocate has been notified.'); go('verifications'); })
    .catch(function (e) { toast(e.message, true); });
}

function viewUsers() {
  var q = (CACHE.userQuery || '');
  var off = OFFSET.users || 0;
  return api('/users?limit=' + PAGE + '&offset=' + off + (q ? '&q=' + encodeURIComponent(q) : '')).then(function (rows) {
    CACHE.usersRows = rows;
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Users</h2><div class="grow"></div>' +
      '<input id="uq" placeholder="Search name, number or email…" style="max-width:250px" value="' + esc(q) + '">' +
      '<button class="btn sm" onclick="searchUsers()">Search</button>' +
      '<button class="btn secondary sm" onclick="exportCsv(CACHE.usersRows, \'users.csv\')">Export CSV</button></div>' +
      '<div class="card">' +
      (rows.length
        ? '<div class="scroll"><table><thead><tr><th>Account</th><th>Name</th><th>Via</th><th>Role</th>' +
          '<th>Status</th><th style="text-align:right">Credits</th><th>Today</th>' +
          '<th>Last active</th><th></th></tr></thead><tbody>' +
          rows.map(function (u) {
            // Whichever identifier the advocate actually uses. A web-only
            // account has no number, and a WhatsApp-only one has no email, so
            // a single "Phone" column left half the table showing dashes.
            var handle = u.email
              ? esc(u.email)
              : '<span class="mono">' + esc(maskPhone(u.phone_number)) + '</span>';
            var channels =
              (u.phone_verified || u.phone_number ? '<span class="pill neutral" title="WhatsApp">wa</span> ' : '') +
              (u.email ? '<span class="pill ' + (u.email_verified ? 'ok' : 'neutral') +
                '" title="' + (u.email_verified ? 'Email confirmed' : 'Email not confirmed') +
                '">web</span>' : '');

            return '<tr><td class="trunc" title="' + esc(u.email || u.phone_number || '') + '">' +
                handle + '<button class="btn secondary sm" style="margin-left:6px;padding:1px 6px;font-size:10px" ' +
                'onclick="copyId(\'' + u.id + '\')" title="Copy user id">id</button></td>' +
              '<td>' + esc(u.full_name || '—') + '</td>' +
              '<td style="white-space:nowrap">' + channels + '</td>' +
              '<td><span class="pill neutral">' + esc(u.role.replace(/_/g, ' ').toLowerCase()) + '</span></td>' +
              '<td>' + statusPill(u.verification_status) + '</td>' +
              '<td style="text-align:right" class="mono" title="' + u.free_credits + ' free + ' +
                u.paid_credits + ' durable">' +
                (u.role === 'GUEST_LAWYER'
                  ? (u.free_credits + u.paid_credits)
                  : '<span style="color:var(--muted)">∞</span>') + '</td>' +
              '<td>' + num(u.query_count) + '</td>' +
              '<td>' + when(u.last_active_at) + '</td>' +
              '<td><select class="mono" style="font-size:11px;padding:3px" ' +
              'onchange="setRole(\'' + u.id + '\', this.value)">' +
              ['GUEST_LAWYER','VERIFIED_ADVOCATE','LEGAL_AUDITOR','SUPER_ADMIN'].map(function (r) {
                return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' +
                       r.replace(/_/g, ' ').toLowerCase() + '</option>';
              }).join('') + '</select></td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No users yet', 'Users are created automatically on their first WhatsApp message.')) +
      pager('users', rows.length) +
      '</div>';
    var input = document.getElementById('uq');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchUsers(); });
  });
}
function searchUsers() {
  var input = document.getElementById('uq');
  CACHE.userQuery = input ? input.value.trim() : '';
  // A new search must start at the beginning, not page 4 of the old one.
  OFFSET.users = 0;
  go('users');
}
/**
 * Copy a user id to the clipboard.
 *
 * The id is what the credit grant form asks for, and it is a UUID nobody is
 * going to retype correctly from a screen.
 */
function copyId(id) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(id)
      .then(function () { toast('User id copied.'); })
      .catch(function () { prompt('Copy this user id:', id); });
  } else {
    // Older browsers, and any page not served over https, have no clipboard API.
    prompt('Copy this user id:', id);
  }
}

function setRole(id, role) {
  api('/users/' + id + '/role', { method:'POST', body:{ role:role } })
    .then(function () { toast('Role updated to ' + role.replace(/_/g, ' ').toLowerCase() + '.'); })
    .catch(function (e) { toast(e.message, true); });
}

/* -------------------------------------------------------------------------
   Credits
   ------------------------------------------------------------------------- */
function viewCredits() {
  var off = OFFSET.credits || 0;
  return Promise.all([
    api('/credits?limit=' + PAGE + '&offset=' + off),
    api('/orders?limit=10')
  ]).then(function (results) {
    var data = results[0];
    var orders = results[1];
    CACHE.creditRows = data.entries;

    var t = data.totals;
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Credits</h2><div class="grow"></div>' +
      '<button class="btn sm" onclick="openGrant()">Grant credits</button>' +
      '<button class="btn secondary sm" onclick="exportCsv(CACHE.creditRows, \'credits.csv\')">Export CSV</button></div>' +

      '<div class="note">Every credit movement, newest first. This is the authoritative record — ' +
      'the balances shown on the Users page are a cache of it. Free credits reset daily; ' +
      'purchased and granted credits never expire, and a spend draws down free first.</div>' +

      '<div class="grid kpis" style="margin-bottom:14px">' +
        [
          { label:'Granted',   value:num(t.granted),   foot:'last ' + data.window + ' days' },
          { label:'Spent',     value:num(t.spent),     foot:'last ' + data.window + ' days' },
          { label:'Purchased', value:num(t.purchased),
            foot: orders.gateway.configured ? 'Razorpay configured' : 'no gateway configured' },
          { label:'Refunded',  value:num(t.refunded),  foot:'returned to advocates',
            alert: t.refunded > 0 }
        ].map(function (k) {
          return '<div class="card kpi' + (k.alert ? ' alert' : '') + '">' +
                 '<div class="label">' + esc(k.label) + '</div>' +
                 '<div class="value">' + k.value + '</div>' +
                 '<div class="foot">' + esc(k.foot) + '</div></div>';
        }).join('') +
      '</div>' +

      (orders.uncredited.length
        ? '<div class="card" style="border-color:var(--red)"><h3 style="color:var(--red)">' +
          'Paid but not credited (' + orders.uncredited.length + ')</h3>' +
          '<div class="note">These orders were settled by the gateway and never produced credits. ' +
          'Every other payment failure is visible to the person paying; this one is not.</div>' +
          '<div class="scroll"><table><thead><tr><th>Receipt</th><th>Credits</th><th>Amount</th>' +
          '<th>Payment id</th><th>When</th></tr></thead><tbody>' +
          orders.uncredited.map(function (o) {
            return '<tr><td class="mono">' + esc(o.receipt) + '</td><td>' + num(o.credits) + '</td>' +
              '<td>' + rupees(o.amount_paise) + '</td>' +
              '<td class="mono">' + esc(o.razorpay_payment_id || '—') + '</td>' +
              '<td>' + when(o.created_at) + '</td></tr>';
          }).join('') + '</tbody></table></div></div>'
        : '') +

      '<div class="card">' +
      (data.entries.length
        ? '<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Type</th><th>Bucket</th>' +
          '<th style="text-align:right">Change</th><th style="text-align:right">After</th>' +
          '<th>Reason</th></tr></thead><tbody>' +
          data.entries.map(function (e) {
            var who = e.full_name || e.email || maskPhone(e.phone_number) || '—';
            return '<tr><td style="white-space:nowrap">' + when(e.created_at) + '</td>' +
              '<td class="trunc" title="' + esc(who) + '">' + esc(who) + '</td>' +
              '<td><span class="pill ' + creditPill(e.kind) + '">' +
                esc(e.kind.replace(/_/g, ' ').toLowerCase()) + '</span></td>' +
              '<td class="mono" style="font-size:11px">' + esc(e.bucket.toLowerCase()) + '</td>' +
              '<td style="text-align:right;font-weight:700;color:' +
                (e.delta > 0 ? 'var(--ok)' : 'var(--muted)') + '">' +
                (e.delta > 0 ? '+' : '') + e.delta + '</td>' +
              '<td style="text-align:right" class="mono">' + e.balance_after + '</td>' +
              '<td class="trunc" title="' + esc(e.reason || '') + '">' + esc(e.reason || '—') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No credit movements yet',
                'Entries appear as soon as an advocate is granted or spends credits.')) +
      pager('credits', data.entries.length) +
      '</div>';
  });
}

/** Colour by what the entry means, so the ledger is scannable. */
function creditPill(kind) {
  if (kind === 'SPEND' || kind === 'EXPIRY') return 'neutral';
  if (kind === 'REFUND' || kind === 'ADJUSTMENT') return 'warn';
  return 'ok';
}

/** Paise to rupees. Integer arithmetic only - see migration 0010. */
function rupees(paise) {
  var value = Number(paise || 0);
  return '₹' + (value / 100).toFixed(2);
}

function openGrant() {
  var userId = prompt('User id to grant credits to (copy it from the Users page):');
  if (!userId) return;

  var amount = prompt('How many credits?', '10');
  if (!amount) return;

  var reason = prompt('Reason (shown to the advocate in their credit history):',
                      'Goodwill credit');
  if (reason === null) return;

  // Generated per press, not per retry. A key invented inside api() would be
  // different on every attempt, which is exactly what the key exists to stop.
  var key = 'grant-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  api('/credits/grant', {
    method: 'POST',
    body: { userId: userId.trim(), amount: Number(amount), reason: reason, idempotencyKey: key }
  }).then(function (result) {
    toast(result.applied
      ? 'Granted. Balance is now ' + (result.free + result.paid) + ' credits.'
      : 'Already applied — nothing changed.');
    go('credits');
  }).catch(function (e) { toast(e.message, true); });
}

/* -------------------------------------------------------------------------
   Web chats
   ------------------------------------------------------------------------- */
function viewChats() {
  var off = OFFSET.chats || 0;
  return api('/chats?limit=' + PAGE + '&offset=' + off).then(function (rows) {
    CACHE.chatRows = rows;
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Web chats</h2></div>' +
      '<div class="note">Conversations from the web app. Opening one shows an advocate\'s legal ' +
      'research, so treat it the way you would their case file — it is here for support and for ' +
      'the citation review the auditor role exists to do.</div>' +
      '<div class="card">' +
      (rows.length
        ? '<div class="scroll"><table><thead><tr><th>Last activity</th><th>Who</th><th>Conversation</th>' +
          '<th>Messages</th><th></th></tr></thead><tbody>' +
          rows.map(function (t) {
            var who = t.full_name || t.email || '—';
            return '<tr><td style="white-space:nowrap">' + when(t.last_message_at) + '</td>' +
              '<td class="trunc" title="' + esc(who) + '">' + esc(who) + '</td>' +
              '<td class="trunc" title="' + esc(t.title) + '">' + esc(t.title) + '</td>' +
              '<td>' + num(t.message_count) + '</td>' +
              '<td><button class="btn secondary sm" onclick="openChat(\'' + t.id + '\')">Open</button></td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No web conversations yet',
                'These appear once advocates start using the web app at /app.')) +
      pager('chats', rows.length) +
      '</div>';
  });
}

function openChat(threadId) {
  api('/chats/' + encodeURIComponent(threadId)).then(function (messages) {
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Conversation</h2><div class="grow"></div>' +
      '<button class="btn secondary sm" onclick="go(\'chats\')">← Back to chats</button></div>' +
      '<div class="card">' +
      messages.map(function (m) {
        var isUser = m.role === 'user';
        return '<div style="padding:12px 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;gap:10px;align-items:baseline;margin-bottom:6px">' +
            '<span class="pill ' + (isUser ? 'neutral' : 'info') + '">' + esc(m.role) + '</span>' +
            (m.intent ? '<span class="pill neutral">' +
              esc(String(m.intent).replace(/_/g, ' ').toLowerCase()) + '</span>' : '') +
            (m.credits_charged ? '<span class="pill neutral">' + m.credits_charged + ' credits</span>' : '') +
            (m.guardrail_flagged ? '<span class="pill warn" title="' +
              esc(m.guardrail_reason || '') + '">citation stripped</span>' : '') +
            (m.error_detail ? '<span class="pill bad">error</span>' : '') +
            '<span class="grow"></span><span style="font-size:11px;color:var(--dim)">' +
              when(m.created_at) + '</span>' +
          '</div>' +
          '<div style="white-space:pre-wrap;font-size:13px;line-height:1.6">' + esc(m.content) + '</div>' +
          ((m.citations || []).length
            ? '<div style="margin-top:8px;font-size:11.5px;color:var(--muted)">Citations: ' +
              esc(m.citations.join(' · ')) + '</div>'
            : '') +
          '</div>';
      }).join('') +
      '</div>';
  }).catch(function (e) { toast(e.message, true); });
}

function viewSearches() {
  var flagged = CACHE.flaggedOnly ? 'true' : 'false';
  var off = OFFSET.searches || 0;
  return api('/searches?limit=' + PAGE + '&offset=' + off + '&flagged=' + flagged).then(function (rows) {
    CACHE.searchRows = rows;
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Queries</h2><div class="grow"></div>' +
      '<button class="btn sm ' + (CACHE.flaggedOnly ? '' : 'secondary') + '" onclick="toggleFlagged()">' +
      (CACHE.flaggedOnly ? 'Showing flagged only' : 'Show flagged only') + '</button>' +
      '<button class="btn secondary sm" onclick="exportCsv(CACHE.searchRows, \'queries.csv\')">Export CSV</button></div>' +
      '<div class="note"><strong>Flagged</strong> means the citation validator found a case reference in the ' +
      'answer that does not exist in the corpus, and stripped it before the advocate saw it. ' +
      'A rising count here means the model is straining against the retrieved context.</div>' +
      '<div class="card">' +
      (rows.length
        ? '<div class="scroll"><table><thead><tr><th>When</th><th>Phone</th><th>Query</th><th>Intent</th>' +
          '<th>Cites</th><th>Latency</th><th>Model</th><th></th></tr></thead><tbody>' +
          rows.map(function (s) {
            return '<tr' + (s.guardrail_flagged ? ' style="background:rgba(210,153,34,.06)"' : '') + '>' +
              '<td style="white-space:nowrap">' + when(s.created_at) + '</td>' +
              '<td class="mono">' + esc(maskPhone(s.phone_number)) + '</td>' +
              '<td class="trunc" title="' + esc(s.query_text) + '">' + esc(s.query_text) + '</td>' +
              '<td><span class="pill info">' + esc(s.intent.replace(/_/g, ' ').toLowerCase()) + '</span></td>' +
              '<td>' + (s.citations || []).length + '</td>' +
              '<td>' + num(s.latency_ms) + 'ms</td>' +
              '<td class="mono" style="font-size:11px">' + esc(s.model_used || '—') + '</td>' +
              '<td>' + (s.guardrail_flagged
                ? '<span class="pill warn" title="' + esc(s.guardrail_reason || '') + '">flagged</span>' : '') +
              '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No queries recorded')) +
      pager('searches', rows.length) +
      '</div>';
  });
}
function toggleFlagged() { CACHE.flaggedOnly = !CACHE.flaggedOnly; OFFSET.searches = 0; go('searches'); }

function viewMessages() {
  var off = OFFSET.messages || 0;
  return api('/messages?limit=' + PAGE + '&offset=' + off).then(function (rows) {
    CACHE.messageRows = rows;
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Message log</h2><div class="grow"></div>' +
      '<button class="btn secondary sm" onclick="exportCsv(CACHE.messageRows, \'messages.csv\')">Export CSV</button></div>' +
      '<div class="note">Every inbound and outbound WhatsApp message. This is the first place to look ' +
      'when someone reports the bot did not reply.</div>' +
      '<div class="card">' +
      (rows.length
        ? '<div class="scroll"><table><thead><tr><th>When</th><th>Phone</th><th>Dir</th><th>Type</th>' +
          '<th>Body</th><th>Status</th><th>Error</th></tr></thead><tbody>' +
          rows.map(function (m) {
            return '<tr><td style="white-space:nowrap">' + when(m.created_at) + '</td>' +
              '<td class="mono">' + esc(maskPhone(m.phone_number)) + '</td>' +
              '<td>' + (m.direction === 'INBOUND' ? '↓ in' : '↑ out') + '</td>' +
              '<td class="mono" style="font-size:11px">' + esc(m.message_type) + '</td>' +
              '<td class="trunc" title="' + esc(m.body || '') + '">' + esc(m.body || '—') + '</td>' +
              '<td>' + statusPill(m.status) + '</td>' +
              '<td class="trunc" style="max-width:200px;color:var(--bad)">' + esc(m.error_detail || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('No messages yet')) +
      pager('messages', rows.length) +
      '</div>';
  });
}

function viewCorpus() {
  return api('/corpus').then(function (d) {
    var t = d.totals;
    var pct = t.chunks ? Math.round((t.embedded / t.chunks) * 100) : 0;
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Legal corpus</h2></div>' +
      (pct < 100 && t.chunks
        ? '<div class="note">Only <strong>' + pct + '%</strong> of passages have embeddings. ' +
          'Passages without one are invisible to semantic search — they can only be found by exact keyword. ' +
          'Re-run <code class="mono">npm run ingest</code> with an embedding provider configured.</div>'
        : '') +
      '<div class="grid kpis" style="margin-bottom:14px">' +
      [ { label:'Judgments', value:num(t.judgments), foot:'case law' },
        { label:'Passages',  value:num(t.chunks),    foot:'retrieval units' },
        { label:'Embedded',  value:pct + '%',        foot:num(t.embedded) + ' of ' + num(t.chunks) },
        { label:'Statutes',  value:num(t.statutes),  foot:'bare act sections' }
      ].map(function (k) {
        return '<div class="card kpi"><div class="label">' + k.label + '</div>' +
               '<div class="value">' + k.value + '</div><div class="foot">' + k.foot + '</div></div>';
      }).join('') + '</div>' +
      '<div class="card"><h3>By court</h3><p class="hint">Where your case law comes from.</p>' +
      (d.byCourt.length
        ? '<div class="scroll"><table><thead><tr><th>Court</th><th>Judgments</th><th>Passages</th>' +
          '<th>Embedded</th></tr></thead><tbody>' +
          d.byCourt.map(function (c) {
            var p = c.chunks ? Math.round((c.embedded / c.chunks) * 100) : 0;
            return '<tr><td>' + esc(c.court) + '</td><td>' + num(c.judgments) + '</td>' +
              '<td>' + num(c.chunks) + '</td>' +
              '<td><span class="pill ' + (p === 100 ? 'ok' : p > 0 ? 'warn' : 'bad') + '">' + p + '%</span></td></tr>';
          }).join('') + '</tbody></table></div>'
        : empty('Corpus is empty', 'Load judgments with: npm run ingest -- --file data/samples/judgments.sample.jsonl')) +
      '</div>';
  });
}

function viewAudit() {
  return api('/audit').then(function (rows) {
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Audit log</h2></div>' +
      '<div class="note">Configuration changes. Secret <em>values</em> are never recorded — ' +
      'only the fact that the key changed, and by whom.</div>' +
      '<div class="card">' +
      (rows.length
        ? '<table><thead><tr><th>When</th><th>Setting</th><th>Action</th><th>New value</th><th>By</th></tr></thead><tbody>' +
          rows.map(function (a) {
            return '<tr><td style="white-space:nowrap">' + when(a.changed_at) + '</td>' +
              '<td class="mono">' + esc(a.key) + '</td>' +
              '<td><span class="pill ' + (a.action === 'CLEAR' ? 'warn' : 'info') + '">' + esc(a.action) + '</span></td>' +
              '<td class="mono trunc">' + esc(a.new_preview || '—') + '</td>' +
              '<td>' + esc(a.changed_by) + '</td></tr>';
          }).join('') + '</tbody></table>'
        : empty('No configuration changes yet')) +
      '</div>';
  });
}

/* =========================================================================
   Settings
   ========================================================================= */
function viewSettings() {
  return api('/settings').then(function (d) {
    var byKey = {};
    d.values.forEach(function (v) { byKey[v.key] = v; });

    var groups = d.groups.map(function (g) {
      var fields = d.definitions.filter(function (def) { return def.group === g.id; })
        .map(function (def) { return renderField(def, byKey[def.key]); }).join('');

      var extra = '';
      if (g.id === 'whatsapp') {
        extra =
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">' +
          '<button class="btn secondary sm" type="button" onclick="testWhatsApp()">Test connection</button>' +
          '<button class="btn secondary sm" type="button" onclick="sendTestMessage()">Send test message</button>' +
          '</div><div id="waTest"></div>';
      }

      return '<div class="card" style="margin-bottom:14px">' +
        '<h3>' + esc(g.title) + '</h3><p class="hint">' + esc(g.description) + '</p>' +
        fields + extra + '</div>';
    }).join('');

    var stale = d.values.filter(function (v) { return v.source === 'panel'; });

    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Settings</h2></div>' +
      '<div class="note"><strong>This page is read-only.</strong> Every setting is configured ' +
      'through environment variables on your hosting platform — change one in Render and redeploy. ' +
      'This is the record of what the running service is actually using.</div>' +
      '<div class="note alert"><strong>Why nothing is editable.</strong> A value saved here used to ' +
      '<em>override</em> the environment, so updating a token in Render changed nothing and the bot ' +
      'kept using the dead one. The operational settings had a quieter version of the same fault: the ' +
      'AI, retrieval and quota services read the environment at startup and never read this table, so ' +
      'those fields saved and displayed a value nothing would ever act on. One source of truth — the ' +
      'hosting dashboard.</div>' +
      (stale.length
        ? '<div class="note alert"><strong>' + stale.length + ' setting' +
          (stale.length === 1 ? ' is' : 's are') + ' still stored in the database</strong> from before ' +
          'this policy, and still override the environment. Click <em>Reset</em> on each to finish ' +
          'the migration: ' +
          stale.map(function (v) { return '<code class="mono">' + esc(v.key) + '</code>'; }).join(', ') +
          '</div>'
        : '') +
      groups;
  });
}

/**
 * One read-only row per setting.
 *
 * Nothing here is editable. Rendering an input would be a lie twice over: the
 * server refuses every write, and the services that consume configuration read
 * the environment at boot rather than this table, so even a stored value would
 * not have been read. What an operator actually needs from this page is which
 * settings are set, what they are set to, and where the value came from.
 *
 * The one exception is Reset, and only for a value still coming from the
 * database. Those rows predate the env-only policy and still win over the
 * environment, so clearing them is how you finish the migration.
 */
function renderField(def, state) {
  state = state || {};
  var secret = def.type === 'secret';
  var set = state.isSet;
  var stale = state.source === 'panel';

  var shown;
  if (!set) {
    shown = '<span class="pill bad">not set</span>';
  } else if (secret) {
    shown = '<span class="pill ok">set</span> <span class="mono">' + esc(state.hint || '') + '</span>';
  } else {
    shown = '<span class="mono">' + esc(state.value) + '</span>' +
            ' <span class="set-state on">● ' + (stale ? 'db' : 'env') + '</span>';
  }

  return '<div class="field cred">' +
    '<div class="cred-row">' +
      '<div class="cred-name">' + esc(def.label) +
        '<code class="mono cred-key">' + esc(def.key) + '</code></div>' +
      '<div class="cred-state">' + shown +
        (stale
          ? ' <span class="pill warn">stored in the database — overrides the environment</span>' +
            '<button class="btn secondary sm" type="button" style="margin-left:8px" ' +
            'onclick="clearSetting(\'' + def.key + '\')">Reset</button>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="help">' + esc(def.help) + '</div>' +
    (!set && def.requiredFor
      ? '<div class="help" style="color:var(--red)">Required for ' + esc(def.requiredFor) + '.</div>'
      : '') +
    '</div>';
}

function clearSetting(key) {
  if (!confirm('Reset ' + key + ' to its environment value?\n\n' +
               'This deletes the stored database value. The environment variable takes over.')) return;
  api('/settings/' + encodeURIComponent(key), { method:'DELETE' })
    .then(function () { toast(key + ' reset to the environment value.'); go('settings'); })
    .catch(function (err) { toast(err.message, true); });
}

function testWhatsApp() {
  var box = document.getElementById('waTest');
  box.innerHTML = '<div class="loading">Contacting Meta…</div>';
  api('/settings/whatsapp/test', { method:'POST', body:{} }).then(function (r) {
    box.innerHTML =
      '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">' +
      '<span class="pill ' + (r.ok ? 'ok' : 'bad') + '">' +
      (r.ok ? 'Connection OK' : 'Not working') + '</span>' +
      (r.number && r.number.displayPhoneNumber
        ? ' <span class="pill neutral">' + esc(r.number.displayPhoneNumber) +
          (r.number.verifiedName ? ' · ' + esc(r.number.verifiedName) : '') + '</span>' : '') +
      '<ul class="checks">' + r.checks.map(function (c) {
        return '<li><span style="color:var(--' + (c.ok ? 'ok' : 'bad') + ')">' +
          (c.ok ? '✓' : '✗') + '</span><div><div>' + esc(c.name) + ' — ' + esc(c.detail) + '</div>' +
          (c.fix ? '<div class="fix">' + esc(c.fix) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul>' +
      '<div class="help" style="margin-top:10px">Webhook URL to register with Meta:<br>' +
      '<code class="mono">' + esc(r.webhookUrl) + '</code></div></div>';
  }).catch(function (err) {
    box.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
  });
}

function sendTestMessage() {
  var to = prompt('Send a test message to which number?\n\n' +
                  'International format, digits only (e.g. 919876543210).\n\n' +
                  'Note: WhatsApp only allows free-form messages within 24 hours of that ' +
                  'number last messaging your bot.');
  if (!to) return;
  api('/settings/whatsapp/send-test', { method:'POST', body:{ to:to } }).then(function (r) {
    if (r.ok) toast('Sent. Check the phone.');
    else toast((r.error || 'Send failed') + (r.hint ? ' — ' + r.hint : ''), true);
  }).catch(function (err) { toast(err.message, true); });
}

/* =========================================================================
   Start
   ========================================================================= */
(function init() {
  var saved = localStorage.getItem('vs_theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  if (TOKEN) {
    // Resume the session if the stored token is still valid. A session JWT can
    // expire while the tab is closed, so this must be checked, not assumed.
    api('/stats').then(boot).catch(function () {
      sessionStorage.removeItem('vs_admin_token');
      sessionStorage.removeItem('vs_admin_email');
      TOKEN = ''; ADMIN_EMAIL = '';
      document.getElementById('login').style.display = 'flex';
      initLoginForm();
    });
  } else {
    document.getElementById('login').style.display = 'flex';
    initLoginForm();
  }
})();
</script>
</body>
</html>`;
