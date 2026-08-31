import { Script } from 'node:vm';
import { LANDING_CSS } from './landing.css';
import { LandingView, esc, renderLanding } from './landing.html';

/**
 * The landing page is a string, which means TypeScript checks almost nothing
 * about it. Three failure modes are worth a test:
 *
 *  1. **A syntax error in an inline script.** The page carries two, and the
 *     first runs in `<head>` before the stylesheet - a broken one there means
 *     the theme is never applied and every visitor gets a flash of the wrong
 *     palette, or worse. `nest build` cannot see inside a template literal, and
 *     neither can the type checker. This is the same trap the admin panel fell
 *     into once, in production; see admin-ui.html.spec.ts.
 *
 *  2. **The wrong header.** Whether a visitor is offered "Log in" or
 *     "Dashboard" is the whole point of rendering this page on the server, and
 *     it is decided by one boolean. A test is cheaper than signing in.
 *
 *  3. **An unescaped display name.** The name is chosen by the user and printed
 *     into a page served back to them. That is a stored XSS if `esc` is ever
 *     dropped from that interpolation, and nothing else in the system would
 *     notice.
 */

/** A deployment with everything configured - the state that shows no notice. */
function view(overrides: Partial<LandingView> = {}): LandingView {
  return {
    signedIn: false,
    displayName: null,
    freeMonthlyCredits: 30,
    searchCost: 1,
    caseStatusCost: 0,
    signupBonus: 10,
    whatsappNumber: '919876543210',
    caseStatusLive: true,
    caseLawLive: true,
    answersLive: true,
    publicUrl: 'https://vakeelsaathi.in',
    year: 2026,
    ...overrides,
  };
}

const render = (overrides: Partial<LandingView> = {}): string =>
  renderLanding(view(overrides), LANDING_CSS);

/**
 * The document with its stylesheet and scripts removed.
 *
 * Assertions about *copy* have to run against this rather than the whole
 * response, or they match CSS: a test that "-1" never appears fails on
 * `margin-top:-1px` and says nothing about what the page tells anybody.
 */
const copy = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');

describe('the landing page', () => {
  describe('inline scripts', () => {
    // [\s\S] rather than . so the match crosses newlines.
    const scripts = [...render().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

    it('carries both of them', () => {
      expect(scripts).toHaveLength(2);
    });

    it('parses as valid JavaScript', () => {
      // Compiled, never executed - no DOM is needed to catch a syntax error.
      for (const [index, source] of scripts.entries()) {
        expect(() => new Script(source, { filename: `landing-${index}.js` })).not.toThrow();
      }
    });

    it('applies the theme the app stores, under the key the app uses', () => {
      // A different key here means crossing from the landing page into /app
      // changes theme, which reads as two products rather than one.
      expect(scripts[0]).toContain('vs-theme');
      expect(scripts[0]).toContain('data-theme');
    });
  });

  describe('the header, signed out', () => {
    const html = render({ signedIn: false });

    it('offers both doors', () => {
      expect(html).toContain('href="/app">Log in</a>');
      expect(html).toContain('href="/app/signup">Sign up</a>');
    });

    it('does not show an account chip', () => {
      expect(html).not.toContain('class="who"');
      expect(html).not.toContain('Dashboard');
    });

    it('keeps the sign-in route reachable from the collapsed menu', () => {
      // The header hides "Log in" below 720px, so if the menu ever stopped
      // carrying it, phone users would have no way in at all.
      const menu = /<div class="menu-panel">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
      expect(menu).toContain('href="/app"');
      expect(menu).toContain('href="/app/signup"');
    });
  });

  describe('the header, signed in', () => {
    const html = render({ signedIn: true, displayName: 'Meera Iyer' });

    it('shows the dashboard and the name', () => {
      expect(html).toContain('>Dashboard</a>');
      expect(html).toContain('Meera Iyer');
    });

    it('drops the sign-up call to action everywhere', () => {
      // Including the hero and the closing section - inviting somebody who is
      // already signed in to create an account is the tell of a page that does
      // not know who is reading it.
      expect(html).not.toContain('/app/signup');
      expect(html).not.toContain('Create your account');
    });

    it('builds initials from the name', () => {
      expect(html).toContain('>MI</span>');
    });

    it('falls back to a neutral mark when there is no name', () => {
      expect(render({ signedIn: true, displayName: null })).toContain('>VS</span>');
    });
  });

  describe('escaping', () => {
    it('neutralises markup in the display name', () => {
      const html = render({
        signedIn: true,
        displayName: '<script>alert(document.cookie)</script>',
      });

      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;alert');
    });

    it('neutralises quotes, which would otherwise escape an attribute', () => {
      expect(esc('" onmouseover="x')).toBe('&quot; onmouseover=&quot;x');
    });

    it('escapes ampersands first, so an escape cannot be double-encoded', () => {
      expect(esc('Tata & Sons <legal>')).toBe('Tata &amp; Sons &lt;legal&gt;');
    });
  });

  describe('what the page claims', () => {
    it('says nothing about a preview when everything is configured', () => {
      expect(render()).not.toContain('class="notice"');
    });

    it('admits it when answers are placeholders', () => {
      const html = render({ answersLive: false });
      expect(html).toContain('class="notice"');
      expect(html).toContain('placeholder model');
    });

    it('admits it when there is no case-law source', () => {
      expect(render({ caseLawLive: false })).toContain('no judgment source is connected');
    });

    it('admits it when court records are sample data', () => {
      expect(render({ caseStatusLive: false })).toContain('sample data');
    });

    it('quotes the costs it was given rather than a number typed into the markup', () => {
      // The guard against the page and the ledger drifting apart. If the cost of
      // a search changes in CREDIT_COST, this page must move with it.
      const html = copy(render({ searchCost: 4, freeMonthlyCredits: 12 }));
      expect(html).toContain('4 credits');
      // Not "every month": since migration 0014 the allowance is granted once
      // for the life of the account, and the page must not promise a refill.
      expect(html).toContain('12 free credits');
      expect(html).not.toContain('every month');
      expect(html).not.toContain('>1 credit<');
    });

    it('renders an unmetered allowance without printing -1 at anybody', () => {
      const html = copy(render({ freeMonthlyCredits: -1 }));
      expect(html).toContain('an unmetered allowance');

      // Scoped to the figures rather than the document: -1 occurs inside SVG
      // path data, and an assertion against the whole page would be testing the
      // icons instead of the number an advocate reads.
      const figures = [...html.matchAll(/<div class="n">(.*?)<\/div>/g)].map((m) => m[1]);
      expect(figures).toContain('&#8734;');
      expect(figures).not.toContain('-1');
    });

    it('drops the signup bonus line when there is no bonus', () => {
      expect(render({ signupBonus: 0 })).not.toContain('to begin with');
    });
  });

  describe('the WhatsApp number', () => {
    it('links to wa.me with digits only', () => {
      expect(render({ whatsappNumber: '+91 98765 43210' })).toContain('https://wa.me/919876543210');
    });

    it('omits the channel link entirely when no number is configured', () => {
      const html = render({ whatsappNumber: '' });
      expect(html).not.toContain('wa.me');
      expect(html).not.toContain('Open WhatsApp');
      // The section itself stays - the channel exists whether or not this
      // deployment advertises a number for it.
      expect(html).toContain('On WhatsApp');
    });
  });

  describe('the document', () => {
    const html = render();

    it('is indexable, unlike the app shell', () => {
      expect(html).not.toContain('noindex');
      expect(html).toContain('<link rel="canonical" href="https://vakeelsaathi.in/">');
    });

    it('normalises a trailing slash on the public URL rather than doubling it', () => {
      expect(render({ publicUrl: 'https://vakeelsaathi.in/' })).toContain(
        'href="https://vakeelsaathi.in/"',
      );
    });

    it('carries link-preview metadata, which is how it will mostly be shared', () => {
      expect(html).toContain('property="og:title"');
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:url"');
    });

    it('leaves no undefined or NaN in the output', () => {
      expect(copy(html)).not.toMatch(/undefined|NaN|\[object Object\]/);
    });

    it('inlines the stylesheet, so the page needs no second round trip', () => {
      expect(html).toContain('--green');
      expect(html).not.toContain('<link rel="stylesheet"');
    });
  });
});
