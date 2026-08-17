import { Injectable } from '@nestjs/common';
import { IntentService } from '../ai/intent.service';
import { extractCnr } from '../ai/legal-patterns';
import { PrecedentsService, prioritiseHomeCourt } from '../ai/precedents.service';
import { ProviderRegistry } from '../ai/providers/provider.registry';
import { RagService, RagStage } from '../ai/rag.service';
import { CircuitOpenError } from '../common/circuit-breaker';
import { getLogger } from '../common/logger';
import { CREDIT_COST, CreditBalance, CreditsService } from '../credits/credits.service';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { ChatRepository } from '../database/repositories/chat.repository';
import { ChatMessageRow, PrecedentRow, UserRow } from '../database/types';
import { CnrNotFoundError, EcourtsService } from '../ecourts/ecourts.service';
import { StageChannel } from './stage-channel';

/**
 * What the client is told while an answer is being produced.
 *
 * Every `stage` corresponds to a step that has actually started - see the
 * RagStage comment in rag.service.ts. Nothing here is a timer or an animation
 * pretending to be progress.
 */
export type ChatEvent =
  | { type: 'thread'; threadId: string; title: string }
  | { type: 'message'; message: PublicChatMessage }
  | { type: 'stage'; stage: ChatStage }
  | { type: 'answer'; message: PublicChatMessage; credits: CreditBalance; charged: number }
  | { type: 'error'; code: string; message: string; credits?: CreditBalance };

export type ChatStage = 'classifying' | 'looking-up' | 'searching' | RagStage;

export interface PublicChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: string | null;
  citations: string[];
  structured: Record<string, unknown> | null;
  creditsCharged: number;
  guardrailFlagged: boolean;
  error: string | null;
  createdAt: Date;
}

/**
 * The web chat.
 *
 * ## Why this is not the WhatsApp conversation service with a different output
 *
 * They share the pipeline underneath - the same intent classifier, the same
 * retrieval, the same guardrail - and they diverge above it, because the two
 * clients are not the same kind of thing.
 *
 * WhatsApp is a stateful text terminal: there is one conversation, the state
 * machine remembers where in a flow the advocate is, and the answer has to be
 * flattened into WhatsApp's own markup. The web client has many threads, no
 * modal flow to be stuck in, and a renderer - so a precedent list is delivered
 * as structured rows the browser lays out as cards, not as asterisks and line
 * breaks that have to be parsed back into fields.
 *
 * Trying to serve both from one method was the alternative, and it produces a
 * function whose every branch asks "which client is this" - which is two
 * functions wearing a trench coat.
 *
 * ## Why answering is synchronous here and queued there
 *
 * Meta expects a webhook acknowledged in well under a second and throttles
 * subscriptions that are slow, so the WhatsApp path must return immediately and
 * do the work on a queue. A browser waiting on its own fetch has no such
 * constraint - and the advocate is watching, so streaming stages back over the
 * open connection is better than a queue plus a polling loop.
 *
 * ## Streaming stages rather than tokens
 *
 * There is no token streaming, and that is a product decision rather than a
 * missing feature. The citation guardrail runs on the *complete* answer and
 * strips citations that are not in the corpus. Streaming raw model output would
 * put unverified citations on screen and then remove them - showing an advocate
 * a case that does not exist, however briefly, is precisely the failure this
 * whole system is built to prevent.
 */
@Injectable()
export class ChatService {
  private readonly logger = getLogger().child({ module: 'web:chat' });

  constructor(
    private readonly chats: ChatRepository,
    private readonly intents: IntentService,
    private readonly rag: RagService,
    private readonly precedents: PrecedentsService,
    private readonly ecourts: EcourtsService,
    private readonly credits: CreditsService,
    private readonly analytics: AnalyticsRepository,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * Ask a question and stream what happens.
   *
   * An async generator rather than a callback so the controller owns the
   * transport: the same sequence drives an SSE stream today and could fill a
   * plain JSON response by collecting it, without this method knowing which.
   */
  async *ask(input: {
    user: UserRow;
    threadId: string | null;
    question: string;
  }): AsyncGenerator<ChatEvent> {
    const question = input.question.trim();
    const user = input.user;

    if (!question) {
      yield { type: 'error', code: 'EMPTY', message: 'Type a question first.' };
      return;
    }

    // A thread is created on the first message rather than when the user
    // presses "New chat", so an abandoned empty thread never reaches the
    // sidebar.
    const thread = input.threadId
      ? await this.chats.findThread(user.id, input.threadId)
      : await this.chats.createThread(user.id);

    if (!thread) {
      yield { type: 'error', code: 'NO_THREAD', message: 'That conversation could not be found.' };
      return;
    }

    await this.chats.autoTitle(thread.id, question);
    yield { type: 'thread', threadId: thread.id, title: thread.title };

    const userMessage = await this.chats.appendMessage({
      threadId: thread.id,
      userId: user.id,
      role: 'user',
      content: question,
    });
    yield { type: 'message', message: toPublic(userMessage) };

    // The idempotency key for anything this turn charges. Derived from the
    // stored message id, which exists exactly once however many times the
    // client retries the request.
    const reference = `spend:web:${userMessage.id}`;

    try {
      yield* this.answer({ user, threadId: thread.id, question, reference });
    } catch (err) {
      this.logger.error({ err, userId: user.id, threadId: thread.id }, 'Web chat answer failed');

      // The credits are returned before the error is reported. A failure the
      // advocate can see, that also silently cost them two credits, is the
      // version of this that generates support mail.
      await this.credits.refund(user.id, user.role, reference, 'The answer could not be produced');

      const failed = await this.chats.appendMessage({
        threadId: thread.id,
        userId: user.id,
        role: 'assistant',
        content: 'Something went wrong while answering that. Your credits have not been charged.',
        errorDetail: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      });

      yield {
        type: 'error',
        code: 'ANSWER_FAILED',
        message: 'Something went wrong while answering that. Your credits have not been charged.',
        credits: await this.credits.peek(user.id, user.role),
      };
      yield { type: 'message', message: toPublic(failed) };
    }
  }

  private async *answer(input: {
    user: UserRow;
    threadId: string;
    question: string;
    reference: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, reference } = input;

    yield { type: 'stage', stage: 'classifying' };
    const intent = await this.intents.classify(question);

    // A CNR anywhere in the message is decisive. Someone who pastes a case
    // number wants that case, whatever else the sentence around it says, and
    // the classifier has no better information than the pattern does.
    const cnr = intent.cnrNumber ?? extractCnr(question);
    if (cnr) {
      yield* this.answerCaseStatus({ user, threadId, question, cnr });
      return;
    }

    const isPrecedentSearch = intent.intent === 'PRECEDENT_SEARCH';
    const cost = isPrecedentSearch ? CREDIT_COST.PRECEDENT_SEARCH : CREDIT_COST.SECTION_LOOKUP;

    // Small talk is free, and answered on the cheap router model. Charging two
    // credits for "thanks" would be indefensible, and refusing it would make
    // the product feel like a vending machine.
    if (intent.intent === 'SMALL_TALK') {
      yield* this.answerSmallTalk({ user, threadId, question, language: intent.language });
      return;
    }

    const decision = await this.credits.spend({
      userId: user.id,
      role: user.role,
      cost,
      action: isPrecedentSearch ? 'PRECEDENT_SEARCH' : 'SECTION_LOOKUP',
      reference,
    });

    if (!decision.allowed) {
      yield {
        type: 'error',
        code: 'INSUFFICIENT_CREDITS',
        message:
          decision.balance.total > 0
            ? `That search costs ${cost} credits and you have ${decision.balance.total} left.`
            : 'You have used all your credits for today. They reset tomorrow.',
        credits: decision.balance,
      };
      return;
    }

    if (isPrecedentSearch) {
      yield* this.answerPrecedents({ user, threadId, question, intent, charged: decision.charged });
      return;
    }

    yield* this.answerWithRag({ user, threadId, question, intent, charged: decision.charged });
  }

  // ---------------------------------------------------------------------------
  // Case status - free, no model call
  // ---------------------------------------------------------------------------

  private async *answerCaseStatus(input: {
    user: UserRow;
    threadId: string;
    question: string;
    cnr: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, cnr } = input;
    const started = Date.now();

    yield { type: 'stage', stage: 'looking-up' };

    try {
      const status = await this.ecourts.lookup(cnr);

      const message = await this.chats.appendMessage({
        threadId,
        userId: user.id,
        role: 'assistant',
        content: `Case status for ${cnr}`,
        intent: 'CASE_STATUS',
        // The whole record goes to the client as data. `mocked` travels with
        // it so the interface can label synthetic data as synthetic - an
        // advocate must never mistake the mock adapter's output for a court
        // record.
        structured: { kind: 'caseStatus', ...status },
        latencyMs: Date.now() - started,
        creditsCharged: 0,
      });

      await this.analytics.recordSearch({
        userId: user.id,
        queryText: question,
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

      yield {
        type: 'answer',
        message: toPublic(message),
        credits: await this.credits.peek(user.id, user.role),
        charged: 0,
      };
    } catch (err) {
      const reason =
        err instanceof CnrNotFoundError
          ? `No case found for CNR ${cnr}. Check the 16-character number and try again.`
          : err instanceof CircuitOpenError
            ? 'The court records service is not responding at the moment. Try again shortly.'
            : 'The court records service could not be reached. Try again shortly.';

      if (!(err instanceof CnrNotFoundError)) {
        this.logger.error({ err, cnr }, 'CNR lookup failed');
      }

      // Recorded as a message rather than thrown, so the advocate's question
      // and the reason it failed stay together in the thread. Case status is
      // free, so there is nothing to refund.
      const message = await this.chats.appendMessage({
        threadId,
        userId: user.id,
        role: 'assistant',
        content: reason,
        intent: 'CASE_STATUS',
        errorDetail: err instanceof Error ? err.name : 'unknown',
      });

      yield {
        type: 'answer',
        message: toPublic(message),
        credits: await this.credits.peek(user.id, user.role),
        charged: 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Precedents - structured rows, no model call
  // ---------------------------------------------------------------------------

  private async *answerPrecedents(input: {
    user: UserRow;
    threadId: string;
    question: string;
    intent: Awaited<ReturnType<IntentService['classify']>>;
    charged: number;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, intent, charged } = input;

    yield { type: 'stage', stage: 'searching' };

    const searched = await this.precedents.search(intent);

    // The advocate's own High Court binds them; everything else is persuasive.
    // A pure date sort buries the one authority they can actually cite.
    const rows = prioritiseHomeCourt(searched.precedents, user.bar_council_state);

    const citations = rows.map(
      (p) => p.neutral_citation ?? p.reporter_citations?.[0] ?? p.case_title,
    );

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      content: rows.length
        ? `${rows.length} ${rows.length === 1 ? 'authority' : 'authorities'} on "${intent.searchQuery}"`
        : `No judgments found for "${intent.searchQuery}".`,
      intent: 'PRECEDENT_SEARCH',
      // Every citation here came straight out of the corpus, so they are
      // verified by construction - there is nothing for the guardrail to strip
      // because no part of this list was generated.
      citations,
      structured: {
        kind: 'precedents',
        query: intent.searchQuery,
        source: searched.source,
        lexicalOnly: searched.lexicalOnly,
        totalMatches: searched.totalMatches,
        items: rows.map(toPublicPrecedent),
      },
      latencyMs: searched.latencyMs,
      creditsCharged: charged,
    });

    await this.analytics.recordSearch({
      userId: user.id,
      queryText: question,
      detectedLanguage: intent.language,
      resolvedQuery: intent.searchQuery,
      intent: 'PRECEDENT_SEARCH',
      citations,
      resultCount: rows.length,
      modelUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: searched.latencyMs,
      guardrailFlagged: false,
    });

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged,
    };
  }

  // ---------------------------------------------------------------------------
  // Retrieval-augmented answers
  // ---------------------------------------------------------------------------

  private async *answerWithRag(input: {
    user: UserRow;
    threadId: string;
    question: string;
    intent: Awaited<ReturnType<IntentService['classify']>>;
    charged: number;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, intent, charged } = input;

    const history = await this.chats.recentTurns(threadId, 10);

    // The pipeline reports each step as it begins, through a callback. The
    // channel bridges that to this generator so the stages reach the browser
    // while the work is happening - see stage-channel.ts for why replaying them
    // afterwards would make the progress display a decoration.
    const channel = new StageChannel<ChatStage>();

    const answerPromise = this.rag.answer(
      intent,
      // The current question is appended by the pipeline, so history must stop
      // short of it - it was already persisted above.
      history.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
      (stage) => channel.push(stage),
    );

    // Closed on both settlements. Without the rejection branch a failed answer
    // would leave this generator waiting on a stage that will never arrive, and
    // the request would hang until the client gave up rather than reporting the
    // error that already happened.
    void answerPromise.then(
      () => channel.close(),
      () => channel.close(),
    );

    for await (const stage of channel) {
      yield { type: 'stage', stage };
    }

    const answer = await answerPromise;
    const text = answer.text.trim();
    const mocked = answer.mocked || this.registry.isFullyMocked;

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      content:
        text ||
        'I could not produce an answer for that. Try rephrasing it, or ask about a specific section or judgment.',
      intent: intent.intent,
      citations: answer.citations,
      structured: {
        kind: 'answer',
        // Surfaced so the interface can say so plainly. An answer from the mock
        // provider is a placeholder, and an advocate who mistakes one for legal
        // research is the worst outcome this system has.
        mocked,
        statutes: answer.statutes.map((s) => ({
          actCode: s.act_code,
          actName: s.act_name,
          sectionNumber: s.section_number,
          sectionTitle: s.section_title,
        })),
        sources: answer.passages.map((p) => ({
          caseTitle: p.case_title,
          citation: p.neutral_citation ?? p.reporter_citations?.[0] ?? null,
          court: p.court_name,
          date: p.judgment_date,
          paragraph: p.para_number,
        })),
      },
      modelUsed: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: answer.latencyMs,
      creditsCharged: charged,
      guardrailFlagged: answer.guardrailTriggered,
      guardrailReason: answer.guardrailReason,
    });

    await this.analytics.recordSearch({
      userId: user.id,
      queryText: question,
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

    this.logger.info(
      {
        userId: user.id,
        threadId,
        intent: intent.intent,
        citations: answer.citations.length,
        latencyMs: answer.latencyMs,
        guardrail: answer.guardrailTriggered,
      },
      'Web query answered',
    );

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged,
    };
  }

  private async *answerSmallTalk(input: {
    user: UserRow;
    threadId: string;
    question: string;
    language: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, language } = input;

    yield { type: 'stage', stage: 'generating' };

    const history = await this.chats.recentTurns(threadId, 4);

    let reply = '';
    try {
      reply = await this.rag.answerSmallTalk(
        question,
        language,
        user.full_name,
        history.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
      );
    } catch (err) {
      this.logger.warn({ err }, 'Small talk generation failed - using the fixed greeting');
    }

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      // A greeting is never worth failing a message over.
      content: reply.trim() || 'Namaste. What can I help you with?',
      intent: 'SMALL_TALK',
      creditsCharged: 0,
    });

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged: 0,
    };
  }
}

function toPublic(row: ChatMessageRow): PublicChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    citations: row.citations ?? [],
    structured: row.structured,
    creditsCharged: row.credits_charged,
    guardrailFlagged: row.guardrail_flagged,
    error: row.error_detail,
    createdAt: row.created_at,
  };
}

/**
 * One judgment, as the browser receives it.
 *
 * An explicit projection rather than the row: `PrecedentRow` carries retrieval
 * internals - fusion scores, ranks, the total match count - which are useful for
 * debugging and meaningless to an advocate, and which would otherwise be shipped
 * to every client forever because nobody noticed they were there.
 */
function toPublicPrecedent(row: PrecedentRow) {
  return {
    id: row.judgment_id,
    title: row.case_title,
    citation: row.neutral_citation ?? row.reporter_citations?.[0] ?? null,
    otherCitations: row.reporter_citations ?? [],
    court: row.court_name,
    courtType: row.court_type,
    date: row.judgment_date,
    bench: row.bench ?? [],
    benchStrength: row.bench_strength,
    sections: row.act_sections ?? [],
    holding: row.ratio_decidendi ?? row.headnote ?? null,
    excerpt: row.best_excerpt,
    paragraph: row.para_number,
    disposition: row.disposition,
    sourceUrl: row.source_url,
  };
}
