import { isAcknowledgement } from '../ai/conversational';
import { CREDIT_COST, isSameSearchContext } from '../credits/credits.service';
import {
  isValidCnr,
  looksLikeCnrAttempt,
  normaliseCnr,
  parseProfile,
  ParsedProfile,
} from './onboarding';
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

/**
 * What the router knows about the conversation it is routing.
 *
 * ## Why the precedent result set lives here
 *
 * It used to be written straight to `conversation_states` by the code that ran
 * the search, under a state of its own. That row is also where the router's
 * context is persisted, and ConversationService writes it once at the end of
 * every message - so the trailing write replaced the row the search had just
 * made, `rows` was gone before the advocate could type "more", and paging
 * answered "that was the last result" on every search that had a second page.
 *
 * One row, one writer. Everything the next message needs is part of the context
 * the router already carries.
 */
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
  /** The query those precedents answer, reprinted on each page. */
  precedentQuery?: string;
  /**
   * The result set "more" pages through.
   *
   * Held whole so a second page costs no retrieval and no embedding call - the
   * advocate has already paid for this search, and running it again would also
   * risk returning a different set.
   *
   * Typed loosely on purpose: the router never looks inside, and naming the
   * database row type here would give a pure function a dependency on the
   * schema for the sake of a field it only carries.
   */
  precedentRows?: unknown[];
  /** Retrieval ran keyword-only. Repeated on every page, not just the first. */
  precedentLexicalOnly?: boolean;
  /** Which backend answered. Repeated for the same reason. */
  precedentSource?: 'local' | 'kanoon';
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

/**
 * Forget the stored result set.
 *
 * Spread into a patch rather than written out at each site, so a field added to
 * the paging state cannot be left behind in one of them - which is how a "more"
 * ends up continuing a result set from a query two questions ago.
 *
 * Exported because ConversationService needs the same reset from the other
 * side: the router clears it when a new query arrives, and the answer clears it
 * when the set runs out. Two copies of this list is one copy too many.
 */
export const CLEARED_PRECEDENTS: Partial<SessionContext> = {
  precedentOffset: 0,
  precedentQuery: undefined,
  precedentRows: undefined,
  precedentLexicalOnly: undefined,
  precedentSource: undefined,
};

/** "0" always means "take me back to the menu", from every state. */
const RETURN_KEY = '0';

/**
 * Is the advocate asking for the next page?
 *
 * The English word is what the footer tells them to send, and the others are
 * what people send anyway - "next" from anyone who has used a search engine,
 * "aur" and "और" from anyone typing Hindi. Deliberately not a bare number:
 * "2" and "3" are menu choices, and reading one as a page request would send
 * somebody to case law when they asked for a section.
 */
function isMoreRequest(text: string): boolean {
  return /^(more|next|aur|और|continue)$/i.test(text.trim());
}

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

  /*
   * "more" continues a held result set from wherever the advocate is standing.
   *
   * It used to be handled only inside the PRECEDENT_SEARCH state, which is the
   * state reached by picking 3 from the menu. Most searches do not go that way:
   * typing "case law on anticipatory bail" at the menu is answered by the
   * classifier and leaves the conversation at MAIN_MENU, so the very next
   * "more" - which the page footer has just invited, in bold - fell through to
   * the classifier as a fresh question and came back "I only handle questions
   * about Indian law."
   *
   * Keyed on the result set rather than on the state, because the result set is
   * the thing that decides whether there is anything to continue. Checked before
   * the state switch so it works from every state, and after the new-session
   * block because an expired session holds no rows to page.
   */
  /*
   * Onboarding is the one place nothing else may run.
   *
   * Everything below this line - paging, the menu, a research question - is for
   * an advocate the bot already knows. The "more" handler underneath sat above
   * the state switch unconditionally, and it answers from *any* state: typing
   * "more" as the second message of a brand-new conversation replied "there is
   * nothing more to show" and moved the session to MAIN_MENU, which is where
   * free text is classified, answered and billed. Registration was skipped by
   * typing one word - not as a clever bypass, but because "more" and "next" are
   * ordinary things to send a bot that has just written you a paragraph.
   */
  const onboarding =
    context.state === SESSION_STATE.AWAITING_PROFILE ||
    context.state === SESSION_STATE.AWAITING_LANGUAGE;

  if (!onboarding && isMoreRequest(text)) {
    if (context.precedentRows?.length) {
      // Named rather than omitted. Paging does not move the advocate, and the
      // caller persists the context under whatever state this returns - so
      // leaving it out would drop the advanced offset with it and serve the
      // same page again on the next "more".
      return { actions: [{ kind: 'nextPrecedentPage' }], nextState: context.state };
    }

    /*
     * "more" with nothing held. Answered here rather than left to fall through.
     *
     * Downstream it becomes whatever the state happens to be: "invalid case
     * number" after a case status, or - worse - a fresh two-credit search on
     * the word "more" after a section lookup. Neither is what was asked, and
     * one of them charges for it.
     */
    return {
      actions: [{ kind: 'reply', text: Replies.NOTHING_MORE }],
      nextState: SESSION_STATE.MAIN_MENU,
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

  /*
   * The same test in Devanagari.
   *
   * Everything above is Latin script or transliteration, and this bot offers
   * Hindi on its second line - so the advocate most likely to type a question
   * at the language prompt, instead of picking from it, is the one this missed.
   * "धारा 302 क्या है" opens with the noun rather than the interrogative, so
   * neither the anchored list nor the transliterated "dhara" caught it, and the
   * question was answered with the language menu again.
   *
   * Not anchored to the start, because Hindi puts the question word last.
   */
  if (/(क्या|कैसे|क्यों|कब|कौन|कहाँ|कहां|बताइए|बताओ|समझाइए)/.test(text)) return true;
  if (/(धारा|अनुच्छेद|अधिनियम|संहिता|संविधान)/.test(text)) return true;

  // The statutes and identifiers this product exists to answer about.
  if (/\b(ipc|bns|crpc|bnss|cpc|section|dhara|article|order)\b/.test(t)) return true;
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
    /*
     * The third instance of one bug, and the last one left.
     *
     * A state that asks a question and answers everything else with "I could
     * not understand that" is a trap, and this was the worst of the three
     * because it sits at the top of every returning session. An advocate who
     * opens the thread, sees "Select your language", and types the question
     * they actually came to ask - "what is IPC 420" - was told they were
     * unintelligible, shown the same three options, and told it again for every
     * message after. Nothing in the reply mentions the way out.
     *
     * A question is a change of subject, so it is released to the classifier
     * exactly as CASE_STATUS releases one. Skipping the prompt loses nothing:
     * the classifier detects the language from the message itself and
     * handleFreeformQuery records it, which is already how language is set for
     * everybody who never sees this prompt.
     */
    if (looksLikeQuestion(text)) {
      return {
        actions: [{ kind: 'freeform', text }],
        nextState: SESSION_STATE.MAIN_MENU,
      };
    }

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
        contextPatch: { ...CLEARED_PRECEDENTS, lastChargedQuery: undefined },
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
      // Nothing to classify. An empty body reaches here from a message type
      // that carried no text, and sending it to the router model buys a
      // provider call to be told that "" is not a legal question.
      if (!text) return backToMenu(creditLine);

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
     * The test used to be `looksLikeQuestion`, which asks "is this
     * interrogative" - and almost nothing anybody types after reading a case
     * card is. An advocate who got their answer and replied "More" or "That's
     * it" was told "The case number is invalid" and told it again for every
     * message after, with no way out but knowing to type 0. Two real messages
     * into a working feature, the bot reads as broken.
     *
     * `looksLikeCnrAttempt` asks the question that actually matters: does this
     * look like somebody trying to type a 16-character reference number? Digit
     * density is the discriminator, so a genuine typo still gets the CNR help
     * and ordinary English is released to the classifier rather than refused.
     */
    if (looksLikeReference(text)) {
      return {
        actions: [{ kind: 'reply', text: Replies.INVALID_CNR }],
        nextState: SESSION_STATE.CASE_STATUS,
      };
    }

    return {
      actions: [{ kind: 'freeform', text }],
      nextState: SESSION_STATE.MAIN_MENU,
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
  if (isAcknowledgement(text)) return released(text);

  const charge = chargeFor(context.lastChargedQuery, text, CREDIT_COST.SECTION_LOOKUP);

  return {
    actions: [{ kind: 'lookupSection', query: text, charge }],
    nextState: SESSION_STATE.SECTION_INFO,
    contextPatch: charge > 0 ? { lastChargedQuery: text } : {},
  };
}

function routePrecedents(text: string, context: SessionContext, creditLine: string): Routed {
  if (text === RETURN_KEY) return backToMenu(creditLine);

  /*
   * Paging is never charged: "more" continues a result set the advocate has
   * already paid for, and billing it again would charge twice for one search.
   *
   * A held set is caught earlier, by route(), from any state. This branch is
   * what is left: "more" typed here with nothing to page - a set that expired,
   * or a search that returned a single page. It goes to the same action, which
   * answers "that was the last result" rather than sending the word off to the
   * classifier to come back as an unsupported question.
   */
  if (isMoreRequest(text)) {
    return { actions: [{ kind: 'nextPrecedentPage' }], nextState: SESSION_STATE.PRECEDENT_SEARCH };
  }

  if (!text) return backToMenu(creditLine, Replies.NOT_UNDERSTOOD);
  if (isAcknowledgement(text)) return released(text);

  const charge = chargeFor(context.lastChargedQuery, text, CREDIT_COST.PRECEDENT_SEARCH);

  return {
    actions: [{ kind: 'searchPrecedents', query: text, charge }],
    nextState: SESSION_STATE.PRECEDENT_SEARCH,
    // A new query always resets paging, whether or not it was charged for -
    // otherwise "more" would continue the previous result set. The rows go with
    // the offset: a search that then fails must not leave the last one pageable.
    contextPatch: charge > 0 ? { lastChargedQuery: text, ...CLEARED_PRECEDENTS } : { ...CLEARED_PRECEDENTS },
  };
}

/**
 * Let a message through to the classifier, from a feature state, unbilled.
 *
 * ## Why a sign-off cannot stay in the feature state
 *
 * SECTION_INFO and PRECEDENT_SEARCH are sticky: the state survives the answer,
 * so the advocate can ask a second section without going back to the menu. That
 * is the right behaviour and it had a hole in it - *every* message arriving in
 * those states became a charged lookup, on the text as typed. Reading a section
 * explanation and replying "thanks" bought a retrieval over the word "thanks".
 * So did "ok", "great", "hi", and a full stop sent by a thumb.
 *
 * This is the case-status trap inverted. There, anything that was not a CNR got
 * an error forever; here, anything at all gets a bill. An error is at least
 * visible. A charge is not, and it lands on an advocate who was being polite.
 *
 * The message is not swallowed - it goes to the classifier, which answers a
 * greeting as small talk for free. The state returns to the menu, because
 * somebody who said "that's it" has finished with the feature.
 */
function released(text: string): Routed {
  return { actions: [{ kind: 'freeform', text }], nextState: SESSION_STATE.MAIN_MENU };
}

/**
 * Is this somebody trying to type a case reference, having been asked for one?
 *
 * Wider than {@link looksLikeCnrAttempt} on purpose. That function has to work
 * on any message in any state, so it demands 10+ characters and 6+ digits -
 * which is right there and wrong here. Having just been shown the CNR format
 * and asked for one, an advocate who sends "12345" is fumbling a reference, not
 * changing the subject, and deserves the format again rather than a retrieval
 * they get billed for.
 *
 * A single unbroken alphanumeric token with digits in it. "More", "ok" and
 * "thanks" have no digits; "That's it" is two tokens with an apostrophe.
 */
function looksLikeReference(text: string): boolean {
  if (looksLikeCnrAttempt(text)) return true;

  const trimmed = text.trim();
  return /^[A-Za-z0-9]+$/.test(trimmed) && (trimmed.match(/\d/g) ?? []).length >= 3;
}

/** Zero when this is the same question the advocate already paid for. */
function chargeFor(lastCharged: string | undefined, query: string, cost: number): number {
  return isSameSearchContext(lastCharged, query) ? 0 : cost;
}
