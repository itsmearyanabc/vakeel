import { CREDIT_COST, isSameSearchContext } from '../credits/credits.service';
import { isValidCnr, normaliseCnr, parseProfile, ParsedProfile } from './onboarding';
import * as Replies from './replies';
import { matchLanguage } from './replies';

/**
 * The conversation as a pure state machine.
 *
 * ## Why the decision is separated from the doing
 *
 * The old flow made its routing decisions inline, interleaved with database
 * writes and WhatsApp calls, which meant the only way to find out what "2"
 * does in the precedent state was to run the whole stack. Every branch here is
 * a value returned from a function with no I/O, so the entire flow - including
 * the paths that are awkward to reach in production, like a session expiring
 * mid-onboarding - is testable directly.
 *
 * The router decides *what should happen*; ConversationService performs it.
 */

export const SESSION_STATE = {
  AWAITING_PROFILE: 'AWAITING_PROFILE',
  AWAITING_LANGUAGE: 'AWAITING_LANGUAGE',
  MAIN_MENU: 'MAIN_MENU',
  CASE_STATUS: 'CASE_STATUS',
  SECTION_INFO: 'SECTION_INFO',
  PRECEDENT_SEARCH: 'PRECEDENT_SEARCH',
} as const;

export type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

/** What the router knows about the conversation it is routing. */
export interface SessionContext {
  /** null when the session has expired or never existed. */
  state: SessionState | null;
  /** Session-scoped, not stored on the user - language is re-asked each session. */
  language?: string;
  languageLabel?: string;
  /** The last query the advocate was actually charged for. */
  lastChargedQuery?: string;
  /** How many precedents have already been shown in this result set. */
  precedentOffset?: number;
}

export interface SessionUser {
  fullName: string | null;
  /** True once Name, Bar Council ID, City and State are all on record. */
  profileComplete: boolean;
}

/**
 * Everything the router can ask for. A discriminated union so the caller cannot
 * forget to handle one - adding a variant breaks compilation at the switch.
 */
export type Action =
  | { kind: 'reply'; text: string }
  | { kind: 'saveProfile'; profile: ParsedProfile }
  | { kind: 'lookupCase'; cnr: string; charge: number }
  | { kind: 'lookupSection'; query: string; charge: number }
  | { kind: 'searchPrecedents'; query: string; charge: number }
  | { kind: 'nextPrecedentPage' }
  /**
   * Hand the message to the classifier and let it decide.
   *
   * Carries no charge because the cost is not knowable here: small talk and
   * menu navigation are free, a section lookup is not, and which one this is
   * takes a model call that the router deliberately cannot make.
   */
  | { kind: 'freeform'; text: string };

export interface Routed {
  actions: Action[];
  /** The state to persist. `null` clears it. Omitted means leave unchanged. */
  nextState?: SessionState | null;
  /** Merged into the stored context. */
  contextPatch?: Partial<SessionContext>;
}

/** "0" always means "take me back to the menu", from every state. */
const RETURN_KEY = '0';

/**
 * Route one inbound message.
 *
 * `creditLine` is passed in rather than computed here so the router stays free
 * of I/O; the caller has already read the balance.
 */
export function route(
  input: string,
  context: SessionContext,
  user: SessionUser,
  creditLine: string,
  /**
   * Public URL of the web app, or '' where there is none.
   *
   * Passed in for the same reason `creditLine` is: this function does no I/O
   * and reads no configuration, which is what lets the whole conversation be
   * tested without a database or an environment. Defaulted so the existing
   * callers and the twenty-one cases in the spec keep compiling unchanged.
   */
  site = '',
): Routed {
  const text = input.trim();

  // ---------------------------------------------------------------------
  // A new session. The message that starts it is deliberately not answered.
  //
  // Whatever the advocate typed was written without knowing which language
  // the session is in, whether they are recognised, or how many credits they
  // have. Answering it would commit to all three silently. The greeting
  // establishes those first, and the cost is one extra round trip at the
  // start of a session rather than a wrong answer in the middle of one.
  // ---------------------------------------------------------------------
  if (context.state === null) {
    if (!user.profileComplete) {
      return {
        actions: [{ kind: 'reply', text: Replies.greetingNewUser(site) }],
        nextState: SESSION_STATE.AWAITING_PROFILE,
        contextPatch: {},
      };
    }

    return {
      actions: [
        { kind: 'reply', text: Replies.greetingReturning(user.fullName, creditLine, site) },
      ],
      nextState: SESSION_STATE.AWAITING_LANGUAGE,
      contextPatch: {},
    };
  }

  switch (context.state) {
    case SESSION_STATE.AWAITING_PROFILE:
      return routeProfile(text, site);

    case SESSION_STATE.AWAITING_LANGUAGE:
      return routeLanguage(text, user, creditLine);

    case SESSION_STATE.MAIN_MENU:
      return routeMenu(text, creditLine);

    case SESSION_STATE.CASE_STATUS:
      return routeCaseStatus(text, context, creditLine);

    case SESSION_STATE.SECTION_INFO:
      return routeSection(text, context, creditLine);

    case SESSION_STATE.PRECEDENT_SEARCH:
      return routePrecedents(text, context, creditLine);

    default:
      return backToMenu(creditLine);
  }
}

/**
 * Does this read as a question rather than a botched profile?
 *
 * A profile is four comma-separated fields. Anything asking for something is
 * shaped differently, and the cheap signals are enough: a question mark, an
 * interrogative opening, or the two things this bot is actually for - a
 * statute reference or a CNR-shaped string.
 *
 * Deliberately generous. A false positive costs one clearer message; a false
 * negative returns the reply that reads as a broken bot, which is the failure
 * worth avoiding.
 */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;

  // A real profile has commas and no question mark - check that first so a
  // legitimate submission is never misread as a question.
  if (t.includes(',') && !t.includes('?')) return false;

  if (t.includes('?')) return true;
  if (/^(what|who|whose|whom|how|why|when|where|which|can|could|is|are|do|does|did|tell|explain|kya|kaise|kyu|kyun)\b/.test(t)) {
    return true;
  }
  // The statutes and identifiers this product exists to answer about.
  if (/\b(ipc|bns|crpc|bnss|cpc|section|dhara)\b/.test(t)) return true;
  if (/[A-Za-z]{4}\d{2}-?\d{6}-?\d{4}/i.test(text)) return true;

  return false;
}

function backToMenu(creditLine: string, prefix?: string): Routed {
  const text = prefix
    ? `${prefix}\n\n${Replies.helpMenu(creditLine)}`
    : Replies.helpMenu(creditLine);
  return {
    actions: [{ kind: 'reply', text }],
    nextState: SESSION_STATE.MAIN_MENU,
  };
}

function routeProfile(text: string, site: string): Routed {
  const profile = parseProfile(text);

  if (!profile) {
    /*
     * Two different failures wear the same clothes here.
     *
     * A mistyped profile needs the format again - re-sent in full rather than
     * as a bare "invalid", because by now it has scrolled off a phone screen.
     *
     * A question - "what is IPC 420" - was understood perfectly and simply
     * cannot be answered until the advocate is registered. Replying "I could
     * not understand that" tells them the bot is broken when it is working as
     * intended; they rephrase, get the same answer, and leave.
     */
    return {
      actions: [
        {
          kind: 'reply',
          text: looksLikeQuestion(text)
            ? Replies.profileNeededFirst(site)
            : `${Replies.NOT_UNDERSTOOD}\n\n${Replies.greetingNewUser(site)}`,
        },
      ],
      nextState: SESSION_STATE.AWAITING_PROFILE,
    };
  }

  return {
    actions: [
      { kind: 'saveProfile', profile },
      { kind: 'reply', text: Replies.LANGUAGE_PROMPT },
    ],
    nextState: SESSION_STATE.AWAITING_LANGUAGE,
  };
}

function routeLanguage(text: string, user: SessionUser, creditLine: string): Routed {
  const language = matchLanguage(text);

  if (!language) {
    return {
      actions: [
        { kind: 'reply', text: `${Replies.NOT_UNDERSTOOD}\n\n${Replies.LANGUAGE_PROMPT}` },
      ],
      nextState: SESSION_STATE.AWAITING_LANGUAGE,
    };
  }

  return {
    actions: [
      {
        kind: 'reply',
        text: Replies.menuAfterLanguage(user.fullName, language.label, creditLine),
      },
    ],
    nextState: SESSION_STATE.MAIN_MENU,
    contextPatch: { language: language.code, languageLabel: language.label },
  };
}

function routeMenu(text: string, creditLine: string): Routed {
  switch (text) {
    case '1':
      return {
        actions: [{ kind: 'reply', text: Replies.ASK_FOR_CNR }],
        nextState: SESSION_STATE.CASE_STATUS,
      };
    case '2':
      return {
        actions: [{ kind: 'reply', text: Replies.ASK_FOR_SECTION }],
        nextState: SESSION_STATE.SECTION_INFO,
      };
    case '3':
      return {
        actions: [{ kind: 'reply', text: Replies.ASK_FOR_QUERY }],
        nextState: SESSION_STATE.PRECEDENT_SEARCH,
        // A new search: nothing has been shown or charged for yet.
        contextPatch: { precedentOffset: 0, lastChargedQuery: undefined },
      };
    case RETURN_KEY:
      return backToMenu(creditLine);
    default:
      /*
       * Free text is answered rather than refused.
       *
       * This used to return "I could not understand that", on the reasoning
       * that the advocate had not said which of the three features they wanted
       * and guessing wrong would spend a credit on the wrong search. The
       * reasoning was sound and the conclusion was too strong: it is a guess
       * only if nothing looks at the message, and IntentService does - regex
       * first for a CNR or a section, then the router model, then a rule-based
       * fallback.
       *
       * The numbered menu still works and still costs nothing to interpret.
       * What changes is that somebody who types "what is IPC 420" - which is
       * how people actually talk to a chat window - gets an answer instead of
       * being told they are unintelligible.
       */
      return {
        actions: [{ kind: 'freeform', text }],
        nextState: SESSION_STATE.MAIN_MENU,
      };
  }
}

function routeCaseStatus(text: string, context: SessionContext, creditLine: string): Routed {
  if (text === RETURN_KEY) return backToMenu(creditLine);

  if (!isValidCnr(text)) {
    /*
     * A mistyped CNR and a change of subject need different answers.
     *
     * Somebody who picked "case status" and then asked "what is IPC 420" has
     * moved on, and repeating INVALID_CNR at them traps them in a state they
     * did not know they were in. Guarded by looksLikeQuestion so a genuine
     * typo - which reads nothing like a question - still gets the CNR help
     * rather than being sent to retrieval and charged for it.
     */
    if (looksLikeQuestion(text)) {
      return {
        actions: [{ kind: 'freeform', text }],
        nextState: SESSION_STATE.MAIN_MENU,
      };
    }

    return {
      actions: [{ kind: 'reply', text: Replies.INVALID_CNR }],
      nextState: SESSION_STATE.CASE_STATUS,
    };
  }

  const cnr = normaliseCnr(text);

  return {
    actions: [
      {
        kind: 'lookupCase',
        cnr,
        // Priced like the other lookups now that eCourts is a metered API. The
        // same-context test is what stops an advocate re-reading one case from
        // paying twice: the charge is for the record, not for the message.
        charge: chargeFor(context.lastChargedQuery, cnr, CREDIT_COST.CASE_STATUS),
      },
    ],
    nextState: SESSION_STATE.CASE_STATUS,
    contextPatch: { lastChargedQuery: cnr },
  };
}

function routeSection(text: string, context: SessionContext, creditLine: string): Routed {
  if (text === RETURN_KEY) return backToMenu(creditLine);
  if (!text) return backToMenu(creditLine, Replies.NOT_UNDERSTOOD);

  const charge = chargeFor(context.lastChargedQuery, text, CREDIT_COST.SECTION_LOOKUP);

  return {
    actions: [{ kind: 'lookupSection', query: text, charge }],
    nextState: SESSION_STATE.SECTION_INFO,
    contextPatch: charge > 0 ? { lastChargedQuery: text } : {},
  };
}

function routePrecedents(text: string, context: SessionContext, creditLine: string): Routed {
  if (text === RETURN_KEY) return backToMenu(creditLine);

  // Paging is never charged. "more" continues a result set the advocate has
  // already paid for; billing it again would charge twice for one search.
  if (/^more$/i.test(text)) {
    return { actions: [{ kind: 'nextPrecedentPage' }], nextState: SESSION_STATE.PRECEDENT_SEARCH };
  }

  if (!text) return backToMenu(creditLine, Replies.NOT_UNDERSTOOD);

  const charge = chargeFor(context.lastChargedQuery, text, CREDIT_COST.PRECEDENT_SEARCH);

  return {
    actions: [{ kind: 'searchPrecedents', query: text, charge }],
    nextState: SESSION_STATE.PRECEDENT_SEARCH,
    // A new query always resets paging, whether or not it was charged for -
    // otherwise "more" would continue the previous result set.
    contextPatch: charge > 0 ? { lastChargedQuery: text, precedentOffset: 0 } : { precedentOffset: 0 },
  };
}

/** Zero when this is the same question the advocate already paid for. */
function chargeFor(lastCharged: string | undefined, query: string, cost: number): number {
  return isSameSearchContext(lastCharged, query) ? 0 : cost;
}
