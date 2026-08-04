import { GoogleGenAI } from '@google/genai';
import { AppEnv } from '../../config/env';
import { EmbeddingProvider, LlmProvider, LlmRequest, LlmResult } from './llm-provider.interface';

/**
 * Gemini, via the current `@google/genai` SDK.
 *
 * Note this is NOT the older `@google/generative-ai` package, which is
 * deprecated and has a different call shape (`getGenerativeModel().
 * generateContent()`). If you find a snippet using that, it will not work here.
 *
 * Of the three real providers this is the least exercised path in this build -
 * the architecture spec assigns Gemini only the long-context PDF role.
 */
export class GoogleProvider implements LlmProvider {
  readonly name = 'google';
  private readonly client: GoogleGenAI;

  constructor(private readonly env: AppEnv) {
    this.client = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const model =
      request.task === 'synthesis' ? this.env.GOOGLE_SYNTHESIS_MODEL : this.env.GOOGLE_ROUTER_MODEL;

    const response = await this.client.models.generateContent({
      model,
      contents: request.messages.map((m) => ({
        // Gemini calls the assistant turn 'model'.
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.maxTokens ?? (request.task === 'synthesis' ? 4096 : 1024),
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
      },
    });

    return {
      text: (response.text ?? '').trim(),
      model,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

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
