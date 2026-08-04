import { createHash } from 'node:crypto';
import { AppEnv } from '../../config/env';
import { EmbeddingProvider, LlmProvider, LlmRequest, LlmResult } from './llm-provider.interface';

/**
 * Offline stand-ins for the LLM and embedding providers.
 *
 * These exist so the entire pipeline - webhook, queue, retrieval, guardrails,
 * WhatsApp reply - can be run and tested before any API key exists, and so CI
 * never needs credentials. They are deterministic, which also makes them usable
 * as test fixtures.
 *
 * Every mock answer is visibly labelled. Silent plausible-looking fake legal
 * output is the one failure mode this project cannot afford.
 */

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';

  constructor(private readonly env: AppEnv) {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    const text = request.json
      ? JSON.stringify(this.classify(lastUser))
      : this.synthesise(lastUser, request.system);

    return {
      text,
      model: 'mock',
      // Rough word-count stand-in; keeps the analytics columns populated with
      // something proportional rather than zero.
      inputTokens: Math.ceil((request.system.length + lastUser.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      mocked: true,
    };
  }

  /**
   * Keyword intent classification.
   *
   * Mirrors the JSON contract the real router prompt asks for, so swapping in a
   * live provider changes accuracy but not the shape of anything downstream.
   */
  private classify(query: string): Record<string, unknown> {
    const q = query.toLowerCase();

    const cnr = /\b[A-Z]{4}[A-Z0-9]{2}\d{6}\d{4}\b/i.exec(query.replace(/[\s-]/g, ''));
    const section = /\b(?:section|sec|s\.?)\s*(\d+[A-Z]?)\b/i.exec(query);
    const act = /\b(ipc|bns|crpc|bnss|iea|bsa)\b/i.exec(query);

    let intent = 'GENERAL_LEGAL';
    if (cnr) intent = 'CASE_STATUS';
    else if (section || act) intent = 'SECTION_LOOKUP';
    else if (/\b(precedent|judgment|judgement|case law|ruling|held|bail|acquitt)\b/.test(q))
      intent = 'PRECEDENT_SEARCH';
    else if (/\b(draft|notice|petition|affidavit|application)\b/.test(q)) intent = 'DRAFTING_HELP';
    else if (/^(hi|hello|hey|namaste|thanks|thank you|ok|okay)\b/.test(q.trim())) intent = 'SMALL_TALK';
    else if (/\b(menu|help|start|options)\b/.test(q)) intent = 'MENU_NAVIGATION';

    return {
      intent,
      language: /[ऀ-ॿ]/.test(query) ? 'hi' : 'en',
      cnr_number: cnr ? cnr[0].toUpperCase() : null,
      section_number: section ? section[1].toUpperCase() : null,
      act_code: act ? act[1].toUpperCase() : null,
      search_query: query,
      confidence: 0.5,
    };
  }

  private synthesise(query: string, system: string): string {
    // The orchestrator injects retrieved passages into the system prompt; echo
    // back whether any were found so a developer can see retrieval working
    // independently of generation.
    const hasContext = /RETRIEVED (PASSAGES|CONTEXT)/i.test(system);

    return [
      '_[Mock response - no LLM provider is configured]_',
      '',
      `You asked: "${query.slice(0, 200)}"`,
      '',
      hasContext
        ? 'Retrieval ran and returned passages, which were passed to the model layer. Configure an API key to get a real analysis of them.'
        : 'No passages were retrieved for this query, so there is nothing to analyse.',
      '',
      'To enable real answers, set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_API_KEY) and change the LLM_*_PROVIDER variables in your environment.',
    ].join('\n');
  }
}

/**
 * Deterministic embeddings via feature hashing.
 *
 * Each token is hashed to a dimension and accumulated, then the vector is L2
 * normalised. This is a bag-of-words model, so it has no semantic
 * understanding - "bail" and "remand" are unrelated to it - but documents
 * sharing vocabulary do land near each other under cosine distance.
 *
 * That is enough to prove the pgvector index, the RRF fusion and the ranking
 * pipeline are wired correctly. It is not enough to answer a real legal
 * question, which is the entire reason the output is labelled.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimensions: number;

  constructor(env: AppEnv) {
    this.dimensions = env.EMBEDDING_DIMENSIONS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.hashEmbed(text));
  }

  private hashEmbed(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);

    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);

    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      // Two dimensions per token, with a sign bit, so unrelated tokens are
      // unlikely to cancel each other out systematically.
      const index = digest.readUInt32BE(0) % this.dimensions;
      const index2 = digest.readUInt32BE(4) % this.dimensions;
      const sign = digest[8] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
      vector[index2] += sign * 0.5;
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) {
      // Empty or stopword-only input: a fixed unit vector beats NaNs from a
      // divide by zero, which pgvector would reject on insert.
      vector[0] = 1;
      return vector;
    }
    return vector.map((v) => v / norm);
  }
}
