import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { RetrievedChunk, StatuteRow } from '../database/types';
import { EmbeddingService } from './embedding.service';
import { GuardrailsService } from './guardrails.service';
import { ClassifiedIntent } from './intent.service';
import { expandQuery } from './legal-patterns';
import {
  buildGeneralLegalPrompt,
  buildPrecedentSearchPrompt,
  buildSectionExplanationPrompt,
  buildSmallTalkPrompt,
  buildUnverifiedProvisionPrompt,
} from './prompts';
import { LlmMessage } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';

/**
 * Stages the pipeline actually passes through, in order.
 *
 * Reported to callers that want to show progress. Each one is emitted at the
 * moment the corresponding work begins, so a client rendering them is showing
 * what is happening rather than a decorative animation - which matters because
 * "Searching judgments" appearing while nothing is being searched is a lie the
 * user has no way to detect.
 */
export type RagStage = 'retrieving' | 'generating' | 'verifying';

/** Optional progress sink. Never awaited; a slow observer must not slow the answer. */
export type RagProgress = (stage: RagStage) => void;

export interface RagAnswer {
  text: string;
  citations: string[];
  passages: RetrievedChunk[];
  statutes: StatuteRow[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  guardrailTriggered: boolean;
  guardrailReason: string | null;
  /** True when no provider is configured and the answer is a placeholder. */
  mocked: boolean;
}

/**
 * The retrieval-augmented generation pipeline (spec section 9.1).
 *
 *   query
 *     -> expansion (synonyms)
 *     -> parallel: dense (pgvector) + lexical (tsvector)
 *     -> RRF fusion, in SQL
 *     -> prompt assembly with anti-hallucination rules
 *     -> generation
 *     -> citation verification
 *
 * Two deviations from the spec, both deliberate and both documented in the
 * README: fusion and retrieval happen inside Postgres rather than in Qdrant and
 * Elasticsearch, and there is no cross-encoder re-ranking stage. RRF over a
 * 50+50 candidate pool is a large fraction of the quality of a re-ranker at
 * none of the latency or infrastructure cost; a re-ranker is the obvious next
 * upgrade once there is real traffic to measure it against.
 */
@Injectable()
export class RagService {
  private readonly logger = getLogger().child({ module: 'rag' });

  constructor(
    private readonly corpus: CorpusRepository,
    private readonly embeddings: EmbeddingService,
    private readonly registry: ProviderRegistry,
    private readonly guardrails: GuardrailsService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /** Statute explanation. No case law retrieval; the acts table is authority enough. */
  async answerSectionLookup(
    intent: ClassifiedIntent,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = Date.now();

    onStage?.('retrieving');
    const statutes = await this.corpus.searchStatutes(
      intent.searchQuery,
      intent.sectionNumber,
      intent.actCode,
      3,
    );

    if (statutes.length === 0) {
      /*
       * Nothing in the corpus for a provision the advocate named by number.
       *
       * This fell through to the general prompt, which forbids stating any
       * section it was not given - so a question about Order 32 CPC produced an
       * answer that declined to say what Order 32 is. The seeded corpus is ~28
       * sections of the criminal codes; the CPC's Orders, the NI Act, the
       * Companies Act and most of what a civil practice runs on are simply not
       * in it, and refusing them all is refusing the product.
       *
       * A provision the advocate named is not a citation the model chose. It is
       * answered, from general knowledge, and labelled as unverified - see
       * buildUnverifiedProvisionPrompt for what stays forbidden.
       */
      const named = describeProvision(intent);
      if (named) {
        const system = buildUnverifiedProvisionPrompt(named, intent.language);
        return this.generate(system, intent, [], [], started, history, onStage);
      }

      // No provision named either - a general legal question, answered as one.
      return this.answerGeneral(intent, started, history, onStage);
    }

    const system = buildSectionExplanationPrompt(statutes, intent.language);
    return this.generate(system, intent, [], statutes, started, history, onStage);
  }

  /** Case law research over the judgment corpus. */
  async answerPrecedentSearch(
    intent: ClassifiedIntent,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = Date.now();

    onStage?.('retrieving');
    const expanded = expandQuery(intent.searchQuery);
    const embedding = await this.embeddings.embedQuery(expanded);

    const passages = await this.corpus.hybridSearch({
      queryText: expanded,
      embedding,
      denseK: this.env.RAG_DENSE_TOP_K,
      sparseK: this.env.RAG_SPARSE_TOP_K,
      rrfK: this.env.RAG_RRF_K,
      finalK: this.env.RAG_FINAL_TOP_K,
      sections: intent.sectionNumber && intent.actCode ? [`${intent.actCode} ${intent.sectionNumber}`] : null,
    });

    // Drop weak fusion scores. A passage that only just cleared the threshold
    // adds tokens and tempts the model to cite something barely relevant.
    const relevant = passages.filter((p) => p.score >= this.env.RAG_MIN_RELEVANCE);

    // If a section was named, include it - "bail under 437" needs both the
    // provision and the case law.
    const statutes = intent.sectionNumber
      ? await this.corpus.searchStatutes(intent.searchQuery, intent.sectionNumber, intent.actCode, 2)
      : [];

    this.logger.debug(
      {
        retrieved: passages.length,
        keptAfterThreshold: relevant.length,
        dense: Boolean(embedding),
        topScore: passages[0]?.score,
      },
      'Hybrid retrieval complete',
    );

    if (relevant.length === 0 && statutes.length === 0) {
      return this.answerGeneral(intent, started, history, onStage);
    }

    const system = buildPrecedentSearchPrompt(relevant, statutes, intent.language);
    return this.generate(system, intent, relevant, statutes, started, history, onStage);
  }

  /** No corpus support available; the prompt bars citing anything. */
  async answerGeneral(
    intent: ClassifiedIntent,
    startedAt?: number,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = startedAt ?? Date.now();
    const system = buildGeneralLegalPrompt(intent.language);
    return this.generate(system, intent, [], [], started, history, onStage);
  }

  /**
   * Greetings, thanks and "what can you do".
   *
   * Runs on the cheap router model, not the synthesis one - this is a
   * pleasantry, and paying synthesis rates for "hi" on every new user would be
   * a meaningful share of the bill.
   *
   * History is passed so a second "hi" in the same conversation does not get
   * the identical sentence back, which is what made the bot feel like a phone
   * tree. If the call fails the caller falls back to a fixed string; a greeting
   * is never worth failing a message over.
   */
  async answerSmallTalk(
    userMessage: string,
    language: string,
    userName: string | null,
    history: LlmMessage[] = [],
  ): Promise<string> {
    const result = await this.registry.complete({
      task: 'router',
      system: buildSmallTalkPrompt(language, userName),
      messages: [...history.slice(-4), { role: 'user', content: userMessage }],
      maxTokens: 300,
    });
    return result.text.trim();
  }

  /** Dispatch on intent. CASE_STATUS is handled upstream by the eCourts adapter. */
  async answer(
    intent: ClassifiedIntent,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    switch (intent.intent) {
      case 'SECTION_LOOKUP':
        return this.answerSectionLookup(intent, history, onStage);
      case 'PRECEDENT_SEARCH':
        return this.answerPrecedentSearch(intent, history, onStage);
      case 'DRAFTING_HELP':
      case 'GENERAL_LEGAL':
      default:
        // Drafting benefits from precedent context too, so route it through
        // retrieval rather than answering from nothing.
        return this.answerPrecedentSearch(intent, history, onStage);
    }
  }

  private async generate(
    system: string,
    intent: ClassifiedIntent,
    passages: RetrievedChunk[],
    statutes: StatuteRow[],
    startedAt: number,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    onStage?.('generating');
    const result = await this.registry.complete({
      task: 'synthesis',
      system,
      // Prior turns first, then the current question. History is already
      // trimmed and isolated per advocate by ChatMemoryService.
      messages: [...history, { role: 'user', content: intent.searchQuery }],
    });

    // Every generated answer passes through verification before anyone sees it.
    onStage?.('verifying');
    const checked = await this.guardrails.verify(result.text, passages);

    return {
      text: checked.text,
      citations: checked.verifiedCitations,
      passages,
      statutes,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedAt,
      guardrailTriggered: checked.triggered,
      guardrailReason: checked.reason,
      mocked: result.mocked === true,
    };
  }
}

/**
 * The provision the advocate named, as a phrase to put in a prompt.
 *
 * Null when they named none - "is anticipatory bail maintainable" is a legal
 * question, not a provision lookup, and answering it as though a provision had
 * been named would invite the model to pick one.
 */
function describeProvision(intent: ClassifiedIntent): string | null {
  if (!intent.sectionNumber) return null;

  const provision = intent.sectionNumber.trim();
  const act = intent.actCode;

  // "Order 32" already reads as a provision; a bare "302" needs the word.
  const head = /^(order|rule|article)\b/i.test(provision) ? provision : `Section ${provision}`;
  return act ? `${head} ${act}` : head;
}
