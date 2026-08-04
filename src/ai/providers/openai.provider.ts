import OpenAI from 'openai';
import { getLogger } from '../../common/logger';
import { AppEnv } from '../../config/env';
import { EmbeddingProvider, LlmProvider, LlmRequest, LlmResult } from './llm-provider.interface';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly logger = getLogger().child({ module: 'llm:openai' });
  private readonly client: OpenAI;

  constructor(private readonly env: AppEnv) {
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    });
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const model =
      request.task === 'synthesis' ? this.env.OPENAI_SYNTHESIS_MODEL : this.env.OPENAI_ROUTER_MODEL;

    const response = await this.client.chat.completions.create({
      model,
      // `max_completion_tokens` rather than the deprecated `max_tokens`: the
      // reasoning models reject the old name outright, and the current chat
      // models accept the new one, so this is the version that works on both.
      max_completion_tokens: request.maxTokens ?? (request.task === 'synthesis' ? 4096 : 1024),
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content }) as const),
      ],
      ...(request.json ? { response_format: { type: 'json_object' as const } } : {}),
    });

    const choice = response.choices[0];
    if (choice?.finish_reason === 'length') {
      this.logger.warn({ model }, 'Response hit the token limit and may be truncated');
    }

    return {
      text: choice?.message?.content?.trim() ?? '',
      model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private readonly client: OpenAI;

  constructor(private readonly env: AppEnv) {
    this.dimensions = env.EMBEDDING_DIMENSIONS;
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await this.client.embeddings.create({
      model: this.env.OPENAI_EMBEDDING_MODEL,
      input: texts,
      // text-embedding-3-* support Matryoshka truncation, so the width can be
      // matched to the vector column instead of the other way round.
      dimensions: this.dimensions,
    });

    // The API does not guarantee response order, and a shuffled batch would
    // silently attach the wrong vector to every chunk.
    return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}
