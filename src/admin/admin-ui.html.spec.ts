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
