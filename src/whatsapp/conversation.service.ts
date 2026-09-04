import { Injectable } from '@nestjs/common';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { IntentService } from '../ai/intent.service';
import { extractCnr } from '../ai/legal-patterns';
import { looksLikeCnrAttempt, looksLikeEnrolmentAttempt } from './onboarding';
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
import { CREDIT_COST, CreditAction, CreditsService } from '../credits/credits.service';
import { InboundMessageJob } from '../jobs/queue.constants';
import { UsersService } from '../users/users.service';
import { buttonMessage, listMessage } from './message-builder';
import * as Replies from './replies';
import { CLEARED_PRECEDENTS, route, SESSION_STATE, SessionContext, SessionState } from './session.router';
import { ACTION } from './replies';
import { WhatsAppApiService } from './whatsapp-api.service';

/**
 * States reached from the interactive list menu and the verification flow.
 *
 * Distinct from the router's SESSION_STATE, which covers the typed
 * conversation. Both are persisted to the same row, and runSession() decides
 * which machine a stored value belongs to - see isRouterState().
 *
 * SHOWING_PRECEDENTS used to live here, holding the result set "more" pages
 * through. It is part of the router's context now: two machines writing one row
 * is what made paging lose its rows in the first place.
 */
const STATE = {
  AWAITING_CNR: 'AWAITING_CNR',
  AWAITING_QUERY: 'AWAITING_QUERY',
  AWAITING_SECTION: 'AWAITING_SECTION',
  AWAITING_BAR_ID: 'AWAITING_BAR_ID',
  AWAITING_ID_CARD: 'AWAITING_ID_CARD',
} as const;

/**
 * How long a precedent result set stays pageable.
 *
 * Long enough that an advocate can read five judgments and ask for more; short
 * enough that "more" tomorrow does not silently continue yesterday's research.
 *
 * Applied as a floor on the session TTL while a result set is held, rather than
 * as a separate row's lifetime. Reading five judgments takes longer than the
 * ordinary session timeout allows for, and expiring the row underneath somebody
 * mid-page is the same bug as losing the rows outright.
 */
const PRECEDENT_SESSION_TTL_SECONDS = 3600;

/**
 * What answering a free-text message wants done to the conversation state.
 *
 * `patch` is merged into the router's context and written once, at the end of
 * the message. `ownsState` says the answer started a flow of its own and has
 * already written the row - the trailing write must then leave it alone, or the
 * "send me a CNR" prompt is immediately overwritten with the main menu and the
 * advocate's CNR is answered by asking for a CNR again.
 */
interface AnswerOutcome {
  patch?: Partial<SessionContext>;
  ownsState?: boolean;
}

/**
 * Is this a state the router understands?
 *
 * Two state machines write to `conversation_states`: this file's STATE, reached
 * from the interactive list menu and the verification flow, and the router's
 * SESSION_STATE, reached from typed messages. The router's switch falls through
 * to "back to the menu" on anything it does not recognise, so a STATE value
 * handed to it silently discards whatever flow the advocate was in.
 */
function isRouterState(state: string): state is SessionState {
  return Object.prototype.hasOwnProperty.call(SESSION_STATE, state);
}

/**
 * Re-exported from onboarding.ts, where it moved so the router can use the same
 * discriminator. Kept exported here because cnr-attempt.spec.ts imports it from
 * this module, and the regression it guards has reached production twice.
 */
export { looksLikeCnrAttempt };

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
 * WhatsApp's customer service window, less an hour of margin.
 *
 * Meta allows a free-form reply for 24 hours after the customer last wrote.
 * The margin exists because the boundary is not ours to measure: their clock
 * decides, the message may have queued, and a reply attempted at 23h59m loses
 * the race often enough to matter. An hour of margin costs a handful of very
 * old messages and removes a class of failure that is invisible until a real
 * advocate is on the other end of it.
 */
const SERVICE_WINDOW_SECONDS = 23 * 60 * 60;

/**
 * Exported for tests: pure logic, and it guards two independent replay paths -
 * Meta's webhook backlog and this queue's own stalled-job sweep.
 */
export function isStale(timestampSeconds: number): boolean {
  // A missing or nonsensical timestamp is treated as fresh. Guessing "old" on
  // bad data would silently drop live messages, which is the worse mistake.
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return false;
  return Math.floor(Date.now() / 1000) - timestampSeconds > SERVICE_WINDOW_SECONDS;
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
    if (isStale(job.timestamp)) {
      /*
       * A message old enough that we are no longer allowed to answer it.
       *
       * Meta retries a webhook for hours and holds a backlog when an endpoint
       * is unreachable, so changing the callback URL delivers everything that
       * queued up in the meantime - all at once, all at the new address. Those
       * messages are real but stale, and answering them is worse than dropping
       * them in three separate ways: the reply is refused with error 131047
       * once the 24-hour service window has closed, the advocate gets an answer
       * to something they asked yesterday with no idea why, and the credit is
       * spent either way because the charge happens before the send.
       *
       * Dropped before the user lookup so a backlog costs nothing but a log
       * line.
       */
      this.logger.warn(
        {
          from: maskPhone(job.from),
          waMessageId: job.waMessageId,
          ageSeconds: Math.floor(Date.now() / 1000) - job.timestamp,
        },
        'Dropping an inbound message older than the service window',
      );
      return;
    }

    const user = await this.users.resolveFromPhone(job.from, job.profileName);

    /*
     * Isolation invariant: this conversation may only ever reply to the handset
     * it came from.
     *
     * Downstream is split - some paths send to `job.from`, others to
     * `user.phone_number` - and the two are the same number by construction,
     * because findOrCreate looks the row up *by* the number it was given. That
     * is a fact about code somewhere else, though, and the failure if it ever
     * stops being true is one advocate's legal research delivered to another
     * advocate's phone. That is not a bug to discover from a support ticket.
     *
     * So it is checked rather than remembered, and corrected rather than
     * thrown: a reply that goes to the right person while an alarm fires is
     * strictly better than no reply at all, and better than a reply to the
     * wrong person by an enormous margin.
     */
    if (user.phone_number !== job.from) {
      this.logger.error(
        {
          userId: user.id,
          rowNumber: maskPhone(user.phone_number ?? ''),
          inboundNumber: maskPhone(job.from),
        },
        'Resolved account does not match the sending number - replying to the sender',
      );
      user.phone_number = job.from;
    }

    if (user.is_blocked) {
      /*
       * The one message an opted-out account is still allowed to send.
       *
       * The goodbye tells them to send *start* to come back, and until now
       * nothing acted on it: this early return sits above every text handler,
       * so the word could never reach one. An opt-out with no way back is a
       * one-way door we invited people through.
       *
       * Matched against the raw job text rather than after resolveText,
       * because everything that method does - downloading media, transcribing
       * a voice note, replying that a type is unsupported - is exactly the
       * contact that opting out asked us to stop.
       */
      const said = (job.text ?? '').trim().toLowerCase().replace(/[!.]+$/, '');
      if ((Replies.RESUME_WORDS as readonly string[]).includes(said)) {
        await this.users.setBlocked(user.id, false);
        user.is_blocked = false;
        await this.api.sendText(job.from, Replies.RESUBSCRIBED);
        return;
      }

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
      /*
       * This is what actually stops the messages.
       *
       * It used to call setLanguage() with the language the row already held -
       * a write that changed nothing - and then promise the advocate they
       * would hear nothing further. `is_blocked` stayed false, the guard at
       * the top of this method kept letting their messages through, and the
       * bot kept answering. An opt-out that does not opt anybody out is worse
       * than no opt-out at all, because the person stops looking for one.
       *
       * The reply goes out before the block, since afterwards the guard would
       * refuse it - and a goodbye nobody receives leaves them typing *stop*
       * again.
       */
      await this.memory.clear(user.id);
      await this.conversations.clear(user.id);
      await this.api.sendText(job.from, Replies.UNSUBSCRIBED);
      await this.users.setBlocked(user.id, true);
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
    /*
     * Both reads at once. Neither depends on the other, and on the free tier
     * every round trip to Supabase is a real slice of the reply.
     *
     * A row past its expires_at reads as null, which is exactly what the router
     * treats as "start a new session". The TTL is therefore the whole of the
     * session-expiry mechanism; there is no separate sweep.
     *
     * The balance is refreshed rather than peeked: this is the first thing that
     * happens on an inbound message, so it is also where the monthly allowance
     * rolls over. Refreshing it is idempotent, which is what makes it safe to
     * start before we know whether the message even reaches the router.
     */
    const [initialState, balance] = await Promise.all([
      this.conversations.get(user.id),
      this.credits.balance(user.id, user.role),
    ]);
    let stored = initialState;

    /*
     * A flow started from the interactive menu, not from the router.
     *
     * handleAction() and beginVerification() write this file's STATE values -
     * AWAITING_CNR, AWAITING_BAR_ID, AWAITING_ID_CARD - and handleStatefulInput()
     * exists to consume them. Nothing called it. So every one of those flows
     * asked a question and then routed the answer through the router, whose
     * switch does not know those states and returns the main menu: tapping
     * "Case status" and sending a CNR bounced back to the menu, and *verify*
     * asked for a bar council enrolment number that could never be recorded.
     *
     * When the flow releases the message - a change of subject rather than the
     * answer it asked for - it clears its own state and returns false, and the
     * message continues as if the advocate were at the menu. Not as a new
     * session: re-greeting somebody mid-conversation, and re-asking for a
     * language they already chose, is its own bug.
     */
    if (stored && !isRouterState(stored.state)) {
      const consumed = await this.handleStatefulInput(user, stored.state, text, job);
      if (consumed) return;
      stored = { ...stored, state: SESSION_STATE.MAIN_MENU, context: {} };
    }

    const context: SessionContext = stored
      ? { ...(stored.context as Partial<SessionContext>), state: stored.state as SessionState }
      : { state: null };

    const routed = route(
      text,
      context,
      {
        fullName: user.full_name,
        profileComplete: ConversationService.profileComplete(user),
      },
      this.credits.creditLine(balance),
      this.env.APP_PUBLIC_URL,
    );

    // The router may replace the user we are acting on: submitting a bar
    // council ID that already has an account merges this number into it, and
    // everything afterwards - credits, state - belongs to that account.
    let acting: WhatsAppUserRow = user;
    let nextContext: SessionContext = { ...context, ...(routed.contextPatch ?? {}) };
    // Set when an answer started a flow of its own and wrote the row itself.
    // See AnswerOutcome.
    let stateOwnedByAnswer = false;

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
          // Charged here rather than inside answerCaseStatus, which the
          // free-text path also reaches with its own charge already taken.
          if (await this.chargeOrExplain(acting, job, 'CASE_STATUS', action.charge)) {
            await this.answerCaseStatus(acting, action.cnr, text, job);
          }
          break;

        case 'lookupSection':
          await this.answerSearch(acting, action.query, action.charge, job, 'SECTION');
          break;

        case 'searchPrecedents':
          // The patch carries the result set the next "more" pages through. It
          // is merged rather than written here so the whole message produces
          // one state write - see answerPrecedents().
          nextContext = {
            ...nextContext,
            ...(await this.answerSearch(acting, action.query, action.charge, job, 'PRECEDENT')),
          };
          break;

        case 'nextPrecedentPage':
          nextContext = {
            ...nextContext,
            ...(await this.sendNextPrecedentPage(acting, job, nextContext)),
          };
          break;

        case 'freeform': {
          const outcome = await this.handleFreeformQuery(acting, action.text, job);
          nextContext = { ...nextContext, ...(outcome.patch ?? {}) };
          if (outcome.ownsState) stateOwnedByAnswer = true;
          break;
        }

        default: {
          // Exhaustiveness: adding an Action variant without handling it here
          // is a compile error rather than a message the bot silently ignores.
          const unreachable: never = action;
          throw new Error(`Unhandled session action: ${JSON.stringify(unreachable)}`);
        }
      }
    }

    if (stateOwnedByAnswer) return;

    if (routed.nextState === null) {
      await this.conversations.clear(acting.id);
    } else if (routed.nextState ?? context.state) {
      await this.conversations.set(
        acting.id,
        // An omitted nextState means "leave the state where it is", which is not
        // the same as "write nothing": the context still has to be saved, or an
        // action's patch - the advanced paging offset, most of all - is computed,
        // used to render a reply, and then thrown away.
        (routed.nextState ?? context.state) as SessionState,
        nextContext as unknown as Record<string, unknown>,
        // A held result set outlives the ordinary session timeout: reading five
        // judgments takes longer than two minutes, and letting the row expire
        // underneath somebody halfway through loses the same rows the write
        // above exists to keep.
        nextContext.precedentRows?.length
          ? Math.max(this.env.SESSION_TTL_SECONDS, PRECEDENT_SESSION_TTL_SECONDS)
          : this.env.SESSION_TTL_SECONDS,
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
  /**
   * Take payment for a query, or explain why it cannot run.
   *
   * Extracted so the menu path and the free-text path bill through the same
   * code. They used to differ: `answerSearch` charged and `handleFreeformQuery`
   * called the answer methods directly, which billed nothing at all. Two
   * billing paths is one more than a product with credits can afford, and the
   * one that was wrong was the one that gave the work away.
   *
   * Returns false when the advocate has been told they are out of credits, so
   * every caller can simply stop.
   */
  private async chargeOrExplain(
    user: WhatsAppUserRow,
    job: InboundMessageJob,
    action: CreditAction,
    charge: number = CREDIT_COST[action],
  ): Promise<boolean> {
    if (charge <= 0) return true;

    const decision = await this.credits.spend({
      userId: user.id,
      role: user.role,
      cost: charge,
      action,
      // Keyed on Meta's message id, which is stable across their retries. A
      // webhook redelivered after our reply timed out therefore charges once,
      // not once per delivery attempt.
      reference: spendReference(job.waMessageId),
    });

    if (!decision.allowed) {
      await this.api.sendText(
        job.from,
        Replies.quotaExceeded(
          decision.balance.total,
          charge,
          decision.balance.monthlyAllowance,
        ),
      );
      return false;
    }

    return true;
  }

  /**
   * Returns whatever the answer wants remembered for the next message - the
   * precedent result set, when there was one. Nothing else carries state.
   */
  private async answerSearch(
    user: WhatsAppUserRow,
    query: string,
    charge: number,
    job: InboundMessageJob,
    kind: 'SECTION' | 'PRECEDENT',
  ): Promise<Partial<SessionContext>> {
    const paid = await this.chargeOrExplain(
      user,
      job,
      kind === 'PRECEDENT' ? 'PRECEDENT_SEARCH' : 'SECTION_LOOKUP',
      charge,
    );
    // Nothing ran, so nothing was retrieved; whatever was pageable before is
    // still pageable, and clearing it here would punish being out of credits
    // by also throwing away the search that was already paid for.
    if (!paid) return {};

    // Classification still runs: it extracts the section number and act code
    // the retrieval layer needs, and detects the language. What it no longer
    // does is decide *which feature* to run - the advocate already said that by
    // choosing from the menu, and overriding them with a model's guess is how
    // "2" for a section lookup used to end up as a precedent search.
    const intent = await this.intents.classify(query);

    if (kind === 'PRECEDENT') {
      return this.answerPrecedents(user, { ...intent, intent: 'PRECEDENT_SEARCH' }, query, job);
    }

    await this.answerWithRag(user, { ...intent, intent: 'SECTION_LOOKUP' }, query, job);
    return {};
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
          /*
           * Charged, like every other route to the same lookup.
           *
           * This used to note that the flow took no charge of its own, so the
           * refund inside answerCaseStatus matched no ledger rows and did
           * nothing. That was accurate and it made this the free door: tapping
           * "Case status" in the list menu and sending a CNR cost nothing,
           * while typing the same CNR cost a credit. One feature with two
           * prices depending on how you reached it is the exact difference
           * nobody reports as a bug and everybody notices.
           *
           * With the charge here, the refund on a failed lookup has rows to
           * reverse - which is the other half of what was quietly missing.
           */
          if (await this.chargeOrExplain(user, job, 'CASE_STATUS')) {
            await this.answerCaseStatus(user, cnr, text, job);
          }
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
        /*
         * Same trap as AWAITING_CNR, and the release test was too narrow.
         *
         * "A message with no digits is a change of subject" is true and does
         * not cover the cases that matter: almost every legal question has a
         * number in it. "What is IPC 420", "section 138 NI Act", "punishment
         * under 302" all contain digits, so all three were submitted as
         * enrolment numbers, rejected, and answered with "that is not a valid
         * Bar Council ID" - for that message and every message after it, for
         * the full half-hour the state lives. The advocate had done nothing
         * but ask a question while a verification prompt was open.
         *
         * An enrolment number is a short reference, not a sentence. Both
         * signals are needed: digits, and the shape of something being quoted
         * rather than asked.
         */
        if (!looksLikeEnrolmentAttempt(text)) {
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
      await this.api.sendText(user.phone_number, 'Your account is already verified.');
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

  /**
   * Returns what the answer wants remembered, on the same contract as
   * {@link answerSearch}: a precedent search hands back the result set so
   * "more" can page it, and everything else hands back nothing.
   */
  private async handleFreeformQuery(
    user: WhatsAppUserRow,
    text: string,
    job: InboundMessageJob,
  ): Promise<AnswerOutcome> {
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
            return {};
          }
        } catch (err) {
          this.logger.warn({ err }, 'Small talk generation failed - using the fixed greeting');
        }
        // Fallback only. A greeting is never worth failing a message over.
        await this.api.sendText(job.from, 'Namaste. What can I help you with?');
        return {};
      }

      case 'MENU_NAVIGATION':
        await this.sendMainMenu(user);
        return {};

      case 'UNSUPPORTED':
        await this.api.sendText(
          job.from,
          'I only handle questions about Indian law. Type *menu* to see what I can do.',
        );
        return {};

      case 'CASE_STATUS':
        if (intent.cnrNumber) {
          if (!(await this.chargeOrExplain(user, job, 'CASE_STATUS'))) return {};
          await this.answerCaseStatus(user, intent.cnrNumber, text, job);
        } else {
          await this.conversations.set(user.id, STATE.AWAITING_CNR);
          await this.api.sendText(job.from, Replies.ASK_FOR_CNR);
          // The prompt owns the state now, so the router's trailing write must
          // not put MAIN_MENU back over the top of it.
          return { ownsState: true };
        }
        return {};

      case 'PRECEDENT_SEARCH':
        // Billed here rather than inside answerPrecedents, which is also
        // reached from the menu path where answerSearch has already charged.
        if (!(await this.chargeOrExplain(user, job, 'PRECEDENT_SEARCH'))) return {};
        return { patch: await this.answerPrecedents(user, intent, text, job) };

      default:
        // SECTION_LOOKUP, GENERAL_LEGAL and DRAFTING_HELP all end in retrieval
        // and all cost the same, so they share one charge.
        if (!(await this.chargeOrExplain(user, job, 'SECTION_LOOKUP'))) return {};
        await this.answerWithRag(user, intent, text, job);
        return {};
    }
  }

  /**
   * Case status.
   *
   * Charged - one credit, see CREDIT_COST.CASE_STATUS - by the caller, before
   * this runs. It was free while eCourts was a mocked adapter, and this comment
   * still said so long after the price changed. The charge is refunded here on
   * every failure; see the catch block.
   */
  private async answerCaseStatus(
    user: WhatsAppUserRow,
    cnr: string,
    originalQuery: string,
    job: InboundMessageJob,
  ): Promise<void> {
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
      /*
       * The credit goes back on every failure.
       *
       * This mattered less when a CNR lookup was free - the catch block simply
       * apologised. Now that it is priced, an advocate who sends a valid CNR
       * and gets "court records are unavailable" has paid for nothing, and the
       * most likely cause of a run of those is our own misconfiguration rather
       * than anything they did.
       *
       * `CnrNotFoundError` is refunded too, which is the arguable one. A case
       * that genuinely does not exist did consume an upstream call - but the
       * advocate cannot tell that outcome apart from a wrong base URL, and
       * charging for "no such case" is how a typo becomes a complaint.
       *
       * Same reference the charge used, so the ledger returns each credit to
       * the bucket it came from. A refund for a message that was never charged
       * - a repeat lookup, an unlimited role - matches no rows and does
       * nothing.
       */
      await this.credits
        .refund(user.id, user.role, spendReference(job.waMessageId), 'Case status lookup failed')
        .catch((refundErr) => this.logger.warn({ refundErr, cnr }, 'Could not refund a failed lookup'));

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
  ): Promise<Partial<SessionContext>> {
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
      namedCase: result.namedCase,
    });
    await this.api.sendText(job.from, body);

    /*
     * The result set is handed back, not written.
     *
     * It used to be written here, as a state of its own, and then runSession()
     * wrote the router's state over the top of it a few lines later - one row,
     * two writers, last one wins. The rows were gone before the advocate could
     * type "more", so paging answered "that was the last result" on every
     * search that had a second page.
     *
     * Returning a patch puts the whole message's state in one write, at the end,
     * where the router's own decision already lands.
     */
    const paging: Partial<SessionContext> =
      result.precedents.length > pageSize
        ? {
            precedentQuery: intent.searchQuery,
            precedentOffset: pageSize,
            precedentRows: result.precedents,
            precedentLexicalOnly: result.lexicalOnly,
            precedentSource: result.source,
            precedentNamedCase: result.namedCase,
          }
        : CLEARED_PRECEDENTS;

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

    return paging;
  }

  /**
   * Serve the next page of the stored precedent result set.
   *
   * Reads the set from the context it was given rather than from the database,
   * because runSession() is holding the only authoritative copy - it has not
   * been written yet, and re-reading the row would return whatever the previous
   * message left there.
   */
  private async sendNextPrecedentPage(
    user: WhatsAppUserRow,
    job: InboundMessageJob,
    context: SessionContext,
  ): Promise<Partial<SessionContext>> {
    const rows = (context.precedentRows ?? []) as PrecedentRow[];
    const offset = context.precedentOffset ?? 0;

    if (rows.length === 0 || offset >= rows.length) {
      // The same sentence the router sends when nothing is held at all. Two
      // wordings for one situation just makes an advocate wonder which of them
      // meant something different.
      await this.api.sendText(job.from, Replies.NOTHING_MORE);
      return CLEARED_PRECEDENTS;
    }

    const pageSize = this.precedents.pageSize;
    await this.api.sendText(
      job.from,
      formatPrecedentPage(rows, offset, pageSize, context.precedentQuery ?? 'your search', {
        lexicalOnly: context.precedentLexicalOnly,
        source: context.precedentSource,
        namedCase: context.precedentNamedCase,
      }),
    );

    const nextOffset = offset + pageSize;
    return nextOffset < rows.length
      ? { precedentOffset: nextOffset }
      : CLEARED_PRECEDENTS;
  }

  private async answerWithRag(
    user: WhatsAppUserRow,
    intent: Awaited<ReturnType<IntentService['classify']>>,
    originalText: string,
    job: InboundMessageJob,
  ): Promise<void> {
    /*
     * Billing happens once, upstream in answerSearch(). See the note there.
     * Peeked rather than refreshed: the spend that just ran already rolled the
     * allowance over, and a second refresh here would be a wasted round trip.
     *
     * History is loaded alongside it rather than after it. These were two
     * serial round trips sitting directly in front of the slowest call in the
     * product, and the balance is not read until after the answer comes back -
     * it only decides whether to show the verification nudge.
     *
     * History is prior turns for THIS advocate only - keyed by user id, so two
     * people messaging simultaneously can never pick up each other's context.
     */
    const [balance, history] = await Promise.all([
      this.credits.peek(user.id, user.role),
      this.memory.load(user.id),
    ]);

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
          `You have *${balance.total}* ${balance.total === 1 ? 'credit' : 'credits'} left.`,
          [{ id: ACTION.VERIFY, title: 'Verify licence' }],
        ),
      );
    }
  }
}
