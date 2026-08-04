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
} from './prompts';
import { ProviderRegistry } from './providers/provider.registry';

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
  async answerSectionLookup(intent: ClassifiedIntent): Promise<RagAnswer> {
    const started = Date.now();

    const statutes = await this.corpus.searchStatutes(
      intent.searchQuery,
      intent.sectionNumber,
      intent.actCode,
      3,
    );

    if (statutes.length === 0) {
      // Nothing matched. Fall through to a general answer rather than
      // inventing one - the general prompt forbids citing sections outright.
      return this.answerGeneral(intent, started);
    }

    const system = buildSectionExplanationPrompt(statutes, intent.language);
    return this.generate(system, intent, [], statutes, started);
  }

  /** Case law research over the judgment corpus. */
  async answerPrecedentSearch(intent: ClassifiedIntent): Promise<RagAnswer> {
    const started = Date.now();

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
      return this.answerGeneral(intent, started);
    }

    const system = buildPrecedentSearchPrompt(relevant, statutes, intent.language);
    return this.generate(system, intent, relevant, statutes, started);
  }

  /** No corpus support available; the prompt bars citing anything. */
  async answerGeneral(intent: ClassifiedIntent, startedAt?: number): Promise<RagAnswer> {
    const started = startedAt ?? Date.now();
    const system = buildGeneralLegalPrompt(intent.language);
    return this.generate(system, intent, [], [], started);
  }

  /** Dispatch on intent. CASE_STATUS is handled upstream by the eCourts adapter. */
  async answer(intent: ClassifiedIntent): Promise<RagAnswer> {
    switch (intent.intent) {
      case 'SECTION_LOOKUP':
        return this.answerSectionLookup(intent);
      case 'PRECEDENT_SEARCH':
        return this.answerPrecedentSearch(intent);
      case 'DRAFTING_HELP':
      case 'GENERAL_LEGAL':
      default:
        // Drafting benefits from precedent context too, so route it through
        // retrieval rather than answering from nothing.
        return this.answerPrecedentSearch(intent);
    }
  }

  private async generate(
    system: string,
    intent: ClassifiedIntent,
    passages: RetrievedChunk[],
    statutes: StatuteRow[],
    startedAt: number,
  ): Promise<RagAnswer> {
    const result = await this.registry.complete({
      task: 'synthesis',
      system,
      messages: [{ role: 'user', content: intent.searchQuery }],
    });

    // Every generated answer passes through verification before anyone sees it.
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
