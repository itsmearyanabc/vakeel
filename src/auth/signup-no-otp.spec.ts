import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthController } from './auth.controller';

/**
 * Creating an account does not need a one-time code.
 *
 * ## The two halves of what was reported
 *
 * "code is not getting generated for new user" and "it is logging in even
 * after saying that" are the same bug seen from both ends.
 *
 * Signing up started a WhatsApp verification and returned the advocate to a
 * code-entry screen. Delivery needs a Meta-approved template and a working
 * WhatsApp configuration, so when either was missing no code ever arrived -
 * and the session cookie in that same response had already signed them in. The
 * screen said "verify to continue" while the cookie said "you are in".
 */

function controller() {
  const phones = { start: jest.fn().mockResolvedValue({ sent: true }) };
  const auth = { signUp: jest.fn().mockResolvedValue({ user: { id: 'u1' } }) };

  const instance = Object.create(AuthController.prototype) as AuthController;
  Object.assign(instance, {
    phones,
    auth,
    // Both are private plumbing: `run` translates thrown errors and
    // `completeSignIn` sets the session cookie. Neither is what is under test.
    run: (fn: () => unknown) => fn(),
    completeSignIn: jest.fn().mockResolvedValue({ user: { id: 'u1' } }),
  });

  return { instance, phones, auth };
}

const body = { email: 'a@b.co', password: 'a-long-enough-password', phoneNumber: '919876543210' };
const request = { headers: {}, ip: '1.2.3.4' };

describe('signing up', () => {
  it('sends no verification code', async () => {
    const { instance, phones } = controller();

    await instance.signUp(body as never, request as never, {} as never);

    expect(phones.start).not.toHaveBeenCalled();
  });

  it('does not hand the client a verification step to render', async () => {
    // The website read `verification` off this response and used it to decide
    // to show the code screen.
    const { instance } = controller();

    const result = await instance.signUp(body as never, request as never, {} as never);

    expect(result).not.toHaveProperty('verification');
  });

  it('still creates the account and signs it in', async () => {
    const { instance, auth } = controller();

    const result = await instance.signUp(body as never, request as never, {} as never);

    expect(auth.signUp).toHaveBeenCalled();
    expect(result).toMatchObject({ user: { id: 'u1' } });
  });
});

describe('the gate that used to stand behind it', () => {
  const env = readFileSync(join(process.cwd(), 'src/config/env.ts'), 'utf8');

  it('is off by default', () => {
    /*
     * Load-bearing, not cautious. Signup no longer issues a code, so an
     * enforced gate with nothing to satisfy it locks out every new account by
     * construction - the account is created, and the first authenticated
     * request it makes is refused forever.
     */
    const block = /PHONE_VERIFICATION_REQUIRED: z[\s\S]{0,200}?\.default\('(true|false)'\)/.exec(env);

    expect(block?.[1]).toBe('false');
  });
});

describe('the website', () => {
  const app = readFileSync(join(process.cwd(), 'src/web/assets/app.js.ts'), 'utf8');

  it('takes a new account straight into the app', () => {
    expect(app).not.toContain('if (signup) return renderVerifyPhone(');
  });

  it('keeps the code screen for an account that is genuinely gated', () => {
    // Existing accounts, and deployments that turn the gate back on, still
    // need somewhere to enter a code.
    expect(app).toContain("err.code === 'PHONE_UNVERIFIED'");
    expect(app).toContain('function renderVerifyPhone');
  });
});
