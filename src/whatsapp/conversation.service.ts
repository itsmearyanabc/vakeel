import { Injectable } from '@nestjs/common';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { IntentService } from '../ai/intent.service';
import { extractCnr } from '../ai/legal-patterns';
import { ChatMemoryService } from '../ai/memory/chat-memory.service';
import { PrecedentsService, formatPrecedentPage, prioritiseHomeCourt } from '../ai/precedents.service';
import { ProviderRegistry } from '../ai/providers/provider.registry';
import { RagService } from '../ai/rag.service';
import { TranscriptionService } from '../ai/transcription.service';
import { getLogger, maskPhone } from '../common/logger';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { ConversationRepository } from '../database/repositories/conversation.repository';
import { PrecedentRow, UserRow, WhatsAppUserRow } from '../database/types';
import { CnrNotFoundError, EcourtsService } from '../ecourts/ecourts.service';
import { CircuitOpenError } from '../common/circuit-breaker';
import { PhoneLinkService } from '../auth/phone-link.service';
import { CreditsService } from '../credits/credits.service';
import { InboundMessageJob } from '../jobs/queue.constants';
import { UsersService } from '../users/users.service';
import { buttonMessage, listMessage } from './message-builder';
import * as Replies from './replies';
import { route, SessionContext, SessionState } from './session.router';
import { ACTION } from './replies';
import { WhatsAppApiService } from './whatsapp-api.service';

/** Conversation states. Persisted so a half-finished flow survives a restart. */
const STATE = {
  IDLE: 'IDLE',
  AWAITING_CNR: 'AWAITING_CNR',
  AWAITING_QUERY: 'AWAITING_QUERY',
  AWAITING_SECTION: 'AWAITING_SECTION',
  AWAITING_BAR_ID: 'AWAITING_BAR_ID',
  AWAITING_ID_CARD: 'AWAITING_ID_CARD',
  /** Holding a precedent result set so "more" can page through it. */
  SHOWING_PRECEDENTS: 'SHOWING_PRECEDENTS',
} as const;

/**
 * How long a precedent result set stays pageable.
 *
 * Long enough that an advocate can read five judgments and ask for more; short
 * enough that "more" tomorrow does not silently continue yesterday's research.
 */
const PRECEDENT_SESSION_TTL_SECONDS = 3600;

/**
 * Did the advocate try to send a CNR, or change the subject?
 *
 * Having asked for a CNR, replying "I could not find that CNR" to *everything*
 * traps the user - "what is ipc 420" gets a CNR error forever and the only
 * escape is knowing to type "menu".
 *
 * The first attempt at this stripped whitespace and looked for a run of 10+
 * alphanumerics. That is wrong, and shipped: removing spaces turns ordinary
 * sentences into long runs, so "what is ipc 420" became "whatisipc420" (12
 * characters) and was read as a botched CNR.
 *
 * Length alone is not the discriminator either - that was the second wrong
 * answer. English is full of 10+ character words, so "punishment for cheating"
 * and "show me precedents on anticipatory bail" both looked like CNRs.
 *
 * **Digit density is the discriminator.** A CNR is 16 characters of which 10
 * are digits (4 letters + 2 alphanumeric + 6-digit case number + 4-digit year).
 * Ordinary legal English contains almost none. So:
 *
 *   - a single token, 10+ alphanumerics, 6+ of them digits -> an attempt
 *   - <= 4 tokens, 14+ alphanumerics, 8+ of them digits     -> an attempt
 *     (a CNR typed in groups, e.g. "DLCT01 000123 2024")
 *   - anything else                                         -> a new question
 *
 * Exported for tests: pure logic, and the regression it guards has reached
 * production twice.
 */
export function looksLikeCnrAttempt(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const alnum = (value: string): string => value.replace(/[^A-Za-z0-9]/g, '');
  const digits = (value: string): number => (value.match(/\d/g) ?? []).length;

  // One unbroken reference number, possibly mistyped.
  const hasReferenceToken = tokens.some((token) => {
    const compact = alnum(token);
    return compact.length >= 10 && digits(compact) >= 6;
  });
  if (hasReferenceToken) return true;

  // Or the same number typed in groups, which people do with long references.
  const whole = alnum(text);
  return tokens.length <= 4 && whole.length >= 14 && digits(whole) >= 8;
}

/**
 * The idempotency key a WhatsApp charge is recorded under.
 *
 * Derived from Meta's message id, which is stable across their retries - and
 * Meta retries aggressively. A reference built from a timestamp or a random
 * value would be unique per attempt, which is precisely the failure this key
 * exists to prevent: the same question charged twice because the webhook was
 * delivered twice.
 *
 * Shared by the charge and the refund so the two can be matched up. The
 * `spend:` prefix is load-bearing - `credit_refund()` rewrites it to `refund:`
 * to derive the reversing entry's own reference.
 */
export function spendReference(waMessageId: string): string {
  return `spend:wa:${waMessageId}`;
}

/**
 * The conversation state machine.
 *
 * This is where an inbound job becomes a reply. Ordering is deliberate:
 *
 *   1. resolve the user (created on first contact)
 *   2. normalise the message to text (transcribe voice, map button ids)
 *   3. handle stateful flows first - if we asked for a CNR, the next message
 *      is a CNR, not a new research question
 *   4. classify intent
 *   5. charge credits, but only for work that costs money
 *   6. answer, and record what happened
 *
 * Credits are charged at step 5 rather than at the top on purpose: navigating a
 * menu, changing language or asking for help must never cost anything.
 */
@Injectable()
export class ConversationService {
  private readonly logger = getLogger().child({ module: 'whatsapp:conversation' });

  /**
   * Onboarding is finished only when all four fields are on record.
   *
   * Checked rather than trusted from a flag, because a row can reach a partial
   * state several ways - an older account created before onboarding existed, a
   * merge, an interrupted session - and every one of them should be sent
   * through onboarding again rather than into a menu that will later fail on a
   * missing state.
   */
  private static profileComplete(user: UserRow): boolean {
    return Boolean(
      user.full_name && user.bar_council_id_hash && user.city && user.bar_council_state,
    );
  }

  constructor(
    private readonly api: WhatsAppApiService,
    private readonly users: UsersService,
    private readonly conversations: ConversationRepository,
    private readonly intents: IntentService,
    private readonly rag: RagService,
    private readonly precedents: PrecedentsService,
    private readonly memory: ChatMemoryService,
    private readonly ecourts: EcourtsService,
    private readonly credits: CreditsService,
    private readonly phoneLink: PhoneLinkService,
    private readonly analytics: AnalyticsRepository,
    private readonly transcription: TranscriptionService,
    private readonly registry: ProviderRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async handle(job: InboundMessageJob): Promise<void> {
    const user = await this.users.resolveFromPhone(job.from, job.profileName);

    if (user.is_blocked) {
      this.logger.debug({ userId: user.id }, 'Ignoring message from opted-out user');
      return;
    }

    // Blue ticks before the slow work, so the advocate can see it was received.
    void this.api.markAsRead(job.waMessageId);

    const text = await this.resolveText(job, user);
    if (text === null) return;

    // A bare six-digit number is almost certainly a web link code, so it is
    // checked before anything else - including the escape hatches, because a
    // code that collides with a menu shortcut must still link the account.
    //
    // Checked *only* when it matches a code that was actually issued for this
    // number. A six-digit message that is not a pending code falls straight
    // through and is answered as an ordinary question, which matters because
    // "302" and "420" are things advocates genuinely type.
    if (/^\d{6}$/.test(text.trim())) {
      const linked = await this.tryPhoneLink(user, text.trim(), job);
      if (linked) return;
    }

    // Universal escape hatches, checked before any state handling so a user can
    // always get out of a flow they entered by accident.
    const lower = text.trim().toLowerCase();
    if (['menu', 'options', 'मेन्यू'].includes(lower)) {
      // Typing "menu" is the word form of "0", so it must land on the same
      // screen. Clearing the state instead would restart the session and
      // re-ask for a language the advocate has already chosen.
      if (ConversationService.profileComplete(user)) {
        const balance = await this.credits.balance(user.id, user.role);
        await this.api.sendText(job.from, Replies.helpMenu(this.credits.creditLine(balance)));
        await this.conversations.set(
          user.id,
          'MAIN_MENU',
          {},
          this.env.SESSION_TTL_SECONDS,
        );
        return;
      }
      // No profile yet: there is no menu to reach, so fall through and let the
      // router send them through onboarding.
    }
    if (['stop', 'unsubscribe'].includes(lower)) {
      await this.users.setLanguage(user.id, user.preferred_language);
      // Opting out must also drop retained context, not just stop replies.
      await this.memory.clear(user.id);
      await this.api.sendText(job.from, 'You will not receive further messages. Send *start* to resume.');
      return;
    }

    // Let an advocate start a clean thread. Without this, a follow-up on a new
    // matter inherits context from the previous one and the model conflates
    // the two - which in legal research is worse than having no memory at all.
    if (['reset', 'new chat', 'clear', 'forget'].includes(lower)) {
      await this.memory.clear(user.id);
      await this.conversations.clear(user.id);
      await this.api.sendText(
        job.from,
        'Cleared. I have forgotten our previous conversation — ask me something new.',
      );
      return;
    }
    if (['verify', 'verification'].includes(lower)) {
      await this.beginVerification(user);
      return;
    }

    if (job.interactiveId) {
      await this.handleAction(user, job.interactiveId);
      return;
    }

    await this.runSession(user, text, job);
  }

  // ---------------------------------------------------------------------------
  // Session flow
  //
  // The decisions live in session.router.ts as a pure function; this half only
  // performs what it returns. Keeping them apart is what makes the flow
  // testable without a database, a queue or Meta - see session.router.spec.ts.
  // ---------------------------------------------------------------------------

  private async runSession(user: WhatsAppUserRow, text: string, job: InboundMessageJob): Promise<void> {
    // A row past its expires_at reads as null, which is exactly what the router
    // treats as "start a new session". The TTL is therefore the whole of the
    // session-expiry mechanism; there is no separate sweep.
    const stored = await this.conversations.get(user.id);
    const context: SessionContext = stored
      ? { ...(stored.context as Partial<SessionContext>), state: stored.state as SessionState }
      : { state: null };

    // Refreshing rather than peeking: this is the first thing that happens on
    // an inbound message, so it is also where the daily allowance rolls over.
    const balance = await this.credits.balance(user.id, user.role);

    const routed = route(
      text,
      context,
      {
        fullName: user.full_name,
        profileComplete: ConversationService.profileComplete(user),
      },
      this.credits.creditLine(balance),
    );

    // The router may replace the user we are acting on: submitting a bar
    // council ID that already has an account merges this number into it, and
    // everything afterwards - credits, state - belongs to that account.
    let acting: WhatsAppUserRow = user;
    let nextContext: SessionContext = { ...context, ...(routed.contextPatch ?? {}) };

    for (const action of routed.actions) {
      switch (action.kind) {
        case 'reply':
          await this.api.sendText(job.from, action.text);
          break;

        case 'saveProfile': {
          const result = await this.users.completeProfile(acting.id, action.profile);
          // The number this message arrived on is carried across explicitly.
          // completeProfile may return a *different* account - the one the Bar
          // Council ID already named - and adoptPhone has just moved this
          // handset onto it, so the row is reachable at this number by
          // construction even though its type cannot say so.
          if (result.accepted && result.user) {
            acting = { ...result.user, phone_number: acting.phone_number };
          }
          break;
        }

        case 'lookupCase':
          await this.answerCaseStatus(acting, action.cnr, text);
          break;

        case 'lookupSection':
          await this.answerSearch(acting, action.query, action.charge, job, 'SECTION');
          break;

        case 'searchPrecedents':
          await this.answerSearch(acting, action.query, action.charge, job, 'PRECEDENT');
          nextContext = { ...nextContext, precedentOffset: 0 };
          break;

        case 'nextPrecedentPage':
          await this.sendNextPrecedentPage(acting, job);
          break;

        default: {
          // Exhaustiveness: adding an Action variant without handling it here
          // is a compile error rather than a message the bot silently ignores.
          const unreachable: never = action;
          throw new Error(`Unhandled session action: ${JSON.stringify(unreachable)}`);
        }
      }
    }

    if (routed.nextState === null) {
      await this.conversations.clear(acting.id);
    } else if (routed.nextState) {
      await this.conversations.set(
        acting.id,
        routed.nextState,
        nextContext as unknown as Record<string, unknown>,
        this.env.SESSION_TTL_SECONDS,
      );
    }
  }

  /**
   * Charge, then answer a research question.
   *
   * ## Why the charge happens here and not in the router
   *
   * The router decides *how much* this costs; only this method knows whether
   * the advocate can afford it, because that needs Redis. Splitting it that way
   * keeps the billing rule (is this the same question?) unit-testable while the
   * balance check stays next to the work it guards.
   *
   * The claim is made before the model runs, because that is the only moment it
   * can prevent the spend. If delivery then fails, {@link answerWithRag} and
   * the precedent path refund it - a claim is a promise to deliver an answer.
   */
  private async answerSearch(
    user: WhatsAppUserRow,
    query: string,
    charge: number,
    job: InboundMessageJob,
    kind: 'SECTION' | 'PRECEDENT',
  ): Promise<void> {
    if (charge > 0) {
      const decision = await this.credits.spend({
        userId: user.id,
        role: user.role,
        cost: charge,
        action: kind === 'PRECEDENT' ? 'PRECEDENT_SEARCH' : 'SECTION_LOOKUP',
        // Keyed on Meta's message id, which is stable across their retries.
        // A webhook redelivered after our reply timed out therefore charges
        // once, not once per delivery attempt.
        reference: spendReference(job.waMessageId),
      });

      if (!decision.allowed) {
        await this.api.sendText(
          job.from,
          Replies.quotaExceeded(
            decision.balance.total,
            charge,
            decision.balance.monthlyAllowance,
            decision.balance.resetsInDays,
          ),
        );
        return;
      }
    }

    // Classification still runs: it extracts the section number and act code
    // the retrieval layer needs, and detects the language. What it no longer
    // does is decide *which feature* to run - the advocate already said that by
    // choosing from the menu, and overriding them with a model's guess is how
    // "2" for a section lookup used to end up as a precedent search.
    const intent = await this.intents.classify(query);

    if (kind === 'PRECEDENT') {
      await this.answerPrecedents(user, { ...intent, intent: 'PRECEDENT_SEARCH' }, query, job);
      return;
    }

    await this.answerWithRag(user, { ...intent, intent: 'SECTION_LOOKUP' }, query, job);
  }

  // ---------------------------------------------------------------------------
  // Input normalisation
  // ---------------------------------------------------------------------------

  /**
   * Reduce any inbound message type to text, or null if it cannot be handled
   * (in which case the user has already been told why).
   */
  private async resolveText(job: InboundMessageJob, user: WhatsAppUserRow): Promise<string | null> {
    switch (job.type) {
      case 'text':
      case 'interactive':
      case 'button':
        return job.text ?? '';

      case 'audio': {
        if (!job.mediaId || !this.transcription.isAvailable) {
          await this.api.sendText(job.from, Replies.TRANSCRIPTION_UNAVAILABLE);
          return null;
        }
        const media = await this.api.downloadMedia(job.mediaId);
        if (!media) {
          await this.api.sendText(job.from, Replies.TRANSCRIPTION_UNAVAILABLE);
          return null;
        }
        const transcript = await this.transcription.transcribe(media.buffer, media.mimeType);
        if (!transcript) {
          await this.api.sendText(job.from, Replies.TRANSCRIPTION_UNAVAILABLE);
          return null;
        }
        // Echo the transcript back: speech recognition on Indian legal
        // vocabulary is imperfect, and the advocate needs to see what was
        // actually understood before trusting the answer to it.
        await this.api.sendText(job.from, `_Heard:_ "${transcript}"`);
        return transcript;
      }

      case 'image': {
        const state = await this.conversations.get(user.id);
        if (state?.state === STATE.AWAITING_ID_CARD) {
          await this.handleIdCardUpload(user, job);
          return null;
        }
        // An image with a caption is usually a document photo plus a question.
        if (job.text) return job.text;
        await this.api.sendText(job.from, Replies.UNSUPPORTED_MESSAGE_TYPE);
        return null;
      }

      case 'document':
        if (job.text) return job.text;
        await this.api.sendText(job.from, Replies.UNSUPPORTED_MESSAGE_TYPE);
        return null;

      default:
        await this.api.sendText(job.from, Replies.UNSUPPORTED_MESSAGE_TYPE);
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Menu actions
  // ---------------------------------------------------------------------------

  private async handleAction(user: WhatsAppUserRow, actionId: string): Promise<void> {
    if (actionId.startsWith('lang:')) {
      const code = actionId.slice('lang:'.length);
      await this.users.setLanguage(user.id, code);
      const label = Replies.LANGUAGES.find((l) => l.code === code)?.label ?? code;
      await this.api.sendText(user.phone_number, `Language set to *${label}*.`);
      await this.sendMainMenu({ ...user, preferred_language: code });
      return;
    }

    switch (actionId) {
      case ACTION.MAIN_MENU:
        await this.conversations.clear(user.id);
        await this.sendMainMenu(user);
        return;

      case ACTION.CASE_STATUS:
        await this.conversations.set(user.id, STATE.AWAITING_CNR);
        await this.api.sendText(user.phone_number, Replies.ASK_FOR_CNR);
        return;

      case ACTION.RESEARCH:
        await this.conversations.set(user.id, STATE.AWAITING_QUERY);
        await this.api.sendText(user.phone_number, Replies.ASK_FOR_QUERY);
        return;

      case ACTION.SECTION_LOOKUP:
        await this.conversations.set(user.id, STATE.AWAITING_SECTION);
        await this.api.sendText(user.phone_number, Replies.ASK_FOR_SECTION);
        return;

      case ACTION.VERIFY:
        await this.beginVerification(user);
        return;

      case ACTION.LANGUAGE:
        await this.sendLanguageMenu(user);
        return;

      case ACTION.USAGE: {
        const [balance, searches] = await Promise.all([
          this.credits.balance(user.id, user.role),
          this.analytics.searchesToday(user.id),
        ]);
        await this.api.sendText(
          user.phone_number,
          Replies.usageSummary(
            this.credits.creditLine(balance),
            searches,
            user.verification_status === 'VERIFIED',
          ),
        );
        return;
      }

      case ACTION.HELP:
        await this.api.sendText(user.phone_number, Replies.HELP_TEXT);
        return;

      case ACTION.CANCEL:
        await this.conversations.clear(user.id);
        await this.sendMainMenu(user);
        return;

      default:
        this.logger.warn({ actionId }, 'Unknown interactive action');
        await this.sendMainMenu(user);
    }
  }

  private async sendMainMenu(user: WhatsAppUserRow): Promise<void> {
    await this.api.send(
      listMessage(
        user.phone_number,
        'What would you like to do?',
        'Open menu',
        Replies.MAIN_MENU_SECTIONS,
        { header: 'Vakeel Saathi', footer: 'Or just type your legal question' },
      ),
    );
  }

  private async sendLanguageMenu(user: WhatsAppUserRow): Promise<void> {
    await this.api.send(
      listMessage(
        user.phone_number,
        'Choose the language you would like replies in.',
        'Choose',
        [{ title: 'Languages', rows: Replies.LANGUAGES.map((l) => ({ id: `lang:${l.code}`, title: l.label })) }],
        { header: 'Language' },
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Stateful flows
  // ---------------------------------------------------------------------------

  /** Returns true when the message was consumed by the active flow. */
  private async handleStatefulInput(
    user: WhatsAppUserRow,
    state: string,
    text: string,
    job: InboundMessageJob,
  ): Promise<boolean> {
    switch (state) {
      case STATE.AWAITING_CNR: {
        const cnr = extractCnr(text);
        if (cnr) {
          await this.conversations.clear(user.id);
          await this.answerCaseStatus(user, cnr, text);
          return true;
        }

        if (!looksLikeCnrAttempt(text)) {
          // A change of subject, not a malformed CNR. Release the state and let
          // it be answered as an ordinary question.
          await this.conversations.clear(user.id);
          return false;
        }

        await this.api.sendText(job.from, Replies.CNR_NOT_FOUND);
        return true;
      }

      case STATE.AWAITING_BAR_ID: {
        // Same trap as AWAITING_CNR: without this, asking for an enrolment
        // number means every later message gets "that is not valid" until the
        // user guesses that "menu" is the way out. A bar council number always
        // contains digits, so a message with none is a change of subject.
        if (!/\d/.test(text)) {
          await this.conversations.clear(user.id);
          return false;
        }

        const result = await this.users.submitBarCouncilId(user.id, text);
        if (!result.accepted) {
          await this.api.sendText(
            job.from,
            result.reason === 'ALREADY_REGISTERED' ? Replies.BAR_ID_DUPLICATE : Replies.BAR_ID_INVALID,
          );
          return true;
        }
        await this.conversations.set(user.id, STATE.AWAITING_ID_CARD, {}, 1800);
        await this.api.sendText(job.from, Replies.BAR_ID_ACCEPTED);
        return true;
      }

      case STATE.AWAITING_ID_CARD:
        // A text message here means they chose not to send a card. Fall through
        // and treat it as a normal query rather than nagging.
        await this.conversations.clear(user.id);
        return false;

      case STATE.SHOWING_PRECEDENTS: {
        // Only "more" continues the list. Anything else is a new question, so
        // fall through - an advocate who follows up with a different query
        // should not have to escape a paging mode first.
        if (!/^(more|next|aur|और|continue|\d+)$/i.test(text.trim())) {
          await this.conversations.clear(user.id);
          return false;
        }
        await this.sendNextPrecedentPage(user, job);
        return true;
      }

      case STATE.AWAITING_QUERY:
      case STATE.AWAITING_SECTION:
        // The prompt was just a nudge; the message is a normal query.
        await this.conversations.clear(user.id);
        return false;

      default:
        return false;
    }
  }

  /**
   * Redeem a web account-linking code that arrived as a chat message.
   *
   * Returns true when the message was a genuine code and has been dealt with;
   * false when it was not, so the caller can carry on treating it as an
   * ordinary question. That distinction is the whole reason this returns a
   * boolean rather than replying itself - "420" is a section number far more
   * often than it is a link code, and swallowing it would break a real feature
   * to serve a rare one.
   */
  private async tryPhoneLink(
    user: WhatsAppUserRow,
    code: string,
    job: InboundMessageJob,
  ): Promise<boolean> {
    const outcome = await this.phoneLink.redeemCode(job.from, code);

    if (outcome.status === 'NO_PENDING_CODE') return false;

    if (outcome.status === 'TOO_MANY_ATTEMPTS') {
      await this.api.sendText(
        job.from,
        'Too many incorrect codes. Request a new one from the website and try again.',
      );
      return true;
    }

    // The account this number now belongs to may not be the one the message
    // arrived on: linking merges a web account into the WhatsApp one, and the
    // memory of the discarded row goes with it.
    await this.memory.clear(user.id);
    await this.conversations.clear(user.id);

    await this.api.sendText(
      job.from,
      outcome.merged
        ? [
            '*Account linked.*',
            '',
            'This number and your web account are now one account. Your credits, verification and history are shared across both.',
            '',
            'Carry on here, or continue on the website — it is the same conversation history either way.',
          ].join('\n')
        : [
            '*Account linked.*',
            '',
            'This number is now confirmed on your Vakeel Saathi account. You can use WhatsApp or the website with the same credits.',
          ].join('\n'),
    );

    return true;
  }

  private async beginVerification(user: WhatsAppUserRow): Promise<void> {
    if (user.verification_status === 'VERIFIED') {
      await this.api.sendText(user.phone_number, 'Your account is already verified. You have unlimited queries.');
      return;
    }
    if (user.verification_status === 'SUBMITTED') {
      await this.api.sendText(
        user.phone_number,
        'Your verification is already under review. You will get a message here once it is approved.',
      );
      return;
    }

    await this.conversations.set(user.id, STATE.AWAITING_BAR_ID, {}, 1800);
    await this.api.sendText(user.phone_number, Replies.ASK_FOR_BAR_COUNCIL_ID);
  }

  private async handleIdCardUpload(user: WhatsAppUserRow, job: InboundMessageJob): Promise<void> {
    // The image is acknowledged and the verification queued. Persisting the
    // file to Supabase Storage is left for the admin portal work - see the
    // README's "Not built yet" section; storing it here without the review UI
    // would mean holding an identity document nobody looks at.
    this.logger.info(
      { userId: user.id, mediaId: job.mediaId },
      'ID card received (not persisted - Storage upload pending admin portal)',
    );
    await this.conversations.clear(user.id);
    await this.api.sendText(job.from, Replies.ID_CARD_RECEIVED);
  }

  // ---------------------------------------------------------------------------
  // Answering
  // ---------------------------------------------------------------------------

  private async handleFreeformQuery(user: WhatsAppUserRow, text: string, job: InboundMessageJob): Promise<void> {
    const intent = await this.intents.classify(text);

    // Track the user's language automatically so replies match how they write,
    // without making them find the language menu.
    if (intent.language !== user.preferred_language && intent.confidence > 0.5) {
      await this.users.setLanguage(user.id, intent.language);
    }

    switch (intent.intent) {
      case 'SMALL_TALK': {
        // Deliberately not quota-checked: greeting the bot must never consume
        // one of an unverified advocate's five daily queries.
        const history = await this.memory.load(user.id);
        try {
          const reply = await this.rag.answerSmallTalk(
            text,
            intent.language,
            user.full_name ?? job.profileName ?? null,
            history,
          );
          if (reply) {
            await this.api.sendText(job.from, reply);
            await this.memory.append(user.id, text, reply);
            return;
          }
        } catch (err) {
          this.logger.warn({ err }, 'Small talk generation failed - using the fixed greeting');
        }
        // Fallback only. A greeting is never worth failing a message over.
        await this.api.sendText(job.from, 'Namaste. What can I help you with?');
        return;
      }

      case 'MENU_NAVIGATION':
        await this.sendMainMenu(user);
        return;

      case 'UNSUPPORTED':
        await this.api.sendText(
          job.from,
          'I only handle questions about Indian law. Type *menu* to see what I can do.',
        );
        return;

      case 'CASE_STATUS':
        if (intent.cnrNumber) {
          await this.answerCaseStatus(user, intent.cnrNumber, text);
        } else {
          await this.conversations.set(user.id, STATE.AWAITING_CNR);
          await this.api.sendText(job.from, Replies.ASK_FOR_CNR);
        }
        return;

      case 'PRECEDENT_SEARCH':
        await this.answerPrecedents(user, intent, text, job);
        return;

      default:
        await this.answerWithRag(user, intent, text, job);
    }
  }

  /**
   * Case status. Free - see CREDIT_COST.CASE_STATUS for why.
   *
   * This used to claim a unit of quota like any other answer. It no longer
   * charges at all: there is no model call behind it, and it is the thing an
   * advocate does standing outside a courtroom.
   */
  private async answerCaseStatus(user: WhatsAppUserRow, cnr: string, originalQuery: string): Promise<void> {
    const started = Date.now();

    try {
      const status = await this.ecourts.lookup(cnr);
      await this.api.sendText(user.phone_number, Replies.formatCaseStatus(status));

      await this.analytics.recordSearch({
        userId: user.id,
        queryText: originalQuery,
        detectedLanguage: user.preferred_language,
        resolvedQuery: cnr,
        intent: 'CASE_STATUS',
        citations: [],
        resultCount: 1,
        modelUsed: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        guardrailFlagged: false,
      });
    } catch (err) {
      if (err instanceof CnrNotFoundError) {
        await this.api.sendText(user.phone_number, Replies.CNR_NOT_FOUND);
        return;
      }
      if (err instanceof CircuitOpenError) {
        await this.api.sendText(user.phone_number, Replies.ECOURTS_UNAVAILABLE);
        return;
      }
      this.logger.error({ err, cnr }, 'CNR lookup failed');
      await this.api.sendText(user.phone_number, Replies.ECOURTS_UNAVAILABLE);
    }
  }

  /**
   * Priority feature 3: case law and precedent search.
   *
   * Deliberately does NOT go through the LLM. The deliverable is a list of real
   * authorities, and the surest way to guarantee every citation is real is for
   * no part of the list to be generated - each entry is assembled from corpus
   * rows. That also means this feature keeps working with no model provider
   * configured, which the RAG path cannot.
   *
   * The whole result set is stashed in the conversation so "more" pages through
   * it without re-running retrieval (and without spending another embedding
   * call on a query we already answered).
   */
  private async answerPrecedents(
    user: WhatsAppUserRow,
    intent: Awaited<ReturnType<IntentService['classify']>>,
    originalText: string,
    job: InboundMessageJob,
  ): Promise<void> {
    // Billing happens once, upstream in answerSearch(), which knows whether
    // this is a new question or the same one being pressed on. Claiming again
    // here charged twice for one search.
    const searched = await this.precedents.search(intent);

    // The advocate's own High Court binds them; everything else is persuasive.
    // A pure date sort buries the one authority they can actually cite.
    const result = {
      ...searched,
      precedents: prioritiseHomeCourt(searched.precedents, user.bar_council_state),
    };
    const pageSize = this.precedents.pageSize;

    const body = formatPrecedentPage(result.precedents, 0, pageSize, intent.searchQuery, {
      lexicalOnly: result.lexicalOnly,
      source: result.source,
    });
    await this.api.sendText(job.from, body);

    // Keep the set only when there is a second page to serve.
    if (result.precedents.length > pageSize) {
      await this.conversations.set(
        user.id,
        STATE.SHOWING_PRECEDENTS,
        { query: intent.searchQuery, offset: pageSize, lexicalOnly: result.lexicalOnly, source: result.source, rows: result.precedents },
        PRECEDENT_SESSION_TTL_SECONDS,
      );
    } else {
      await this.conversations.clear(user.id);
    }

    await this.analytics.recordSearch({
      userId: user.id,
      queryText: originalText,
      detectedLanguage: intent.language,
      resolvedQuery: intent.searchQuery,
      intent: 'PRECEDENT_SEARCH',
      // Every citation here came straight out of the corpus, so they are
      // verified by construction - nothing for the guardrail to strip.
      citations: result.precedents.map((p) => p.neutral_citation ?? p.reporter_citations?.[0] ?? p.case_title),
      resultCount: result.precedents.length,
      modelUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: result.latencyMs,
      guardrailFlagged: false,
    });

    this.logger.info(
      {
        userId: user.id,
        phone: maskPhone(user.phone_number),
        precedents: result.precedents.length,
        totalMatches: result.totalMatches,
        lexicalOnly: result.lexicalOnly,
        latencyMs: result.latencyMs,
      },
      'Precedent search answered',
    );
  }

  /** Serve the next page of a stored precedent result set. */
  private async sendNextPrecedentPage(user: WhatsAppUserRow, job: InboundMessageJob): Promise<void> {
    const state = await this.conversations.get(user.id);
    const context = (state?.context ?? {}) as {
      query?: string;
      offset?: number;
      lexicalOnly?: boolean;
      source?: 'local' | 'kanoon';
      rows?: PrecedentRow[];
    };

    const rows = context.rows ?? [];
    const offset = context.offset ?? 0;

    if (rows.length === 0 || offset >= rows.length) {
      await this.conversations.clear(user.id);
      await this.api.sendText(
        job.from,
        'That was the last result. Send another research question, or type *menu* for options.',
      );
      return;
    }

    const pageSize = this.precedents.pageSize;
    await this.api.sendText(
      job.from,
      formatPrecedentPage(rows, offset, pageSize, context.query ?? 'your search', {
        lexicalOnly: context.lexicalOnly,
        source: context.source,
      }),
    );

    const nextOffset = offset + pageSize;
    if (nextOffset < rows.length) {
      await this.conversations.set(
        user.id,
        STATE.SHOWING_PRECEDENTS,
        { ...context, offset: nextOffset },
        PRECEDENT_SESSION_TTL_SECONDS,
      );
    } else {
      await this.conversations.clear(user.id);
    }
  }

  private async answerWithRag(
    user: WhatsAppUserRow,
    intent: Awaited<ReturnType<IntentService['classify']>>,
    originalText: string,
    job: InboundMessageJob,
  ): Promise<void> {
    // Billing happens once, upstream in answerSearch(). See the note there.
    // Peeked rather than refreshed: the spend that just ran already rolled the
    // allowance over, and a second refresh here would be a wasted round trip.
    const balance = await this.credits.peek(user.id, user.role);

    // Prior turns for THIS advocate only - keyed by user id, so two people
    // messaging simultaneously can never pick up each other's context.
    const history = await this.memory.load(user.id);

    const answer = await this.rag.answer(intent, history);

    let text = answer.text.trim();
    if (!text) {
      text = 'I could not produce an answer for that. Try rephrasing, or type *menu* for other options.';
    }
    if (answer.mocked || this.registry.isFullyMocked) {
      text += Replies.MOCK_MODE_NOTICE;
    }

    // Appended here rather than asked of the model, which is why the prompt
    // tells it not to add a sign-off. A caveat the model writes is a caveat it
    // can also decide to omit, reword, or contradict - and this one is a
    // product commitment, not a stylistic preference.
    text += `\n\n${Replies.CAVEAT}\n\n${Replies.RETURN_TO_MENU}`;

    const delivery = await this.api.sendText(job.from, text);

    // Store the exchange after a successful send. Recording it before would
    // leave a reply in history that the advocate never actually received.
    // The raw question is stored, not the expanded/translated one, so the
    // model sees what the user actually wrote.
    if (delivery.ok) {
      await this.memory.append(user.id, originalText, answer.text.trim());
    }

    await this.analytics.recordSearch({
      userId: user.id,
      queryText: originalText,
      detectedLanguage: intent.language,
      resolvedQuery: intent.searchQuery,
      intent: intent.intent,
      citations: answer.citations,
      resultCount: answer.passages.length,
      modelUsed: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: answer.latencyMs,
      guardrailFlagged: answer.guardrailTriggered,
      guardrailReason: answer.guardrailReason,
    });

    // The send is what the advocate experiences, so it decides the log level.
    // An answer that was generated, billed and then refused by WhatsApp used to
    // log identically to one that arrived, which made "the bot ignored me"
    // reports impossible to confirm from the logs.
    this.logger.info(
      {
        userId: user.id,
        phone: maskPhone(user.phone_number),
        intent: intent.intent,
        passages: answer.passages.length,
        statutes: answer.statutes.length,
        citations: answer.citations.length,
        latencyMs: answer.latencyMs,
        guardrail: answer.guardrailTriggered,
        delivered: delivery.ok,
      },
      delivery.ok ? 'Query answered' : 'Query answered but the reply could not be delivered',
    );

    if (!delivery.ok) {
      // The model already ran, so the spend is sunk and still worth recording
      // above. The credits are not: they buy an answer, and none arrived.
      //
      // The reference is the same one answerSearch() charged against, which is
      // what lets the ledger return each credit to the bucket it came from
      // rather than guessing. A refund for a message that was never charged -
      // a free case status, an unlimited role - finds no matching rows and
      // does nothing.
      await this.credits.refund(
        user.id,
        user.role,
        spendReference(job.waMessageId),
        'WhatsApp refused delivery of the answer',
      );
      return;
    }

    // Nudge unverified users towards verification, but only when they are
    // actually close to the limit - doing it on every reply is nagging.
    // Nudge towards verification only when they are actually close to the
    // limit. On a monthly cycle the threshold is higher than it was daily -
    // five left out of thirty is the point where it is worth mentioning, and
    // doing it on every reply is nagging.
    if (user.verification_status !== 'VERIFIED' && !balance.unlimited && balance.total <= 5) {
      await this.api.send(
        buttonMessage(
          job.from,
          `You have *${balance.total}* ${balance.total === 1 ? 'credit' : 'credits'} left this month. Verified advocates get unlimited searches.`,
          [{ id: ACTION.VERIFY, title: 'Verify licence' }],
        ),
      );
    }
  }
}
