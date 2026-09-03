import { isAcknowledgement } from '../ai/conversational';
import {
  Action,
  route,
  SESSION_STATE,
  SessionContext,
  SessionState,
  SessionUser,
} from './session.router';

/**
 * The bot must never be a room with no door.
 *
 * ## Why this is a property and not a list of cases
 *
 * The same bug has now been found three times, in three different states, each
 * time by an advocate rather than by a test:
 *
 *   - CASE_STATUS answered "the case number is invalid" to "More" and to
 *     "That's it", and to every message after them.
 *   - AWAITING_BAR_ID answered "that is not a valid Bar Council ID" to any
 *     question containing a digit, which is most legal questions.
 *   - AWAITING_LANGUAGE answered "I could not understand that" to the question
 *     the advocate had opened the thread to ask.
 *
 * Each was fixed on its own, and the next one was written into a state nobody
 * had looked at yet, because "did I leave a way out" is not a question anybody
 * remembers to ask while adding a prompt. So it is asked here instead, of every
 * state, automatically.
 *
 * ## The invariant
 *
 * Send the same message three times. If the conversation has not moved and no
 * work has been asked for, that is a fixed point - the advocate is stuck. A
 * fixed point is not automatically a bug: "send me your Bar Council ID" should
 * keep asking. It is only acceptable if **every reply at that fixed point says
 * what to send**. That is the whole difference between a prompt and a trap.
 */

const STATES: SessionState[] = Object.values(SESSION_STATE);

/**
 * What people actually send, including the things that are not questions.
 *
 * The sign-offs and the pleasantries are the important half. Every trap found
 * so far was found by somebody being polite to a bot.
 */
const CORPUS = [
  // Research questions, across the areas of practice this product covers.
  'what is IPC 420',
  'section 302 IPC punishment',
  'order 32 CPC',
  'Order 37 Rule 3 CPC',
  'is anticipatory bail maintainable after chargesheet',
  'section 138 NI Act procedure',
  'cheque bounce case kaise file kare',
  'what is the limitation period for a suit for possession',
  'draft a bail application',
  'grounds for divorce under Hindu Marriage Act',
  'धारा 302 क्या है',
  'IPC 498A bailable hai kya',
  // References.
  'DLCT010001232024',
  'BRMG030000191989',
  '12345',
  'D/1234/2015',
  // Navigation and paging.
  '0',
  '1',
  '2',
  '3',
  '9',
  'more',
  'next',
  'aur',
  // Pleasantries, acknowledgements, sign-offs.
  'hi',
  'hello',
  'thanks',
  'thank you',
  'ok',
  'okay',
  "that's it",
  'no thanks',
  'great',
  'nice',
  'yes',
  'no',
  'bye',
  'नमस्ते',
  'धन्यवाद',
  // Noise.
  '.',
  '?',
  'asdfgh',
  '',
];

const KNOWN: SessionUser = { fullName: 'Ramesh Kumar', profileComplete: true };
const NEW_USER: SessionUser = { fullName: null, profileComplete: false };

const CREDIT_LINE = 'Credits: 10 left';

/**
 * Does this reply tell the advocate what to send next?
 *
 * The four things that count: the profile format, the language options, the CNR
 * format, and the universal escape. A prompt that repeats one of these is doing
 * its job. A reply that repeats none of them, forever, is a trap.
 */
function showsTheWayOut(text: string): boolean {
  return (
    /Bar Council ID, City, State/.test(text) ||
    /Select your language/.test(text) ||
    /CNR is 16 characters|16-character CNR/.test(text) ||
    /type \*0\*|type \*menu\*|I can help you with/i.test(text)
  );
}

/** Actions that mean the message was accepted and something is being done. */
function madeProgress(actions: Action[]): boolean {
  return actions.some((a) => a.kind !== 'reply');
}

interface Settled {
  stuck: boolean;
  replies: string[];
}

/**
 * Send the same message three times from the same starting point.
 *
 * Three rather than two because a state machine is allowed one transitional
 * reply - the second message is what proves the advocate is going in circles.
 */
function settle(state: SessionState, message: string, user: SessionUser): Settled {
  let context: SessionContext = { state };
  const replies: string[] = [];
  let progressed = false;

  for (let i = 0; i < 3; i++) {
    const routed = route(message, context, user, CREDIT_LINE, '');
    if (madeProgress(routed.actions)) progressed = true;

    for (const action of routed.actions) {
      if (action.kind === 'reply') replies.push(action.text);
    }

    const next = routed.nextState === undefined ? context.state : routed.nextState;
    context = { ...context, ...(routed.contextPatch ?? {}), state: next };
  }

  return { stuck: !progressed && context.state === state, replies };
}

describe('no dead ends', () => {
  it.each(STATES)('%s always shows the way out when it repeats itself', (state) => {
    const traps: string[] = [];

    for (const message of CORPUS) {
      const user = state === SESSION_STATE.AWAITING_PROFILE ? NEW_USER : KNOWN;
      const { stuck, replies } = settle(state, message, user);
      if (!stuck) continue;

      if (!replies.every(showsTheWayOut)) {
        traps.push(`${JSON.stringify(message)} -> ${JSON.stringify(replies[0]?.slice(0, 70))}`);
      }
    }

    expect(traps).toEqual([]);
  });

  it('releases a research question typed at the language prompt', () => {
    // The trap this test was written for. "What is IPC 420" at the language
    // menu got "I could not understand that", three options, and the same
    // answer for every message after - on the *first screen* of every returning
    // session.
    const routed = route(
      'what is IPC 420',
      { state: SESSION_STATE.AWAITING_LANGUAGE },
      KNOWN,
      CREDIT_LINE,
      '',
    );

    expect(routed.actions).toEqual([{ kind: 'freeform', text: 'what is IPC 420' }]);
    expect(routed.nextState).toBe(SESSION_STATE.MAIN_MENU);
  });

  it('still re-prompts when the answer is simply not a language', () => {
    // The release is for a change of subject, not for every miss. "asdfgh" at
    // the language prompt is a typo, and showing the options again is right.
    const routed = route(
      'asdfgh',
      { state: SESSION_STATE.AWAITING_LANGUAGE },
      KNOWN,
      CREDIT_LINE,
      '',
    );

    expect(routed.nextState).toBe(SESSION_STATE.AWAITING_LANGUAGE);
    expect((routed.actions[0] as { text: string }).text).toContain('Select your language');
  });
});

describe('nothing walks past onboarding', () => {
  /**
   * Registration is the one gate in the conversation, and "more" went straight
   * through it: the paging handler answers from any state, so the second
   * message of a brand-new conversation moved the session to MAIN_MENU, where
   * free text is classified, answered and billed.
   */
  it.each(CORPUS)('keeps an unregistered advocate at the profile prompt: %p', (message) => {
    const routed = route(
      message,
      { state: SESSION_STATE.AWAITING_PROFILE },
      NEW_USER,
      CREDIT_LINE,
      '',
    );

    expect(routed.nextState).toBe(SESSION_STATE.AWAITING_PROFILE);
    expect(routed.actions.every((a) => a.kind === 'reply')).toBe(true);
  });

  it('accepts the profile itself and moves on', () => {
    const routed = route(
      'Ramesh Kumar, D/1234/2015, Patna, Bihar',
      { state: SESSION_STATE.AWAITING_PROFILE },
      NEW_USER,
      CREDIT_LINE,
      '',
    );

    expect(routed.actions.map((a) => a.kind)).toEqual(['saveProfile', 'reply']);
    expect(routed.nextState).toBe(SESSION_STATE.AWAITING_LANGUAGE);
  });
});

describe('being polite is free', () => {
  /**
   * SECTION_INFO and PRECEDENT_SEARCH are sticky - the state survives the
   * answer so a second question needs no menu trip - and every message arriving
   * in them became a charged lookup on the text as typed. Reading an answer and
   * replying "thanks" bought a retrieval over the word "thanks".
   *
   * The credit cost is invisible to the advocate at the moment it happens,
   * which is what makes it worse than the error-message traps: nobody reports
   * it, they just run out sooner than they expected.
   */
  const CHARGED: Action['kind'][] = ['lookupSection', 'searchPrecedents', 'lookupCase'];
  const asides = CORPUS.filter(isAcknowledgement);

  it('has acknowledgements to test', () => {
    // Guards the two tests below from passing because the filter matched
    // nothing - the failure mode where a property test quietly tests air.
    expect(asides.length).toBeGreaterThan(10);
  });

  it.each(STATES)('never charges for a pleasantry in %s', (state) => {
    const billed: string[] = [];

    for (const message of asides) {
      const routed = route(message, { state }, KNOWN, CREDIT_LINE, '');
      for (const action of routed.actions) {
        if (CHARGED.includes(action.kind) && (action as { charge: number }).charge > 0) {
          billed.push(`${message} -> ${action.kind}`);
        }
      }
    }

    expect(billed).toEqual([]);
  });

  it('hands a sign-off to the classifier rather than swallowing it', () => {
    // Not silently dropped: "thanks" gets a reply, free, and the advocate is
    // returned to the menu because they have finished with the feature.
    const routed = route(
      'thanks',
      { state: SESSION_STATE.SECTION_INFO },
      KNOWN,
      CREDIT_LINE,
      '',
    );

    expect(routed.actions).toEqual([{ kind: 'freeform', text: 'thanks' }]);
    expect(routed.nextState).toBe(SESSION_STATE.MAIN_MENU);
  });

  it('still charges for a real question that opens with a pleasantry', () => {
    // The cap on isAcknowledgement is what keeps the release narrow. "Thanks,
    // now what about Order 39" is a question with manners on the front.
    const routed = route(
      'thanks, now what about Order 39 CPC',
      { state: SESSION_STATE.SECTION_INFO },
      KNOWN,
      CREDIT_LINE,
      '',
    );

    expect(routed.actions[0].kind).toBe('lookupSection');
    expect((routed.actions[0] as { charge: number }).charge).toBeGreaterThan(0);
  });
});

describe('the language prompt, for the language it offers', () => {
  it('releases a question written in Hindi', () => {
    /*
     * The advocate this bot offers Hindi to is the one most likely to type a
     * Hindi question at the language prompt rather than picking from it - and
     * that was the one case the release missed. "धारा 302 क्या है" opens with
     * the noun, not the interrogative, so neither the anchored English list nor
     * the transliterated "dhara" matched, and a Hindi question was answered
     * with the language menu again.
     */
    for (const question of ['धारा 302 क्या है', 'अनुच्छेद 226 समझाइए', 'जमानत कैसे मिलेगी']) {
      const routed = route(
        question,
        { state: SESSION_STATE.AWAITING_LANGUAGE },
        KNOWN,
        CREDIT_LINE,
        '',
      );
      expect(routed.actions).toEqual([{ kind: 'freeform', text: question }]);
    }
  });

  it('still treats the native language names as a choice, not a question', () => {
    // "हिंदी" is the label on option 2. It must select the language, not be
    // released as a Devanagari question - matchLanguage runs first, and this
    // asserts the release did not overtake it.
    const routed = route('हिंदी', { state: SESSION_STATE.AWAITING_LANGUAGE }, KNOWN, CREDIT_LINE, '');

    expect(routed.nextState).toBe(SESSION_STATE.MAIN_MENU);
    expect(routed.contextPatch?.language).toBe('hi');
  });
});
