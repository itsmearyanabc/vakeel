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
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Vakeel Saathi — Control Panel</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --panel-2:#1c2128; --border:#30363d;
    --text:#e6edf3; --muted:#8b949e; --dim:#6e7681;
    --accent:#4c8dff; --accent-dim:#1f6feb;
    --ok:#3fb950; --warn:#d29922; --bad:#f85149;
    --saffron:#ff9933; --green:#138808;
    --radius:10px; --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  :root[data-theme="light"] {
    --bg:#f6f8fa; --panel:#ffffff; --panel-2:#f0f3f6; --border:#d0d7de;
    --text:#1f2328; --muted:#59636e; --dim:#818b98;
    --accent:#0969da; --accent-dim:#0550ae;
    --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--accent)}
  button{font:inherit;cursor:pointer}

  /* ---------- login ---------- */
  #login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .login-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
              padding:32px;width:100%;max-width:420px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .brand-mark{width:32px;height:32px;border-radius:8px;flex:0 0 auto;
    background:linear-gradient(135deg,var(--saffron),var(--green));
    display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:15px}
  .brand h1{font-size:17px;margin:0;font-weight:650}
  .sub{color:var(--muted);font-size:13px;margin:0 0 22px}
  label{display:block;font-size:12px;font-weight:600;color:var(--muted);
        margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
  input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--border);
    color:var(--text);padding:9px 11px;border-radius:7px;font:inherit;outline:none}
  input:focus,select:focus,textarea:focus{border-color:var(--accent)}
  .btn{background:var(--accent);color:#fff;border:none;padding:9px 16px;
       border-radius:7px;font-weight:600}
  .btn:hover{background:var(--accent-dim)}
  .btn.secondary{background:transparent;border:1px solid var(--border);color:var(--text)}
  .btn.secondary:hover{background:var(--panel-2)}
  .btn.danger{background:var(--bad)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.sm{padding:5px 10px;font-size:12px}

  /* ---------- shell ---------- */
  #app{display:none;grid-template-columns:216px 1fr;min-height:100vh}
  aside{background:var(--panel);border-right:1px solid var(--border);
        padding:16px 12px;display:flex;flex-direction:column;gap:3px}
  aside .brand{padding:6px 8px 14px}
  nav button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;
    background:none;border:none;color:var(--muted);padding:8px 10px;
    border-radius:7px;font-size:13.5px;font-weight:500}
  nav button:hover{background:var(--panel-2);color:var(--text)}
  nav button.active{background:var(--accent);color:#fff}
  nav button .badge{margin-left:auto;background:var(--bad);color:#fff;
    border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700}
  nav button.active .badge{background:rgba(255,255,255,.25)}
  .spacer{flex:1}
  main{padding:22px 26px;overflow-x:hidden;min-width:0}
  .head{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
  .head h2{margin:0;font-size:19px;font-weight:650}
  .head .grow{flex:1}

  /* ---------- pieces ---------- */
  .card{background:var(--panel);border:1px solid var(--border);
        border-radius:var(--radius);padding:16px;min-width:0}
  .card h3{margin:0 0 3px;font-size:13.5px;font-weight:650}
  .card .hint{color:var(--muted);font-size:12px;margin:0 0 14px}
  .grid{display:grid;gap:14px}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(158px,1fr))}
  .kpi .label{color:var(--muted);font-size:11.5px;text-transform:uppercase;
              letter-spacing:.05em;font-weight:600}
  .kpi .value{font-size:26px;font-weight:680;margin-top:5px;letter-spacing:-.02em}
  .kpi .foot{color:var(--dim);font-size:11.5px;margin-top:3px}
  .two{grid-template-columns:1.65fr 1fr}
  @media(max-width:1080px){.two{grid-template-columns:1fr}}
  @media(max-width:760px){#app{grid-template-columns:1fr}aside{display:none}}

  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:600;font-size:11.5px;
     text-transform:uppercase;letter-spacing:.04em;
     padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
  tbody tr:hover{background:var(--panel-2)}
  tbody tr:last-child td{border-bottom:none}
  .scroll{overflow-x:auto;margin:0 -16px;padding:0 16px}
  .mono{font-family:var(--mono);font-size:12px}
  .trunc{max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;
        font-weight:650;white-space:nowrap}
  .pill.ok{background:rgba(63,185,80,.16);color:var(--ok)}
  .pill.warn{background:rgba(210,153,34,.16);color:var(--warn)}
  .pill.bad{background:rgba(248,81,73,.16);color:var(--bad)}
  .pill.neutral{background:var(--panel-2);color:var(--muted)}
  .pill.info{background:rgba(76,141,255,.16);color:var(--accent)}

  .empty{text-align:center;padding:40px 20px;color:var(--muted)}
  .empty .big{font-size:30px;margin-bottom:8px;opacity:.5}
  .err{background:rgba(248,81,73,.1);border:1px solid var(--bad);color:var(--bad);
       padding:10px 13px;border-radius:7px;margin-bottom:14px;font-size:13px}
  .note{background:var(--panel-2);border-left:3px solid var(--accent);
        padding:11px 14px;border-radius:0 7px 7px 0;margin-bottom:16px;
        color:var(--muted);font-size:12.5px}
  .note strong{color:var(--text)}

  /* ---------- settings ---------- */
  .field{margin-bottom:16px}
  .field .help{color:var(--muted);font-size:12px;margin-top:5px;line-height:1.45}
  .field .row{display:flex;gap:8px;align-items:center}
  .field .row input,.field .row select{flex:1;min-width:0}
  .set-state{font-size:11px;font-weight:650;white-space:nowrap}
  .set-state.on{color:var(--ok)}
  .set-state.off{color:var(--dim)}
  .sticky-save{position:sticky;bottom:0;background:var(--panel);
    border-top:1px solid var(--border);padding:13px 16px;margin:16px -16px -16px;
    display:flex;gap:10px;align-items:center;border-radius:0 0 var(--radius) var(--radius)}
  .checks{list-style:none;padding:0;margin:12px 0 0}
  .checks li{display:flex;gap:9px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px}
  .checks li:last-child{border-bottom:none}
  .checks .fix{color:var(--muted);font-size:12px;margin-top:3px}
  .toast{position:fixed;bottom:20px;right:20px;background:var(--panel);
    border:1px solid var(--border);border-left:3px solid var(--ok);
    padding:12px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);
    font-size:13px;z-index:50;max-width:380px}
  .toast.bad{border-left-color:var(--bad)}
  .loading{color:var(--muted);padding:26px;text-align:center;font-size:13px}
  svg{display:block;max-width:100%}
  .legend{display:flex;flex-wrap:wrap;gap:9px;margin-top:12px;font-size:12px}
  .legend span{display:flex;align-items:center;gap:5px;color:var(--muted)}
  .dot{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
</style>
</head>
<body>

<!-- ============================ LOGIN ============================ -->
<div id="login">
  <form class="login-card" onsubmit="doLogin(event)">
    <div class="brand">
      <div class="brand-mark">VS</div>
      <h1>Vakeel Saathi</h1>
    </div>
    <p class="sub">Control panel — sign in with your admin token.</p>
    <div id="loginErr"></div>
    <div class="field">
      <label for="token">Admin token</label>
      <input id="token" type="password" placeholder="Your JWT_SECRET value" autocomplete="current-password" required>
      <p class="help">This is the <code class="mono">JWT_SECRET</code> environment variable
        set on the Railway <strong>web</strong> service. It is held in this tab only
        (sessionStorage) and cleared when you close it.</p>
    </div>
    <button class="btn" style="width:100%" type="submit">Sign in</button>
  </form>
</div>

<!-- ============================ APP ============================ -->
<div id="app">
  <aside>
    <div class="brand">
      <div class="brand-mark">VS</div>
      <h1>Vakeel Saathi</h1>
    </div>
    <nav id="nav"></nav>
    <div class="spacer"></div>
    <button class="btn secondary sm" onclick="toggleTheme()">Toggle theme</button>
    <button class="btn secondary sm" style="margin-top:6px" onclick="logout()">Sign out</button>
  </aside>
  <main id="main"><div class="loading">Loading…</div></main>
</div>

<script>
/* =========================================================================
   State + transport
   ========================================================================= */
var TOKEN = sessionStorage.getItem('vs_admin_token') || '';
var VIEW  = 'dashboard';
var CACHE = {};

var VIEWS = [
  { id:'dashboard',     label:'Dashboard',     icon:'◳' },
  { id:'verifications', label:'Verifications', icon:'✓' },
  { id:'users',         label:'Users',         icon:'●' },
  { id:'searches',      label:'Queries',       icon:'▤' },
  { id:'messages',      label:'Messages',      icon:'✉' },
  { id:'corpus',        label:'Corpus',        icon:'▦' },
  { id:'settings',      label:'Settings',      icon:'⚙' },
  { id:'audit',         label:'Audit log',     icon:'⌚' }
];

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

function doLogin(e) {
  e.preventDefault();
  var value = document.getElementById('token').value.trim();
  if (!value) return;
  TOKEN = value;
  document.getElementById('loginErr').innerHTML = '';
  // Cheapest authenticated endpoint, purely to validate the token.
  api('/stats').then(function () {
    sessionStorage.setItem('vs_admin_token', TOKEN);
    boot();
  }).catch(function (err) {
    TOKEN = '';
    document.getElementById('loginErr').innerHTML =
      '<div class="err">' + esc(err.message) + '</div>';
  });
}

function logout() {
  sessionStorage.removeItem('vs_admin_token');
  TOKEN = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
}

function boot() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'grid';
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
           '<span>' + v.icon + '</span>' + esc(v.label) + badge + '</button>';
  }).join('');
}

function go(view) {
  VIEW = view;
  renderNav(CACHE.pending);
  var main = document.getElementById('main');
  main.innerHTML = '<div class="loading">Loading…</div>';
  var fn = ({
    dashboard: viewDashboard, verifications: viewVerifications, users: viewUsers,
    searches: viewSearches, messages: viewMessages, corpus: viewCorpus,
    settings: viewSettings, audit: viewAudit
  })[view];
  Promise.resolve()
    .then(fn)
    .catch(function (err) { main.innerHTML = '<div class="err">' + esc(err.message) + '</div>'; });
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

var SLICE_COLOURS = ['#4c8dff','#3fb950','#d29922','#f85149','#a371f7','#39c5cf','#ff9933','#db61a2'];

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
    if (c.judgments === 0) {
      warnings.push('The judgment corpus is empty — precedent search cannot return anything. ' +
                    'Run <code class="mono">npm run ingest</code> to load case law.');
    }

    var kpis = [
      { label:'Total users',     value:num(p.totalUsers),   foot:num(p.verifiedUsers) + ' verified' },
      { label:'Active (14d)',    value:num(p.activeUsers),  foot:'distinct advocates' },
      { label:'Queries (14d)',   value:num(p.queries),      foot:'answered' },
      { label:'Avg latency',     value:p.avgLatencyMs ? p.avgLatencyMs + 'ms' : '—', foot:'target < 2500ms' },
      { label:'Guardrail hits',  value:num(p.guardrailFlagged), foot:'ungrounded citations blocked' },
      { label:'Corpus',          value:num(c.judgments),    foot:num(c.chunks) + ' chunks · ' + embedPct + '% embedded' }
    ];

    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Dashboard</h2><div class="grow"></div>' +
      '<span class="pill ' + (d.whatsapp.configured ? 'ok' : 'bad') + '">WhatsApp ' +
      (d.whatsapp.configured ? 'connected' : 'not connected') + '</span>' +
      '<span class="pill ' + (d.providers.synthesis === 'mock' ? 'warn' : 'ok') + '">AI: ' +
      esc(d.providers.synthesis) + '</span></div>' +

      warnings.map(function (w) { return '<div class="note">' + w + '</div>'; }).join('') +

      '<div class="grid kpis" style="margin-bottom:14px">' +
        kpis.map(function (k) {
          return '<div class="card kpi"><div class="label">' + esc(k.label) + '</div>' +
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

        '<div class="card"><h3>Message delivery</h3>' +
        '<p class="hint">Outbound failures usually mean an expired token or the 24-hour window.</p>' +
        (d.messages.length
          ? '<table><tbody>' + d.messages.map(function (m) {
              return '<tr><td>' + esc(m.direction) + '</td><td>' + statusPill(m.status) + '</td>' +
                     '<td style="text-align:right">' + num(m.count) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : empty('No messages yet')) +
        '</div>' +
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
  return api('/users?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '')).then(function (rows) {
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Users</h2><div class="grow"></div>' +
      '<input id="uq" placeholder="Search name or number…" style="max-width:250px" value="' + esc(q) + '">' +
      '<button class="btn sm" onclick="searchUsers()">Search</button></div>' +
      '<div class="card">' +
      (rows.length
        ? '<div class="scroll"><table><thead><tr><th>Phone</th><th>Name</th><th>Role</th>' +
          '<th>Status</th><th>Lang</th><th>Today</th><th>Last active</th><th></th></tr></thead><tbody>' +
          rows.map(function (u) {
            return '<tr><td class="mono">' + esc(maskPhone(u.phone_number)) + '</td>' +
              '<td>' + esc(u.full_name || '—') + '</td>' +
              '<td><span class="pill neutral">' + esc(u.role.replace(/_/g, ' ').toLowerCase()) + '</span></td>' +
              '<td>' + statusPill(u.verification_status) + '</td>' +
              '<td class="mono">' + esc(u.preferred_language) + '</td>' +
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
      '</div>';
    var input = document.getElementById('uq');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchUsers(); });
  });
}
function searchUsers() {
  CACHE.userQuery = document.getElementById('uq').value.trim();
  go('users');
}
function setRole(id, role) {
  api('/users/' + id + '/role', { method:'POST', body:{ role:role } })
    .then(function () { toast('Role updated to ' + role.replace(/_/g, ' ').toLowerCase() + '.'); })
    .catch(function (e) { toast(e.message, true); });
}

function viewSearches() {
  var flagged = CACHE.flaggedOnly ? 'true' : 'false';
  return api('/searches?limit=100&flagged=' + flagged).then(function (rows) {
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Queries</h2><div class="grow"></div>' +
      '<button class="btn sm ' + (CACHE.flaggedOnly ? '' : 'secondary') + '" onclick="toggleFlagged()">' +
      (CACHE.flaggedOnly ? 'Showing flagged only' : 'Show flagged only') + '</button></div>' +
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
      '</div>';
  });
}
function toggleFlagged() { CACHE.flaggedOnly = !CACHE.flaggedOnly; go('searches'); }

function viewMessages() {
  return api('/messages?limit=100').then(function (rows) {
    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Message log</h2></div>' +
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

    document.getElementById('main').innerHTML =
      '<div class="head"><h2>Settings</h2></div>' +
      '<div class="note">Changes take effect within seconds on both the web and worker processes — ' +
      '<strong>no redeploy needed</strong>. Values saved here override the Railway environment variables. ' +
      'Clearing a field reverts it to the environment value. ' +
      '<strong>Secrets are write-only</strong>: leave a secret blank to keep the current one.</div>' +
      '<form id="setForm" onsubmit="saveSettings(event)">' + groups +
      '<div class="sticky-save"><button class="btn" type="submit">Save changes</button>' +
      '<span class="hint" style="margin:0">Only fields you edit are written.</span></div></form>';
  });
}

function renderField(def, state) {
  state = state || {};
  var id = 'set_' + def.key;
  var control;

  if (def.type === 'select') {
    control = '<select id="' + id + '" data-key="' + def.key + '">' +
      (def.options || []).map(function (o) {
        return '<option value="' + esc(o.value) + '"' +
               (state.value === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select>';
  } else if (def.type === 'secret') {
    // Never render the value. The placeholder tells the operator whether one is
    // already stored without disclosing it.
    control = '<input id="' + id + '" data-key="' + def.key + '" type="password" ' +
      'autocomplete="new-password" placeholder="' +
      (state.isSet ? esc(state.hint || 'stored — leave blank to keep') : esc(def.placeholder || '')) + '">';
  } else if (def.type === 'number') {
    control = '<input id="' + id + '" data-key="' + def.key + '" type="number" ' +
      (def.min !== undefined ? 'min="' + def.min + '" ' : '') +
      (def.max !== undefined ? 'max="' + def.max + '" ' : '') +
      'value="' + esc(state.value || '') + '">';
  } else {
    control = '<input id="' + id + '" data-key="' + def.key + '" type="text" ' +
      'placeholder="' + esc(def.placeholder || '') + '" value="' + esc(state.value || '') + '">';
  }

  var stateLabel = state.isSet
    ? '<span class="set-state on">● set' + (state.overridden ? ' (panel)' : ' (env)') + '</span>'
    : '<span class="set-state off">○ unset</span>';

  var clearBtn = state.overridden
    ? '<button class="btn secondary sm" type="button" onclick="clearSetting(\'' + def.key + '\')">Reset</button>'
    : '';

  var warn = (!state.isSet && def.requiredFor)
    ? '<div class="help" style="color:var(--warn)">Required for ' + esc(def.requiredFor) + '.</div>' : '';

  return '<div class="field"><label for="' + id + '">' + esc(def.label) + '</label>' +
    '<div class="row">' + control + stateLabel + clearBtn + '</div>' +
    '<div class="help">' + esc(def.help) + '</div>' + warn + '</div>';
}

function saveSettings(e) {
  e.preventDefault();
  var payload = {};
  document.querySelectorAll('#setForm [data-key]').forEach(function (el) {
    var v = el.value.trim();
    // Blank secrets are omitted entirely — the server treats a blank secret as
    // "keep the existing value", but sending nothing is clearer.
    if (v !== '') payload[el.getAttribute('data-key')] = v;
  });

  api('/settings', { method:'POST', body:payload })
    .then(function (r) {
      toast('Saved ' + r.applied.length + ' setting' + (r.applied.length === 1 ? '' : 's') + '.');
      go('settings');
    })
    .catch(function (err) { toast(err.message, true); });
}

function clearSetting(key) {
  if (!confirm('Reset ' + key + ' to its environment value?')) return;
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
    api('/stats').then(boot).catch(logout);
  } else {
    document.getElementById('login').style.display = 'flex';
  }
})();
</script>
</body>
</html>`;
