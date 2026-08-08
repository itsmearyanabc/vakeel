import { GoogleGenAI } from '@google/genai';
import { AppEnv } from '../../config/env';
import { EmbeddingProvider } from './llm-provider.interface';

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'google';
  readonly dimensions: number;
  private readonly client: GoogleGenAI;

  constructor(private readonly env: AppEnv) {
    this.dimensions = env.EMBEDDING_DIMENSIONS;
    this.client = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await this.client.models.embedContent({
      model: this.env.GOOGLE_EMBEDDING_MODEL,
      contents: texts,
      config: { outputDimensionality: this.dimensions },
    });

    return (response.embeddings ?? []).map((e) => e.values ?? []);
  }
}
