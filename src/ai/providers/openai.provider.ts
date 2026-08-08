import OpenAI from 'openai';
import { AppEnv } from '../../config/env';
import { EmbeddingProvider } from './llm-provider.interface';

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
