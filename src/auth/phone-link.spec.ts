import { AuthTokenRow, UserRow } from '../database/types';
import { PhoneLinkService } from './phone-link.service';

/**
 * The attempt ceiling is the whole reason a six-digit code is safe here, and it
 * was not firing.
 *
 * `redeemCode` counted the guess only after finding the token, and finding the
 * token required the digest to match - so a *wrong* code found nothing, counted
 * nothing, and returned "no pending code". An attacker messaging the bot could
 * walk the million-code space with no ceiling in the way, and nothing in any log
 * would say so, because every one of those attempts looked exactly like an
 * advocate typing a section number.
 *
 * That is a failure that reads as success from every angle, which is what these
 * cover.
 */

const NOW = Date.now();
const PHONE = '919876543210';

function tokenRow(over: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: 'tok-1',
    user_id: 'web-user',
    purpose: 'PHONE_LINK',
    token_hash: 'x'.repeat(64),
    subject: PHONE,
    expires_at: new Date(NOW + 900_000),
    consumed_at: null,
    attempts: 1,
    created_at: new Date(NOW),
    ...(over as object),
  } as AuthTokenRow;
}

function userRow(over: Partial<UserRow> = {}): UserRow {
  return { id: 'web-user', phone_number: null, ...(over as object) } as UserRow;
}

function build(
  over: {
    recordPhoneLinkAttempt?: jest.Mock;
    findPhoneLinkByCode?: jest.Mock;
    consumeToken?: jest.Mock;
    findByPhone?: jest.Mock;
    attachPhone?: jest.Mock;
  } = {},
) {
  const auth = {
    issueToken: jest.fn().mockResolvedValue(tokenRow()),
    recordPhoneLinkAttempt: over.recordPhoneLinkAttempt ?? jest.fn().mockResolvedValue(1),
    findPhoneLinkByCode: over.findPhoneLinkByCode ?? jest.fn().mockResolvedValue(tokenRow()),
    consumeToken: over.consumeToken ?? jest.fn().mockResolvedValue(tokenRow()),
    mergeWebAccountInto: jest.fn().mockResolvedValue(userRow()),
    attachPhone: over.attachPhone ?? jest.fn().mockResolvedValue(userRow({ phone_number: PHONE })),
  };
  const users = { findByPhone: over.findByPhone ?? jest.fn().mockResolvedValue(null) };

  return { service: new PhoneLinkService(auth as never, users as never), auth, users };
}

describe('PhoneLinkService.redeemCode', () => {
  it('counts a guess before comparing the digits, so a wrong code is counted too', async () => {
    // The regression: the count used to happen after the match, which meant it
    // only ever counted successes.
    const { service, auth } = build({
      findPhoneLinkByCode: jest.fn().mockResolvedValue(null),
    });

    const outcome = await service.redeemCode(PHONE, '000000');

    expect(auth.recordPhoneLinkAttempt).toHaveBeenCalledWith(PHONE);
    expect(outcome.status).toBe('NO_PENDING_CODE');
  });

  it('refuses once the ceiling is passed, without looking the code up at all', async () => {
    const { service, auth } = build({
      recordPhoneLinkAttempt: jest.fn().mockResolvedValue(6),
    });

    const outcome = await service.redeemCode(PHONE, '123456');

    expect(outcome.status).toBe('TOO_MANY_ATTEMPTS');
    expect(auth.findPhoneLinkByCode).not.toHaveBeenCalled();
    expect(auth.consumeToken).not.toHaveBeenCalled();
  });

  it('lets an ordinary six-digit message through when no code is outstanding', async () => {
    // "420" and "302" are section numbers advocates genuinely type. A number
    // with nothing pending must fall through to be answered as a question
    // rather than burning an attempt that does not exist.
    const { service, auth } = build({
      recordPhoneLinkAttempt: jest.fn().mockResolvedValue(0),
    });

    const outcome = await service.redeemCode(PHONE, '420420');

    expect(outcome.status).toBe('NO_PENDING_CODE');
    expect(auth.findPhoneLinkByCode).not.toHaveBeenCalled();
  });

  it('scopes the consume to the account the code was issued to', async () => {
    // consumeToken matches on the digest and purpose alone unless told
    // otherwise, so an unscoped call would let one number's guess burn another
    // account's live code on the way past.
    const { service, auth } = build();

    await service.redeemCode(PHONE, '123456');

    expect(auth.consumeToken).toHaveBeenCalledWith(expect.any(String), 'PHONE_LINK', 'web-user');
  });

  it('links the number on a correct code within the ceiling', async () => {
    const { service, auth } = build();

    const outcome = await service.redeemCode(PHONE, '123456');

    expect(outcome.status).toBe('LINKED');
    expect(auth.attachPhone).toHaveBeenCalledWith('web-user', PHONE);
  });

  it('normalises the number before counting, so +91 and 91 are one code', async () => {
    const { service, auth } = build();

    await service.redeemCode('+91 98765 43210', '123456');

    expect(auth.recordPhoneLinkAttempt).toHaveBeenCalledWith(PHONE);
  });
});
