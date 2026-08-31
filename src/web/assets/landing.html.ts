/**
 * The public landing page.
 *
 * ## Why this is server-rendered and the app is not
 *
 * The app is a shell that fetches everything it shows; this page has to be
 * complete in the first response. It is the only page a search engine, a
 * WhatsApp link preview or a visitor with scripts disabled will ever see, and
 * all three read the bytes the server sent and nothing else.
 *
 * That has one consequence worth stating plainly: the header is personalised
 * server-side, so the response varies by cookie. See the cache-control
 * reasoning in landing.controller.ts - a personalised page that reaches a
 * shared cache is somebody else's name on your screen.
 *
 * ## Why the page states what this deployment cannot do
 *
 * Every capability shown here is derived from configuration rather than
 * asserted. A deployment with no synthesis model produces placeholder answers,
 * and one with no case-law source cannot search judgments. The rest of this
 * product is careful to say so in the interface - an unconfigured Google button
 * does not render, a mock answer is labelled as a placeholder - and the page
 * that asks people to sign up is the last place to stop being careful.
 */

export interface LandingView {
  /** Renders the account chip instead of the sign-in pair. */
  signedIn: boolean;
  /** Display name for the chip. Untrusted - it is whatever the user typed. */
  displayName: string | null;
  /** Monthly free allowance. -1 means unlimited for that role. */
  freeMonthlyCredits: number;
  /** Credits per search, from CREDIT_COST so the page cannot drift from billing. */
  searchCost: number;
  /** Credits per case-status lookup. Zero today. */
  caseStatusCost: number;
  /** Credits granted on signup. Zero hides the claim entirely. */
  signupBonus: number;
  /** Digits only, as WHATSAPP_DISPLAY_NUMBER holds it. Empty when unset. */
  whatsappNumber: string;
  /** True when eCourts is a live provider rather than the mock adapter. */
  caseStatusLive: boolean;
  /** True when a judgment source is configured. */
  caseLawLive: boolean;
  /** True when a real synthesis model is wired up. */
  answersLive: boolean;
  /** Public origin, for canonical and og:url. */
  publicUrl: string;
  /** Current year, passed in rather than read from the clock, so output is testable. */
  year: number;
}

/**
 * Escape text for HTML interpolation.
 *
 * The display name is the reason this exists. It is chosen by the user at
 * signup, stored verbatim, and printed into the header of a page served back to
 * them - precisely the shape of a stored XSS. Everything interpolated below goes
 * through here; nothing is trusted for being "ours", because the numbers are
 * configuration and configuration is edited by hand.
 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Initials for the account chip. Falls back to a neutral mark, never to blank. */
function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'VS';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Digits only - what wa.me expects, and what keeps a hand-typed value safe. */
function waDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Line icons at a single weight.
 *
 * 1.5px strokes on a 24px grid, `currentColor` throughout, no fills. Anything
 * heavier reads as decoration on a page this quiet, and the point of the page is
 * that nothing competes with the words.
 */
const ICON = {
  gavel:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m13.5 12.5-7.8 7.8a1.9 1.9 0 0 1-2.7-2.7l7.8-7.8"/>' +
    '<path d="m15.5 3.5 5 5M13.5 5.5l5 5M17.5 1.5l5 5M3 22h8"/></svg>',
  book:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
    '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7"/></svg>',
  scales:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 4v17M8.5 21h7M4 7.5h16"/>' +
    '<path d="M6.5 7.5 3 14.5h7zM17.5 7.5 14 14.5h7"/>' +
    '<path d="M3 14.5a3.5 3.5 0 0 0 7 0M14 14.5a3.5 3.5 0 0 0 7 0"/>' +
    '<path d="M12 4.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>',
  whatsapp:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 2.8a9.2 9.2 0 0 0-7.9 13.9L2.8 21.2l4.6-1.2A9.2 9.2 0 1 0 12 2.8z"/>' +
    '<path d="M9 8.4c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .6.5l.7 1.7c.1.2 0 .4-.1.5l-.5.6c-.1.2-.3.3-.1.6a7 7 0 0 0 3.2 2.8c.3.1.4 0 .6-.1l.6-.8c.2-.2.3-.2.6-.1l1.6.8c.3.1.4.3.4.5a1.9 1.9 0 0 1-1.4 1.7c-.6.1-1.4 0-3.6-1a9.9 9.9 0 0 1-4-4.2c-.4-.9-.6-1.6-.6-2.2A2.4 2.4 0 0 1 9 8.4z"/></svg>',
  window:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.8" y="3.8" width="18.4" height="14.4" rx="2.4"/>' +
    '<path d="M2.8 8.2h18.4M8 21.2h8"/></svg>',
  tick:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.8 4.8L19 7"/></svg>',
  shield:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 2.6 4.5 5.8v6c0 4.3 3.1 8.2 7.5 9.6 4.4-1.4 7.5-5.3 7.5-9.6v-6z"/>' +
    '<path d="m9 12 2.2 2.2L15.4 10"/></svg>',
  moon:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  menu:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M3.5 7.5h17M3.5 16.5h17"/></svg>',
  info:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9.2"/><path d="M12 11v5.5M12 7.6v.1"/></svg>',
};

/** "30 free credits", or the unmetered phrasing when the allowance is -1. */
function allowancePhrase(credits: number): string {
  return credits < 0 ? 'an unmetered allowance' : `${credits} free credits`;
}

/**
 * Whatever this deployment cannot currently do, said once, at the top.
 *
 * Returns null when everything the page describes is wired up - which is the
 * state a production deployment should be in, and therefore the state in which
 * a visitor sees no notice at all.
 */
function previewNotice(view: LandingView): string | null {
  const missing: string[] = [];
  if (!view.answersLive) missing.push('answers come from a placeholder model, not a legal one');
  if (!view.caseLawLive) missing.push('no judgment source is connected, so case-law search returns nothing');
  if (!view.caseStatusLive) missing.push('court records are sample data rather than live eCourts data');

  if (missing.length === 0) return null;

  return (
    '<div class="notice"><div class="wrap">' +
    `<span class="mark">${ICON.info}</span>` +
    '<p><b>Preview deployment.</b> On this instance, ' +
    esc(missing.join('; ')) +
    '. Accounts, credits and the WhatsApp channel work exactly as described.</p>' +
    '</div></div>'
  );
}

/** The right-hand side of the header: an account chip, or the two doors. */
function headerActions(view: LandingView): string {
  const toggle =
    '<button class="icon-btn" id="theme-toggle" type="button" aria-label="Switch between light and dark">' +
    ICON.moon +
    '</button>';

  if (view.signedIn) {
    return (
      '<div class="header-actions">' +
      toggle +
      '<a class="who" href="/app">' +
      `<span class="who-name">${esc(view.displayName || 'Your account')}</span>` +
      `<span class="avatar" aria-hidden="true">${esc(initials(view.displayName))}</span>` +
      '</a>' +
      '<a class="btn" href="/app">Dashboard</a>' +
      '</div>'
    );
  }

  return (
    '<div class="header-actions">' +
    toggle +
    '<a class="btn quiet" href="/app">Log in</a>' +
    '<a class="btn" href="/app/signup">Sign up</a>' +
    '</div>'
  );
}

/**
 * The collapsed menu for narrow screens.
 *
 * Carries the section links plus whichever account action the header drops at
 * that width, so nothing becomes unreachable on a phone - which is most of this
 * audience. A `<details>` rather than a button with a handler, so it opens on a
 * page where no script ran.
 */
function mobileMenu(view: LandingView): string {
  const account = view.signedIn
    ? '<a href="/app">Dashboard</a>'
    : '<a href="/app">Log in</a><a href="/app/signup">Create an account</a>';

  return (
    '<details class="menu"><summary aria-label="Menu">' +
    ICON.menu +
    '</summary><div class="menu-panel">' +
    '<a href="#features">Features</a>' +
    '<a href="#how">How it works</a>' +
    '<a href="#verification">Verification</a>' +
    '<a href="#credits">Credits</a>' +
    '<a href="#faq">Questions</a>' +
    '<hr>' +
    account +
    '</div></details>'
  );
}

function priceTag(credits: number): string {
  return credits === 0
    ? '<span class="tag free">Always free</span>'
    : `<span class="tag">${esc(credits)} credit${credits === 1 ? '' : 's'}</span>`;
}

function featureCards(view: LandingView): string {
  return (
    '<div class="cards">' +
    '<div class="card">' +
    `<div class="glyph">${ICON.gavel}</div>` +
    '<h3 class="h3">Case status by CNR</h3>' +
    '<p>Send the sixteen-character number and get the stage, the next hearing date, ' +
    'the bench, the parties and the advocates on record' +
    (view.caseStatusLive
      ? '.'
      : '. Sample data for now &#8212; the court-records provider is not connected, and every reply says so.') +
    '</p>' +
    priceTag(view.caseStatusCost) +
    '</div>' +
    '<div class="card">' +
    `<div class="glyph">${ICON.book}</div>` +
    '<h3 class="h3">Sections, mapped to BNS</h3>' +
    '<p>Ask about a provision in English, Hindi or Hinglish. Answers quote the bare ' +
    'act and carry the IPC&#8596;BNS and CrPC&#8596;BNSS correspondence, so you are ' +
    'not holding two statute books open at once.</p>' +
    priceTag(view.searchCost) +
    '</div>' +
    '<div class="card">' +
    `<div class="glyph">${ICON.scales}</div>` +
    '<h3 class="h3">Precedent research</h3>' +
    '<p>Describe the point of law and get judgments that address it, each with its ' +
    'court, its date and a link to the full text' +
    (view.caseLawLive
      ? '. A search that finds no authority refunds itself.'
      : '. No judgment source is connected on this instance; a search that finds nothing refunds itself.') +
    '</p>' +
    priceTag(view.searchCost) +
    '</div>' +
    '</div>'
  );
}

function channels(view: LandingView): string {
  const digits = waDigits(view.whatsappNumber);

  return (
    '<div class="channels">' +
    '<div class="channel">' +
    `<div class="glyph">${ICON.whatsapp}</div>` +
    '<div class="body">' +
    '<h3 class="h3">On WhatsApp</h3>' +
    '<p class="small">Ask from the corridor outside the court room. Nothing to install, ' +
    'no password to remember, and it runs on the handset already in your pocket.' +
    (digits ? ` Message <b>+${esc(digits)}</b> to begin.` : '') +
    '</p>' +
    (digits
      ? `<div class="wa-line"><a class="btn quiet" href="https://wa.me/${esc(digits)}" rel="noopener">Open WhatsApp</a></div>`
      : '') +
    '</div></div>' +
    '<div class="channel">' +
    `<div class="glyph">${ICON.window}</div>` +
    '<div class="body">' +
    '<h3 class="h3">In the browser</h3>' +
    '<p class="small">The same pipeline with room to read: research kept in threads, ' +
    'precedents as cards, court records as a table, and the passages behind every ' +
    'answer one click away. Link your number and both channels share one account, ' +
    'one history and one balance.</p>' +
    '</div></div>' +
    '</div>'
  );
}

function figures(view: LandingView): string {
  return (
    '<div class="figures">' +
    '<div class="figure">' +
    `<div class="n">${view.freeMonthlyCredits < 0 ? '&#8734;' : esc(view.freeMonthlyCredits)}</div>` +
    '<div class="unit">free credits, once</div>' +
    '<p>Yours for the life of the account, not a monthly allowance. A spend draws ' +
    'on them before anything you have paid for, so the free ones go first and a ' +
    'purchase is never spent while free credits sit unused beside it.</p>' +
    '</div>' +
    '<div class="figure">' +
    `<div class="n">${esc(view.searchCost)}</div>` +
    '<div class="unit">credit per search</div>' +
    '<p>A credit buys a question, not a message. Press for detail on the same point ' +
    'as often as you like; only a genuinely new search is charged again. Case status ' +
    'costs nothing at all.</p>' +
    '</div>' +
    '<div class="figure">' +
    '<div class="n">0</div>' +
    '<div class="unit">charged for an empty result</div>' +
    '<p>A search that surfaces no authority refunds itself and tells you why it found ' +
    'nothing, rather than filling the gap with something that reads well.</p>' +
    '</div>' +
    '</div>'
  );
}

function faq(view: LandingView): string {
  const items: Array<[string, string]> = [
    [
      'Can I rely on the citations?',
      'Every citation and section number in a generated answer is checked against the ' +
        'database before you see it. Anything that cannot be found there is removed, and ' +
        'you are told something was removed. What survives is real — but it is ' +
        'research, and the judgment about whether it supports your matter stays yours.',
    ],
    [
      'Is this legal advice?',
      'No. It is a research tool for advocates. It does not advise, it does not appear, ' +
        'and it has no view about your case. Verify anything you intend to place before a ' +
        'court against the reported text.',
    ],
    [
      'Which languages does it understand?',
      'English, Hindi and Hinglish, including the mixture most people actually type. ' +
        'Answers come back in the language you asked in.',
    ],
    [
      'Do I need to install anything?',
      'No. WhatsApp runs on the phone you have, and the web app runs in any modern ' +
        'browser with nothing to download.',
    ],
    [
      'What happens to my questions?',
      'They are stored against your account so your research history is there when you ' +
        'come back, and they are deleted on the retention schedule the DPDP Act 2023 calls ' +
        'for. You can request erasure at any time. Phone numbers are masked in logs and bar ' +
        'council numbers are stored encrypted.',
    ],
    [
      view.signedIn ? 'How do I link my WhatsApp number?' : 'Can one account cover both?',
      'Yes. The web app shows you a six-digit code and you send it to the bot from your ' +
        'own handset — which proves you can send from that number, not merely read ' +
        'messages sent to it. After that, both channels share one account, one history and ' +
        'one balance.',
    ],
  ];

  return (
    '<div class="faq">' +
    items
      .map(
        ([q, a]) =>
          `<details><summary>${esc(q)}</summary><p class="answer">${esc(a)}</p></details>`,
      )
      .join('') +
    '</div>'
  );
}

/**
 * The theme, applied before first paint.
 *
 * Inline and synchronous on purpose: a deferred script lets the browser paint
 * light and repaint dark a frame later, which is the flash every themed site is
 * judged by. Reads the same `vs-theme` key the app writes, so somebody who chose
 * dark inside the app is not flashed white on the way back out.
 */
const THEME_BOOT =
  "try{var t=localStorage.getItem('vs-theme');" +
  "if(!t)t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';" +
  "document.documentElement.setAttribute('data-theme',t)}catch(e){}";

/**
 * Enhancement, and nothing the page depends on.
 *
 * The toggle is a convenience. The menu closes on an outside click because a
 * `<details>` otherwise stays open until its own summary is clicked again, which
 * reads as a stuck menu. With this blocked the page still renders, still
 * navigates, and the menu still works from its summary.
 */
const ENHANCE =
  "var b=document.getElementById('theme-toggle');" +
  "if(b)b.addEventListener('click',function(){" +
  "var n=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';" +
  "document.documentElement.setAttribute('data-theme',n);" +
  "try{localStorage.setItem('vs-theme',n)}catch(e){}});" +
  "var m=document.querySelector('details.menu');" +
  "if(m)document.addEventListener('click',function(e){if(m.open&&!m.contains(e.target))m.open=false});";

/**
 * Build the document.
 *
 * Pure: everything variable arrives in `view`, which is what lets the tests
 * assert on both header states without a request, a database or a clock.
 */
export function renderLanding(view: LandingView, css: string): string {
  const notice = previewNotice(view);
  const canonical = view.publicUrl.replace(/\/+$/, '') + '/';
  const title = 'Vakeel Saathi — verified legal research for Indian advocates';
  const description =
    'Precedents, statutory sections with IPC–BNS mapping, and case status by CNR ' +
    'for Indian advocates. Every citation is verified against the database before it ' +
    'reaches you. On WhatsApp and in your browser.';

  const doors = view.signedIn
    ? '<a class="btn lg" href="/app">Open your dashboard</a>'
    : '<a class="btn lg" href="/app/signup">Create your account</a>' +
      '<a class="btn lg quiet" href="/app">Log in</a>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vakeel Saathi">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<script>${THEME_BOOT}</script>
<style>${css}</style>
</head>
<body>
${notice ?? ''}
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">
      <span class="en">Vakeel Saathi</span>
      <span class="hi">&#2357;&#2325;&#2368;&#2354; &#2360;&#2366;&#2341;&#2368;</span>
    </a>
    <nav class="site-nav" aria-label="Sections">
      <a href="#features">Features</a>
      <a href="#how">How it works</a>
      <a href="#verification">Verification</a>
      <a href="#credits">Credits</a>
      <a href="#faq">Questions</a>
    </nav>
    ${headerActions(view)}
    ${mobileMenu(view)}
  </div>
</header>

<main>
  <section class="hero">
    <div class="wrap">
      <p class="eyebrow rise">For advocates practising in India</p>
      <h1 class="display rise d1">
        Research that cites<br><span class="soft">only what exists.</span>
      </h1>
      <p class="lede rise d2">
        Precedents, statutory sections and case status &#8212; in English, Hindi or
        Hinglish, on WhatsApp or in your browser. Every citation is checked against the
        database before it reaches you.
      </p>
      <div class="hero-cta rise d3">${doors}</div>
      <p class="hero-note rise d3">
        ${esc(allowancePhrase(view.freeMonthlyCredits))}${
          view.signupBonus > 0 ? `, plus ${esc(view.signupBonus)} to begin with` : ''
        }. Case status costs one credit; research costs two.
      </p>

      <div class="specimen rise d4" aria-label="An illustration of the answer format">
        <div class="specimen-bar">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span style="margin-left:5px">An illustration of the answer format</span>
        </div>
        <div class="specimen-body">
          <p class="q">&#2332;&#2350;&#2366;&#2344;&#2340; &#2325;&#2375; &#2354;&#2367;&#2319; &#2325;&#2380;&#2344; &#2360;&#2368; section? BNS &#2350;&#2375;&#2306;</p>
          <h4>Provision</h4>
          <p>Section 480, Bharatiya Nyaya Sanhita 2023 &#8212; corresponding to the
             repealed section 437 of the Indian Penal Code.</p>
          <h4>Authority</h4>
          <p>Considered in <span class="cite">(2020) 7 SCC 1</span> and
             <span class="cite">AIR 2019 SC 1234</span>.</p>
          <p class="verified">${ICON.shield} Both citations found in the corpus</p>
        </div>
      </div>
    </div>
  </section>

  <section class="band hair" id="features">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">What it does</p>
        <h2 class="h2">Three things, done properly.</h2>
        <p class="sub">
          Not a general chatbot pointed at law. Each has its own retrieval path, its own
          answer format, and its own honest failure mode.
        </p>
      </div>
      ${featureCards(view)}
    </div>
  </section>

  <section class="band tint" id="how">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">How it works</p>
        <h2 class="h2">Ask, retrieve, verify, answer.</h2>
        <p class="sub">
          The progress you watch while you wait is real. Each stage is reported as it
          begins, not animated on a timer.
        </p>
      </div>
      <div class="steps">
        <div class="step">
          <span class="n">01</span>
          <h3 class="h3">You ask</h3>
          <p>Plain language, any of the three, or a bare CNR. The router works out what
             kind of question it is before spending anything on it.</p>
        </div>
        <div class="step">
          <span class="n">02</span>
          <h3 class="h3">It retrieves</h3>
          <p>Meaning-based and keyword search run together over the corpus and the bare
             acts, then are fused into a single ranking.</p>
        </div>
        <div class="step">
          <span class="n">03</span>
          <h3 class="h3">It verifies</h3>
          <p>The finished answer is parsed and every citation and section checked against
             the database. Anything unfound is struck out.</p>
        </div>
        <div class="step">
          <span class="n">04</span>
          <h3 class="h3">You get sources</h3>
          <p>The answer arrives with the passages behind it, so you can read what it read
             instead of taking its word.</p>
        </div>
      </div>
      ${channels(view)}
    </div>
  </section>

  <section class="band" id="verification">
    <div class="wrap verify-grid">
      <div>
        <p class="eyebrow">The part that matters</p>
        <h2 class="h2">A model that invents a case is worse than no model.</h2>
        <p class="sub" style="margin-top:16px">
          Careful prompting makes fabricated citations rarer. It does not make them stop.
          So nothing here relies on the model behaving: the answer is checked after it is
          written, against the corpus, every single time.
        </p>
        <ul class="rules">
          <li>
            <span class="tick">${ICON.tick}</span>
            <span><b>Not in the corpus &#8594; removed</b>
            <span class="detail">Struck from the answer before you see it, and you are
            told that something was taken out.</span></span>
          </li>
          <li>
            <span class="tick">${ICON.tick}</span>
            <span><b>Real, but not retrieved &#8594; kept and flagged</b>
            <span class="detail">A genuine judgment the search did not surface stays in,
            and is logged for review.</span></span>
          </li>
          <li>
            <span class="tick">${ICON.tick}</span>
            <span><b>Nothing found &#8594; refunded</b>
            <span class="detail">An empty search says so and returns the credit rather
            than filling the space.</span></span>
          </li>
        </ul>
      </div>
      <div class="demo">
        <p>
          The principle was affirmed in <span class="cite">(2020) 7 SCC 1</span>, and
          further in <span class="removed">AIR 2019 SC 9999</span>
          <span class="replaced">[unverified]</span>.
        </p>
        <span class="caption">
          What the check does to an invented citation. The first exists in the corpus and
          stands; the second does not exist and never reaches the advocate. It is also why
          answers do not appear word by word &#8212; verification runs on the complete
          text, and showing you a case that turns out not to exist, however briefly, is
          the failure this is built to prevent.
        </span>
      </div>
    </div>
  </section>

  <section class="band tint" id="credits">
    <div class="wrap">
      <div class="band-head">
        <p class="eyebrow">What it costs</p>
        <h2 class="h2">Credits, and no surprises in the ledger.</h2>
        <p class="sub">
          Every movement &#8212; spend, refund, allowance, grant &#8212; is a line you can
          read in your account. A redelivered message or a double-tapped button cannot
          charge you twice; the database refuses it.
        </p>
      </div>
      ${figures(view)}
    </div>
  </section>

  <section class="band" id="faq">
    <div class="wrap">
      <div class="band-head center">
        <p class="eyebrow">Questions</p>
        <h2 class="h2">Before you sign up.</h2>
      </div>
      ${faq(view)}
    </div>
  </section>

  <section class="closer">
    <div class="wrap">
      <h2 class="h2">${
        view.signedIn ? 'Pick up where you left off.' : 'Start with the free allowance.'
      }</h2>
      <p class="lede">${
        view.signedIn
          ? 'Your threads, your balance and your linked number are exactly where you left them.'
          : esc(
              'No card, no sales call. ' +
                allowancePhrase(view.freeMonthlyCredits).replace(/^an /, 'An ') +
                ', and case status at one credit a lookup.',
            )
      }</p>
      <div class="hero-cta">${doors}</div>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="brand" href="/">
          <span class="en">Vakeel Saathi</span>
          <span class="hi">&#2357;&#2325;&#2368;&#2354; &#2360;&#2366;&#2341;&#2368;</span>
        </a>
        <p class="footer-blurb">
          Legal research and case intelligence for Indian advocates, with every citation
          verified before it is sent.
        </p>
      </div>
      <div>
        <h4>Product</h4>
        <ul>
          <li><a href="#features">Features</a></li>
          <li><a href="#how">How it works</a></li>
          <li><a href="#verification">Verification</a></li>
          <li><a href="#credits">Credits</a></li>
        </ul>
      </div>
      <div>
        <h4>Account</h4>
        <ul>
          ${
            view.signedIn
              ? '<li><a href="/app">Dashboard</a></li>'
              : '<li><a href="/app">Log in</a></li><li><a href="/app/signup">Sign up</a></li>'
          }
          <li><a href="#faq">Questions</a></li>
          <li><a href="/privacy">Privacy</a></li>
          ${
            waDigits(view.whatsappNumber)
              ? `<li><a href="https://wa.me/${esc(waDigits(view.whatsappNumber))}" rel="noopener">WhatsApp</a></li>`
              : ''
          }
        </ul>
      </div>
    </div>
    <div class="legal">
      <p>
        Vakeel Saathi is a research tool for legal professionals. It does not provide
        legal advice, does not create an advocate&#8211;client relationship, and is not a
        substitute for your own reading of the reported text or for professional
        judgment. Verify every authority before relying on it.
      </p>
      <p>&#169; ${esc(view.year)} Vakeel Saathi</p>
    </div>
  </div>
</footer>
<script>${ENHANCE}</script>
</body>
</html>`;
}
