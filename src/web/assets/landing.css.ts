/**
 * Styles for the public landing page.
 *
 * ## Why this does not share the app's palette
 *
 * The app is a tool: olive carries identity, red means something is wrong, and
 * the colour is load-bearing because an advocate reads state off it all day.
 * The landing page is a different job. It has one thing to do - explain the
 * product and get out of the way - and the register that does that best is the
 * one Apple and OpenAI both landed on independently: near-monochrome, a great
 * deal of white space, type doing the work that decoration usually does, and
 * exactly one accent, spent where it means something.
 *
 * So the palette here is greyscale with a single green, used only for
 * verification - the one idea this product is actually built around. Nothing
 * else on the page is coloured, which is what makes that green read as a
 * statement rather than as styling.
 *
 * ## Constraints
 *
 * **It renders without JavaScript.** The app requires JS and says so; a landing
 * page that does is invisible to crawlers, to WhatsApp's link preview and to
 * anyone behind a restrictive browser policy. The menu is a `<details>`, the
 * FAQ is a `<details>`, and the entrance animation is pure CSS. The only script
 * is the theme toggle, and without it the page is simply light.
 *
 * **It agrees with the app about dark mode.** The inline head script reads the
 * same `vs-theme` key the app writes, before first paint, so crossing from here
 * into `/app` never flashes.
 */
export const LANDING_CSS = String.raw`
/* ==========================================================================
   Tokens

   Both themes are written out in full rather than one patching the other, so a
   value can never be left holding a colour from the wrong theme.
   ========================================================================== */
:root {
  --bg:#FFFFFF;
  --panel:#F7F7F8;
  --panel-2:#F0F0F1;
  --ink:#0D0D0D;
  --ink-2:#3C3C3C;
  --muted:#6B6B6B;
  --faint:#9B9B9B;
  --line:rgba(13,13,13,.09);
  --line-2:rgba(13,13,13,.055);

  /* The one accent. Verification, and nothing else. */
  --green:#12805C;
  --green-soft:rgba(18,128,92,.09);

  /* Errors in the illustration only - the page has no error states. */
  --strike:#C0392B;
  --strike-soft:rgba(192,57,43,.08);

  --btn:#0D0D0D;
  --btn-ink:#FFFFFF;
  --btn-hover:#2B2B2B;

  --r-sm:8px; --r:12px; --r-lg:20px; --r-xl:26px; --pill:999px;

  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",
         Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;

  --shell:1080px;
  --lift:0 1px 2px rgba(13,13,13,.04), 0 8px 28px rgba(13,13,13,.06);
}

[data-theme="dark"] {
  --bg:#0A0A0A;
  --panel:#151515;
  --panel-2:#1D1D1D;
  --ink:#F5F5F5;
  --ink-2:#D4D4D4;
  --muted:#A1A1A1;
  --faint:#6E6E6E;
  --line:rgba(255,255,255,.11);
  --line-2:rgba(255,255,255,.07);

  --green:#3DD68C;
  --green-soft:rgba(61,214,140,.12);

  --strike:#FF7B6B;
  --strike-soft:rgba(255,123,107,.12);

  --btn:#FFFFFF;
  --btn-ink:#0A0A0A;
  --btn-hover:#E2E2E2;

  --lift:0 1px 2px rgba(0,0,0,.5), 0 12px 40px rgba(0,0,0,.4);
}

/* ==========================================================================
   Base
   ========================================================================== */
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
/* The sticky header would otherwise cover the top of a section jumped to. */
:target { scroll-margin-top:96px; }
section[id] { scroll-margin-top:78px; }

body {
  margin:0; background:var(--bg); color:var(--ink);
  font:400 17px/1.6 var(--sans);
  letter-spacing:-.011em;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
}

a { color:inherit; text-decoration:none; }
button { font:inherit; color:inherit; cursor:pointer; }
:focus-visible { outline:2px solid var(--ink); outline-offset:3px; border-radius:4px; }

h1,h2,h3,h4 { margin:0; font-weight:600; letter-spacing:-.03em; line-height:1.08; }
p { margin:0; }

.wrap { width:100%; max-width:var(--shell); margin:0 auto; padding:0 28px; }

/* ==========================================================================
   Type scale
   ========================================================================== */
.display {
  font-size:clamp(40px, 6.4vw, 74px);
  letter-spacing:-.038em; line-height:1.03; font-weight:600;
}
.h2 { font-size:clamp(28px, 3.7vw, 46px); letter-spacing:-.032em; }
.h3 { font-size:19px; letter-spacing:-.02em; font-weight:600; line-height:1.3; }

.lede {
  font-size:clamp(17px, 1.55vw, 20px); line-height:1.55;
  color:var(--muted); letter-spacing:-.015em; font-weight:400;
}
.sub { font-size:17px; line-height:1.6; color:var(--muted); }
.small { font-size:14.5px; line-height:1.6; color:var(--muted); letter-spacing:-.008em; }

/* The section label. A quiet pill, not a coloured shout. */
.eyebrow {
  display:inline-block; font-size:12.5px; font-weight:500; letter-spacing:.01em;
  color:var(--muted); padding:5px 12px; border-radius:var(--pill);
  border:1px solid var(--line); background:var(--panel);
  margin-bottom:22px;
}

/* ==========================================================================
   Buttons
   ========================================================================== */
.btn {
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  height:40px; padding:0 18px; border:1px solid transparent;
  border-radius:var(--pill); background:var(--btn); color:var(--btn-ink);
  font-size:15px; font-weight:500; letter-spacing:-.012em; white-space:nowrap;
  transition:background .18s ease, border-color .18s ease, transform .18s ease, opacity .18s ease;
}
.btn:hover { background:var(--btn-hover); }
.btn:active { transform:scale(.985); }

.btn.quiet {
  background:transparent; color:var(--ink); border-color:var(--line);
}
.btn.quiet:hover { background:var(--panel); border-color:var(--line); }

.btn.plain { background:transparent; color:var(--muted); border-color:transparent; padding:0 12px; }
.btn.plain:hover { color:var(--ink); background:var(--panel); }

.btn.lg { height:52px; padding:0 26px; font-size:16.5px; }

.icon-btn {
  width:36px; height:36px; flex:0 0 auto; padding:0;
  display:grid; place-items:center; color:var(--muted);
  background:transparent; border:1px solid transparent; border-radius:var(--pill);
  transition:background .18s ease, color .18s ease;
}
.icon-btn:hover { background:var(--panel); color:var(--ink); }

/* ==========================================================================
   Header
   ========================================================================== */
.site-header {
  position:sticky; top:0; z-index:60;
  background:color-mix(in srgb, var(--bg) 78%, transparent);
  backdrop-filter:saturate(1.8) blur(20px);
  -webkit-backdrop-filter:saturate(1.8) blur(20px);
  border-bottom:1px solid var(--line-2);
}
.site-header .wrap { display:flex; align-items:center; gap:20px; height:60px; }

.brand { display:inline-flex; align-items:baseline; gap:8px; flex:0 0 auto; }
.brand .en { font-size:16.5px; font-weight:600; letter-spacing:-.028em; }
.brand .hi { font-size:14px; font-weight:400; color:var(--faint); letter-spacing:0; }

.site-nav { display:flex; align-items:center; gap:2px; margin-left:14px; }
.site-nav a {
  padding:7px 12px; border-radius:var(--r-sm);
  font-size:14.5px; font-weight:450; color:var(--muted); letter-spacing:-.01em;
  transition:color .18s ease;
}
.site-nav a:hover { color:var(--ink); }

.header-actions { display:flex; align-items:center; gap:6px; margin-left:auto; }

.who {
  display:inline-flex; align-items:center; gap:9px; height:36px;
  padding:0 5px 0 13px; border-radius:var(--pill);
  border:1px solid var(--line); font-size:14.5px; font-weight:450;
  transition:background .18s ease;
}
.who:hover { background:var(--panel); }
.who .avatar {
  width:26px; height:26px; border-radius:var(--pill); flex:0 0 auto;
  display:grid; place-items:center;
  background:var(--ink); color:var(--bg); font-size:11px; font-weight:600; letter-spacing:0;
}
.who .who-name { max-width:15ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* --- Menu for narrow screens, with no JavaScript ------------------------- */
.menu { position:relative; display:none; }
.menu > summary {
  list-style:none; cursor:pointer;
  width:36px; height:36px; display:grid; place-items:center;
  border-radius:var(--pill); color:var(--muted);
}
.menu > summary::-webkit-details-marker { display:none; }
.menu[open] > summary { background:var(--panel); color:var(--ink); }
.menu-panel {
  position:absolute; right:0; top:calc(100% + 10px); z-index:70;
  min-width:214px; padding:7px;
  background:var(--bg); border:1px solid var(--line);
  border-radius:var(--r-lg); box-shadow:var(--lift);
}
.menu-panel a {
  display:block; padding:10px 12px; border-radius:var(--r);
  font-size:15px; font-weight:450; color:var(--ink-2);
}
.menu-panel a:hover { background:var(--panel); color:var(--ink); }
.menu-panel hr { border:0; border-top:1px solid var(--line-2); margin:6px 4px; }

/* ==========================================================================
   The entrance

   CSS only, so it plays on a page where no script ran, and is removed outright
   for anyone who has asked for less motion.
   ========================================================================== */
@keyframes rise {
  from { opacity:0; transform:translateY(14px); }
  to   { opacity:1; transform:none; }
}
.rise { animation:rise .7s cubic-bezier(.16,.84,.44,1) both; }
.d1 { animation-delay:.06s; } .d2 { animation-delay:.12s; }
.d3 { animation-delay:.18s; } .d4 { animation-delay:.26s; }

/* ==========================================================================
   Hero
   ========================================================================== */
.hero { padding:clamp(76px, 12vw, 152px) 0 clamp(56px, 8vw, 104px); text-align:center; }
.hero .display { margin:0 auto 26px; max-width:15ch; }
.hero .lede { margin:0 auto; max-width:60ch; }
.hero-cta { display:flex; flex-wrap:wrap; gap:11px; justify-content:center; margin-top:38px; }
.hero-note { margin-top:22px; font-size:14px; color:var(--faint); letter-spacing:-.008em; }

/* The muted half of the headline. Contrast, not colour, carries the emphasis. */
.display .soft { color:var(--faint); }

/* --- The specimen --------------------------------------------------------
   An illustration of the answer format, labelled as one. It is static markup:
   a fake live demo on a page about not fabricating things would be a poor
   opening argument. */
.specimen {
  max-width:660px; margin:clamp(48px, 7vw, 84px) auto 0;
  background:var(--bg); border:1px solid var(--line);
  border-radius:var(--r-xl); box-shadow:var(--lift);
  overflow:hidden; text-align:left;
}
.specimen-bar {
  display:flex; align-items:center; gap:9px; padding:13px 18px;
  border-bottom:1px solid var(--line-2);
  font-size:12.5px; color:var(--faint); letter-spacing:-.005em;
}
.dot { width:8px; height:8px; border-radius:var(--pill); background:var(--line); flex:0 0 auto; }
.specimen-body { padding:24px 26px 26px; }
.specimen .q {
  font-size:15.5px; background:var(--panel); border-radius:var(--r-lg);
  padding:13px 17px; margin-bottom:24px; display:inline-block;
}
.specimen h4 {
  font-size:11.5px; font-weight:600; letter-spacing:.07em; text-transform:uppercase;
  color:var(--faint); margin-bottom:7px;
}
.specimen p { font-size:15.5px; line-height:1.62; color:var(--ink-2); margin-bottom:22px; }
.cite {
  font-family:var(--mono); font-size:13px; letter-spacing:-.01em;
  padding:2px 7px; border-radius:6px;
  background:var(--green-soft); color:var(--green); white-space:nowrap;
}
.specimen .verified {
  display:flex; align-items:center; gap:9px; margin-bottom:0;
  padding-top:19px; border-top:1px solid var(--line-2);
  font-size:13.5px; font-weight:500; color:var(--green); letter-spacing:-.008em;
}

/* ==========================================================================
   Sections
   ========================================================================== */
.band { padding:clamp(72px, 10vw, 128px) 0; }
.band.tint { background:var(--panel); }
.band.hair { border-top:1px solid var(--line-2); }

.band-head { max-width:44ch; margin-bottom:clamp(40px, 5vw, 64px); }
.band-head.center { margin-left:auto; margin-right:auto; text-align:center; }
.band-head .h2 { margin-bottom:16px; }

/* --- Feature cards -------------------------------------------------------- */
.cards { display:grid; gap:20px; grid-template-columns:repeat(3, 1fr); }
.card {
  background:var(--bg); border:1px solid var(--line);
  border-radius:var(--r-xl); padding:30px 28px 28px;
  transition:border-color .2s ease, transform .2s ease;
}
.band.tint .card { background:var(--bg); }
.card:hover { border-color:var(--ink); transform:translateY(-2px); }
.card .glyph { color:var(--ink); margin-bottom:22px; opacity:.85; }
.card .h3 { margin-bottom:9px; }
.card p { font-size:15.5px; line-height:1.62; color:var(--muted); }
.tag {
  display:inline-block; margin-top:20px; font-size:12.5px; font-weight:500;
  padding:4px 11px; border-radius:var(--pill);
  border:1px solid var(--line); color:var(--muted);
}
.tag.free { border-color:transparent; background:var(--green-soft); color:var(--green); }

/* --- Steps ---------------------------------------------------------------- */
.steps { display:grid; gap:2px; grid-template-columns:repeat(4, 1fr); }
.step { padding:28px 26px 30px; background:var(--bg); }
.step:first-child { border-radius:var(--r-xl) 0 0 var(--r-xl); }
.step:last-child  { border-radius:0 var(--r-xl) var(--r-xl) 0; }
.step .n {
  display:block; font-size:12.5px; font-weight:600; color:var(--faint);
  letter-spacing:.04em; margin-bottom:16px;
}
.step .h3 { font-size:17px; margin-bottom:8px; }
.step p { font-size:14.8px; line-height:1.6; color:var(--muted); }

/* --- Channels ------------------------------------------------------------- */
.channels { display:grid; gap:20px; grid-template-columns:repeat(2, 1fr); margin-top:20px; }
.channel { display:flex; gap:18px; align-items:flex-start; }
.channel .glyph { margin:2px 0 0; flex:0 0 auto; }
.channel .body { min-width:0; }
.channel .body p { margin-top:9px; }
.wa-line { margin-top:16px; }
.wa-line .btn { height:36px; font-size:14.5px; }

/* --- Verification: the centre of the page -------------------------------- */
.verify-grid {
  display:grid; grid-template-columns:1fr 1fr; gap:clamp(36px, 6vw, 76px);
  align-items:center;
}
.rules { list-style:none; margin:34px 0 0; padding:0; display:grid; gap:22px; }
.rules li { display:flex; gap:14px; align-items:flex-start; }
.rules .tick {
  flex:0 0 auto; width:20px; height:20px; margin-top:2px; border-radius:var(--pill);
  display:grid; place-items:center; background:var(--green-soft); color:var(--green);
}
.rules b { display:block; font-weight:550; font-size:16px; letter-spacing:-.018em; margin-bottom:3px; }
.rules span.detail { font-size:15px; line-height:1.58; color:var(--muted); }

.demo {
  background:var(--bg); border:1px solid var(--line);
  border-radius:var(--r-xl); padding:30px; box-shadow:var(--lift);
  font-size:16.5px; line-height:1.75; letter-spacing:-.015em;
}
.demo .removed {
  text-decoration:line-through; text-decoration-thickness:1.5px;
  color:var(--strike); background:var(--strike-soft);
  border-radius:6px; padding:1px 6px;
}
.demo .replaced {
  font-family:var(--mono); font-size:13px; color:var(--faint);
  border:1px dashed var(--line); border-radius:6px; padding:1px 7px; white-space:nowrap;
}
.demo .caption {
  display:block; margin-top:24px; padding-top:20px; border-top:1px solid var(--line-2);
  font-size:14px; line-height:1.62; color:var(--muted); letter-spacing:-.008em;
}

/* --- Credits -------------------------------------------------------------- */
.figures { display:grid; gap:20px; grid-template-columns:repeat(3, 1fr); }
.figure { padding:32px 28px; border:1px solid var(--line); border-radius:var(--r-xl); background:var(--bg); }
.figure .n {
  font-size:52px; font-weight:600; letter-spacing:-.045em; line-height:1;
  margin-bottom:10px; font-variant-numeric:tabular-nums;
}
.figure .unit { font-size:15px; font-weight:500; color:var(--ink-2); margin-bottom:16px; }
.figure p { font-size:14.8px; line-height:1.62; color:var(--muted); }

/* --- FAQ ------------------------------------------------------------------ */
.faq { max-width:760px; margin:0 auto; }
.faq details { border-top:1px solid var(--line-2); }
.faq details:last-of-type { border-bottom:1px solid var(--line-2); }
.faq summary {
  cursor:pointer; list-style:none; position:relative;
  padding:26px 40px 26px 0;
  font-size:18px; font-weight:500; letter-spacing:-.022em; line-height:1.4;
}
.faq summary::-webkit-details-marker { display:none; }
.faq summary::after {
  content:''; position:absolute; right:8px; top:50%; margin-top:-1px;
  width:13px; height:1.5px; background:var(--faint);
  transition:transform .25s ease;
}
.faq summary::before {
  content:''; position:absolute; right:14px; top:50%; margin-top:-7px;
  width:1.5px; height:13px; background:var(--faint);
  transition:transform .25s ease, opacity .2s ease;
}
.faq details[open] summary::before { transform:rotate(90deg); opacity:0; }
.faq .answer {
  padding:0 60px 28px 0; margin-top:-6px;
  font-size:16px; line-height:1.68; color:var(--muted); letter-spacing:-.012em;
}

/* --- Closer --------------------------------------------------------------- */
.closer { padding:clamp(80px, 11vw, 148px) 0; text-align:center; }
.closer .h2 { margin-bottom:18px; }
.closer .lede { margin:0 auto; max-width:48ch; }

/* ==========================================================================
   Footer
   ========================================================================== */
.site-footer { border-top:1px solid var(--line-2); padding:56px 0 40px; }
.footer-grid { display:grid; grid-template-columns:2fr 1fr 1fr; gap:40px; }
.footer-grid h4 {
  font-size:12.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase;
  color:var(--faint); margin-bottom:16px;
}
.footer-grid ul { list-style:none; margin:0; padding:0; display:grid; gap:11px; }
.footer-grid li a { font-size:15px; color:var(--muted); }
.footer-grid li a:hover { color:var(--ink); }
.footer-blurb { margin-top:14px; font-size:14.5px; line-height:1.6; color:var(--muted); max-width:38ch; }

.legal {
  margin-top:52px; padding-top:26px; border-top:1px solid var(--line-2);
  display:flex; flex-wrap:wrap; gap:20px; justify-content:space-between; align-items:flex-start;
}
.legal p { font-size:13px; line-height:1.65; color:var(--faint); max-width:70ch; letter-spacing:-.005em; }

/* ==========================================================================
   The preview notice

   Shown only when this deployment cannot do what the page describes. Grey, not
   yellow: it is a statement of fact about a preview, not a warning about a
   fault, and the page has no other colour to spend.
   ========================================================================== */
.notice { background:var(--panel); border-bottom:1px solid var(--line-2); padding:12px 0; }
.notice .wrap { display:flex; gap:11px; align-items:flex-start; }
.notice p { font-size:13.5px; line-height:1.55; color:var(--muted); letter-spacing:-.008em; }
.notice b { color:var(--ink); font-weight:550; }
.notice .mark { color:var(--faint); flex:0 0 auto; margin-top:1px; }

/* ==========================================================================
   Responsive
   ========================================================================== */
@media (max-width:1000px) {
  .cards, .figures { grid-template-columns:1fr 1fr; }
  .steps { grid-template-columns:1fr 1fr; gap:1px; }
  .step, .step:first-child, .step:last-child { border-radius:0; }
  .verify-grid, .channels { grid-template-columns:1fr; }
  .footer-grid { grid-template-columns:1fr 1fr; }
}

@media (max-width:720px) {
  body { font-size:16.5px; }
  .wrap { padding:0 20px; }
  .site-nav { display:none; }
  .menu { display:block; }
  .brand .hi { display:none; }
  /* Sign-up survives in the header; log-in moves into the menu, where it stays
     one tap away without crowding a 360px bar. */
  .header-actions .btn.quiet, .header-actions .icon-btn { display:none; }
  .cards, .figures, .steps, .footer-grid { grid-template-columns:1fr; }
  .hero-cta .btn { width:100%; }
  .hero .display { max-width:none; }
  .specimen-body { padding:20px; }
  .demo { padding:24px; }
  .faq .answer { padding-right:0; }
  .legal { gap:12px; }
}

@media (prefers-reduced-motion:reduce) {
  html { scroll-behavior:auto; }
  .rise { animation:none; }
  * { transition-duration:.01ms !important; }
}
`;
