import { AuthTokenRow, UserRow } from '../database/types';
import { PhoneVerificationService } from './phone-verification.service';

/**
 * The decisions here are the ones with a security consequence, so they are
 * tested against fakes rather than left to integration.
 *
 * Two of these - the takeover refusal and the cooldown ordering - are failures
 * that would look like success in production: nothing throws, nothing logs an
 * error, and the damage is either an account handed to the wrong person or a
 * live code destroyed while its owner is reading it off a screen.
 */

const NOW = Date.now();

function userRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    phone_number: null,
    email: null,
    password_hash: null,
    phone_verified_at: null,
    is_blocked: false,
    ...(over as object),
  } as UserRow;
}

function tokenRow(over: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: 'tok-1',
    user_id: 'user-1',
    purpose: 'PHONE_VERIFY',
    token_hash: 'x'.repeat(64),
    subject: '919876543210',
    expires_at: new Date(NOW + 600_000),
    consumed_at: null,
    attempts: 0,
    created_at: new Date(NOW),
    ...(over as object),
  } as AuthTokenRow;
}

/** Assembles the service with every collaborator stubbed to a benign default. */
function build(over: {
  findByPhone?: jest.Mock;
  findLiveToken?: jest.Mock;
  sendAuthCode?: jest.Mock;
  whatsappConfigured?: boolean;
  attachOrMerge?: jest.Mock;
  recordTokenAttempt?: jest.Mock;
  consumeToken?: jest.Mock;
} = {}) {
  const auth = {
    findLiveToken: over.findLiveToken ?? jest.fn().mockResolvedValue(null),
    issueToken: jest.fn().mockResolvedValue(tokenRow()),
    recordTokenAttempt: over.recordTokenAttempt ?? jest.fn().mockResolvedValue(1),
    consumeToken: over.consumeToken ?? jest.fn().mockResolvedValue(tokenRow()),
  };
  const users = { findByPhone: over.findByPhone ?? jest.fn().mockResolvedValue(null) };
  const links = {
    attachOrMerge:
      over.attachOrMerge ??
      jest.fn().mockResolvedValue({ status: 'LINKED', user: userRow(), merged: false }),
  };
  const whatsapp = { sendAuthCode: over.sendAuthCode ?? jest.fn().mockResolvedValue({ ok: true }) };
  const settings = { whatsappConfigured: over.whatsappConfigured ?? true };

  const service = new PhoneVerificationService(
    auth as never,
    users as never,
    links as never,
    whatsapp as never,
    settings as never,
  );

  return { service, auth, users, links, whatsapp };
}

describe('PhoneVerificationService.start', () => {
  it('refuses a number that belongs to a credentialled account', async () => {
    const { service, whatsapp } = build({
      findByPhone: jest.fn().mockResolvedValue(userRow({ id: 'other', password_hash: 'argon2...' })),
    });

    const result = await service.start(userRow(), '919876543210');

    expect(result.status).toBe('ALREADY_REGISTERED');
    // Nothing sent: the code could never have led anywhere, and a template
    // message costs money whether or not it was useful.
    expect(whatsapp.sendAuthCode).not.toHaveBeenCalled();
  });

  it('allows a number held only by a WhatsApp-origin row, which merging absorbs', async () => {
    const { service, whatsapp } = build({
      // No password and no email: the same person arriving by a second door.
      findByPhone: jest.fn().mockResolvedValue(userRow({ id: 'bot-user', phone_number: '919876543210' })),
    });

    const result = await service.start(userRow(), '919876543210');

    expect(result.status).toBe('SENT');
    expect(whatsapp.sendAuthCode).toHaveBeenCalled();
  });

  it('reports rather than pretends when WhatsApp cannot send', async () => {
    const { service, whatsapp } = build({ whatsappConfigured: false });

    const result = await service.start(userRow(), '919876543210');

    // The dangerous alternative is SENT: verification gates access, so a person
    // told a code is coming would be stuck behind a gate with no way through.
    expect(result.status).toBe('CHANNEL_UNAVAILABLE');
    expect(whatsapp.sendAuthCode).not.toHaveBeenCalled();
  });

  it('surfaces a delivery failure instead of swallowing it', async () => {
    const { service } = build({
      sendAuthCode: jest.fn().mockResolvedValue({ ok: false, error: 'bad template', code: 132001 }),
    });

    expect((await service.start(userRow(), '919876543210')).status).toBe('DELIVERY_FAILED');
  });

  it('rejects anything that is not phone-number shaped', async () => {
    const { service, whatsapp } = build();

    expect((await service.start(userRow(), '12345')).status).toBe('INVALID_PHONE');
    expect((await service.start(userRow(), '9'.repeat(16))).status).toBe('INVALID_PHONE');
    expect(whatsapp.sendAuthCode).not.toHaveBeenCalled();
  });

  it('refuses a resend inside the cooldown without destroying the live code', async () => {
    const { service, auth, whatsapp } = build({
      findLiveToken: jest.fn().mockResolvedValue(tokenRow({ created_at: new Date(NOW - 5_000) })),
    });

    const result = await service.start(userRow(), '919876543210');

    expect(result.status).toBe('COOLDOWN');
    // The ordering is the point. issueToken() consumes the previous code for
    // this purpose, so issuing first and rejecting after would invalidate the
    // code the person is currently typing in.
    expect(auth.issueToken).not.toHaveBeenCalled();
    expect(whatsapp.sendAuthCode).not.toHaveBeenCalled();
  });

  it('allows a resend once the cooldown has passed', async () => {
    const { service } = build({
      findLiveToken: jest.fn().mockResolvedValue(tokenRow({ created_at: new Date(NOW - 90_000) })),
    });

    expect((await service.start(userRow(), '919876543210')).status).toBe('SENT');
  });
});

describe('PhoneVerificationService.verify', () => {
  it('burns the code once the attempt ceiling is passed', async () => {
    const { service, auth } = build({
      findLiveToken: jest.fn().mockResolvedValue(tokenRow()),
      recordTokenAttempt: jest.fn().mockResolvedValue(6),
    });

    expect((await service.verify(userRow(), '000000')).status).toBe('TOO_MANY_ATTEMPTS');
    expect(auth.consumeToken).not.toHaveBeenCalled();
  });

  it('counts the attempt before comparing, so a wrong guess always costs one', async () => {
    const { service, auth } = build({
      findLiveToken: jest.fn().mockResolvedValue(tokenRow()),
      consumeToken: jest.fn().mockResolvedValue(null),
    });

    const result = await service.verify(userRow(), '111111');

    expect(result.status).toBe('WRONG_CODE');
    expect(auth.recordTokenAttempt).toHaveBeenCalled();
  });

  it('re-checks ownership after the code is proven', async () => {
    const { service, links } = build({
      findLiveToken: jest.fn().mockResolvedValue(tokenRow()),
      // Nobody owned it at start(); somebody registered in the interval.
      findByPhone: jest.fn().mockResolvedValue(userRow({ id: 'other', email: 'them@example.com' })),
    });

    const result = await service.verify(userRow(), '123456');

    expect(result.status).toBe('ALREADY_REGISTERED');
    // The merge is what would have handed over the account, so it must not run.
    expect(links.attachOrMerge).not.toHaveBeenCalled();
  });

  it('attaches the number on a good code', async () => {
    const { service, links } = build({ findLiveToken: jest.fn().mockResolvedValue(tokenRow()) });

    const result = await service.verify(userRow(), '123456');

    expect(result.status).toBe('VERIFIED');
    expect(links.attachOrMerge).toHaveBeenCalledWith('user-1', '919876543210');
  });
});
