import { Action, route, SESSION_STATE, SessionContext, SessionUser } from './session.router';

/**
 * The whole conversation flow, exercised without a database, a queue or Meta.
 *
 * The cases worth guarding are the ones that are awkward to reach by hand: a
 * session expiring mid-onboarding, "more" arriving before any search, and every
 * state's response to "0". Those are exactly the paths that would otherwise
 * only be found by an advocate.
 */

const CREDITS = 'Credits: 5 of 5 left today';

const NEW_USER: SessionUser = { fullName: null, profileComplete: false };
const KNOWN_USER: SessionUser = { fullName: 'Ramesh Kumar', profileComplete: true };

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return { state: SESSION_STATE.MAIN_MENU, ...overrides };
}

function replies(actions: Action[]): string {
  return actions
    .filter((a): a is Extract<Action, { kind: 'reply' }> => a.kind === 'reply')
    .map((a) => a.text)
    .join('\n');
}

describe('session start', () => {
  it('greets a new user and asks for the profile', () => {
    const out = route('hello', { state: null }, NEW_USER, CREDITS);

    expect(replies(out.actions)).toContain('Jai Hind!');
    expect(replies(out.actions)).toContain('Name, Bar Council ID, City, State');
    expect(out.nextState).toBe(SESSION_STATE.AWAITING_PROFILE);
  });

  it('welcomes a returning user back by name and asks for language', () => {
    const out = route('hi', { state: null }, KNOWN_USER, CREDITS);

    expect(replies(out.actions)).toContain('Welcome back Ramesh Kumar');
    expect(replies(out.actions)).toContain('Select your language');
    expect(out.nextState).toBe(SESSION_STATE.AWAITING_LANGUAGE);
  });

  it('never acts on the message that starts a session', () => {
    // Typed before the advocate knows the language, whether they are
    // recognised, or what they have left. Answering it commits to all three.
    for (const opener of ['IPC 420', 'BRMG030000191989', 'find me bail precedents']) {
      const out = route(opener, { state: null }, KNOWN_USER, CREDITS);
      expect(out.actions.every((a) => a.kind === 'reply')).toBe(true);
    }
  });

  it('re-greets after the session expires mid-flow', () => {
    // An expired session arrives as state null regardless of where the
    // advocate was, so a half-finished onboarding cannot be resumed by
    // accident an hour later.
    const out = route('Patna', { state: null }, NEW_USER, CREDITS);
    expect(out.nextState).toBe(SESSION_STATE.AWAITING_PROFILE);
  });
});

describe('onboarding', () => {
  it('saves a valid profile and moves to language', () => {
    const out = route(
      'Ramesh Kumar, D/1234/2015, Patna, Bihar',
      ctx({ state: SESSION_STATE.AWAITING_PROFILE }),
      NEW_USER,
      CREDITS,
    );

    expect(out.actions[0]).toEqual({
      kind: 'saveProfile',
      profile: { fullName: 'Ramesh Kumar', barCouncilId: 'D/1234/2015', city: 'Patna', state: 'Bihar' },
    });
    expect(out.nextState).toBe(SESSION_STATE.AWAITING_LANGUAGE);
  });

  it('re-sends the full instructions on a malformed profile', () => {
    // A bare "invalid" is useless once the format has scrolled off screen.
    const out = route('Ramesh', ctx({ state: SESSION_STATE.AWAITING_PROFILE }), NEW_USER, CREDITS);

    expect(replies(out.actions)).toContain('Name, Bar Council ID, City, State');
    expect(out.nextState).toBe(SESSION_STATE.AWAITING_PROFILE);
    expect(out.actions.some((a) => a.kind === 'saveProfile')).toBe(false);
  });
});

describe('language selection', () => {
  it.each([['1', 'English'], ['2', 'हिंदी'], ['3', 'ಕನ್ನಡ'], ['hindi', 'हिंदी']])(
    'accepts %s and shows the menu with credits',
    (input, label) => {
      const out = route(input, ctx({ state: SESSION_STATE.AWAITING_LANGUAGE }), KNOWN_USER, CREDITS);

      expect(replies(out.actions)).toContain(label);
      expect(replies(out.actions)).toContain(CREDITS);
      expect(out.nextState).toBe(SESSION_STATE.MAIN_MENU);
      expect(out.contextPatch?.languageLabel).toBe(label);
    },
  );

  it('re-prompts on an unrecognised language', () => {
    const out = route('french', ctx({ state: SESSION_STATE.AWAITING_LANGUAGE }), KNOWN_USER, CREDITS);
    expect(out.nextState).toBe(SESSION_STATE.AWAITING_LANGUAGE);
  });
});

describe('main menu', () => {
  it.each([
    ['1', SESSION_STATE.CASE_STATUS],
    ['2', SESSION_STATE.SECTION_INFO],
    ['3', SESSION_STATE.PRECEDENT_SEARCH],
  ])('%s enters %s', (input, expected) => {
    expect(route(input, ctx(), KNOWN_USER, CREDITS).nextState).toBe(expected);
  });

  it('shows the menu again, with the reason, on anything else', () => {
    // A free-text question here has not said which of the three is wanted, and
    // guessing spends credits on the wrong search.
    const out = route('what is ipc 420', ctx(), KNOWN_USER, CREDITS);

    expect(replies(out.actions)).toContain('could not understand');
    expect(replies(out.actions)).toContain(CREDITS);
    expect(out.nextState).toBe(SESSION_STATE.MAIN_MENU);
    expect(out.actions.every((a) => a.kind === 'reply')).toBe(true);
  });
});

describe('case status', () => {
  it('looks up a valid CNR and stays put', () => {
    const out = route('BRMG030000191989', ctx({ state: SESSION_STATE.CASE_STATUS }), KNOWN_USER, CREDITS);

    expect(out.actions[0]).toEqual({ kind: 'lookupCase', cnr: 'BRMG030000191989' });
    expect(out.nextState).toBe(SESSION_STATE.CASE_STATUS);
  });

  it('rejects a malformed CNR without calling the court', () => {
    const out = route('12345', ctx({ state: SESSION_STATE.CASE_STATUS }), KNOWN_USER, CREDITS);

    expect(replies(out.actions)).toContain('invalid');
    expect(out.actions.some((a) => a.kind === 'lookupCase')).toBe(false);
  });

  it('never attaches a charge', () => {
    const out = route('BRMG030000191989', ctx({ state: SESSION_STATE.CASE_STATUS }), KNOWN_USER, CREDITS);
    expect(JSON.stringify(out.actions)).not.toContain('charge');
  });
});

describe('billing', () => {
  it('charges 1 for a new section lookup', () => {
    const out = route('IPC 420', ctx({ state: SESSION_STATE.SECTION_INFO }), KNOWN_USER, CREDITS);
    expect(out.actions[0]).toMatchObject({ kind: 'lookupSection', charge: 1 });
    expect(out.contextPatch?.lastChargedQuery).toBe('IPC 420');
  });

  it('does not charge twice for the same question', () => {
    const out = route(
      'ipc 420',
      ctx({ state: SESSION_STATE.SECTION_INFO, lastChargedQuery: 'IPC 420' }),
      KNOWN_USER,
      CREDITS,
    );
    expect(out.actions[0]).toMatchObject({ charge: 0 });
  });

  it('charges again when the advocate moves to a different section', () => {
    const out = route(
      'section 53',
      ctx({ state: SESSION_STATE.SECTION_INFO, lastChargedQuery: 'IPC 420' }),
      KNOWN_USER,
      CREDITS,
    );
    expect(out.actions[0]).toMatchObject({ charge: 1 });
  });

  it('never charges for paging with "more"', () => {
    // "more" continues a result set already paid for.
    const out = route(
      'more',
      ctx({ state: SESSION_STATE.PRECEDENT_SEARCH, lastChargedQuery: 'bail', precedentOffset: 5 }),
      KNOWN_USER,
      CREDITS,
    );
    expect(out.actions).toEqual([{ kind: 'nextPrecedentPage' }]);
  });

  it('resets paging on a new precedent query', () => {
    // Otherwise "more" would continue the previous search's results.
    const out = route(
      'anticipatory bail NDPS',
      ctx({ state: SESSION_STATE.PRECEDENT_SEARCH, lastChargedQuery: 'bail', precedentOffset: 5 }),
      KNOWN_USER,
      CREDITS,
    );
    expect(out.contextPatch?.precedentOffset).toBe(0);
  });
});

describe('"0" returns to the menu from every state', () => {
  it.each([
    SESSION_STATE.MAIN_MENU,
    SESSION_STATE.CASE_STATUS,
    SESSION_STATE.SECTION_INFO,
    SESSION_STATE.PRECEDENT_SEARCH,
  ])('from %s', (state) => {
    const out = route('0', ctx({ state }), KNOWN_USER, CREDITS);

    expect(out.nextState).toBe(SESSION_STATE.MAIN_MENU);
    expect(replies(out.actions)).toContain(CREDITS);
    expect(out.actions.every((a) => a.kind === 'reply')).toBe(true);
  });

  it('is not a menu shortcut during onboarding', () => {
    // "0" mid-onboarding is a typo, not navigation - there is no menu to reach
    // until the profile exists.
    expect(route('0', ctx({ state: SESSION_STATE.AWAITING_PROFILE }), NEW_USER, CREDITS).nextState).toBe(
      SESSION_STATE.AWAITING_PROFILE,
    );
    expect(route('0', ctx({ state: SESSION_STATE.AWAITING_LANGUAGE }), KNOWN_USER, CREDITS).nextState).toBe(
      SESSION_STATE.AWAITING_LANGUAGE,
    );
  });
});
