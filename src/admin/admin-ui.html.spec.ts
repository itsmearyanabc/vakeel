import { Script } from 'node:vm';
import { ADMIN_UI_HTML } from './admin-ui.html';

/**
 * The panel is one inline <script>. A single syntax error anywhere in it means
 * *nothing* runs - including `doLogin` - so the login form submits natively and
 * the page reloads to `/admin?` with no fields and no error message. That is
 * exactly what an unescaped quote in an onclick string once did in production,
 * and nothing in `nest build` catches it: to TypeScript the markup is just a
 * string.
 *
 * Parsing the script here is the cheapest thing that would have caught it.
 */
describe('ADMIN_UI_HTML', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(ADMIN_UI_HTML)?.[1];

  it('contains an inline script', () => {
    expect(script).toBeTruthy();
  });

  it('parses as valid JavaScript', () => {
    // Compiles only - never executed, so no DOM is needed.
    expect(() => new Script(script as string, { filename: 'admin-panel.js' })).not.toThrow();
  });

  it('renders a login form with both sign-in modes present', () => {
    expect(ADMIN_UI_HTML).toContain('id="emailFields"');
    expect(ADMIN_UI_HTML).toContain('id="tokenFields"');
    expect(script).toContain('function doLogin');
    expect(script).toContain('function initLoginForm');
  });
});

describe('the user table', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(ADMIN_UI_HTML)?.[1] as string;

  it('does not offer super admin in the role dropdown', () => {
    /*
     * It did, on every row, one click below "guest lawyer".
     *
     * Super admin is total control of this panel — settings, pricing, every
     * account's credits — and it was grantable by a misclick on the wrong row
     * by anyone holding an ordinary admin session. Promotion belongs somewhere
     * a person has to mean it; demotion stays here, because removing an
     * administrator is the urgent direction.
     */
    expect(script).not.toContain("['GUEST_LAWYER','VERIFIED_ADVOCATE','LEGAL_AUDITOR','SUPER_ADMIN']");
    expect(script).toContain("['GUEST_LAWYER','VERIFIED_ADVOCATE','LEGAL_AUDITOR']");
  });

  it('still shows super admin on a row that already holds it', () => {
    // Otherwise the select misreports the account's actual role, and there is
    // no way to demote the one person who most needs demoting.
    expect(script).toContain("u.role === 'SUPER_ADMIN' ? ['SUPER_ADMIN'] : []");
  });

  it('adjusts credits from the row rather than from another screen', () => {
    /*
     * Granting was reachable only from the Credits page, which asks for a user
     * id in a prompt. The real procedure was: find the advocate in this table,
     * press "id" to copy a UUID, navigate away, press Grant, paste. Five steps
     * and a clipboard for something whose natural home is the row already on
     * screen.
     */
    expect(script).toContain('function adjustCredits');
    expect(script).toContain('onclick="adjustCredits(');
  });

  it('sends a negative amount to the deduct endpoint, not a negative grant', () => {
    // One prompt, signed, because the split between the two endpoints is
    // something the ledger cares about and the person pressing the button
    // does not.
    expect(script).toContain("taking ? '/credits/deduct' : '/credits/grant'");
    expect(script).toContain('Math.abs(amount)');
  });
});
