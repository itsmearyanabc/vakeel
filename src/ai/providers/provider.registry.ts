import { Injectable } from '@nestjs/common';
import { getLogger } from '../../common/logger';
import { InjectEnv } from '../../config/config.module';
import { AppEnv } from '../../config/env';
import { AnthropicProvider } from './anthropic.provider';
import { GoogleEmbeddingProvider, GoogleProvider } from './google.provider';
import { EmbeddingProvider, LlmProvider, LlmRequest, LlmResult, LlmTask } from './llm-provider.interface';
import { MockEmbeddingProvider, MockLlmProvider } from './mock.provider';
import { OpenAiEmbeddingProvider, OpenAiProvider } from './openai.provider';

/**
 * Resolves which concrete provider handles each task, and degrades safely.
 *
 * Two behaviours worth knowing about:
 *
 *  1. A provider selected without its API key falls back to `mock` with a loud
 *     warning, rather than throwing at boot. A misconfigured key should not
 *     take the WhatsApp webhook offline - a bot that answers with a visible
 *     "not configured" notice is strictly better than one that stops
 *     acknowledging Meta's deliveries and gets the number throttled.
 *
 *  2. A live provider that fails at call time falls back to mock for that one
 *     call. Same reasoning: the user gets an honest message instead of silence.
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = getLogger().child({ module: 'llm:registry' });

  private readonly synthesis: LlmProvider;
  private readonly router: LlmProvider;
  private readonly embeddings: EmbeddingProvider;
  private readonly mock: MockLlmProvider;

  constructor(@InjectEnv() private readonly env: AppEnv) {
    this.mock = new MockLlmProvider(env);
    this.synthesis = this.resolveLlm(env.LLM_SYNTHESIS_PROVIDER, 'synthesis');
    this.router = this.resolveLlm(env.LLM_ROUTER_PROVIDER, 'router');
    this.embeddings = this.resolveEmbeddings(env.EMBEDDING_PROVIDER);

    this.logger.info(
      {
        synthesis: this.synthesis.name,
        router: this.router.name,
        embeddings: this.embeddings.name,
        dimensions: this.embeddings.dimensions,
      },
      'AI providers resolved',
    );
  }

  private hasKey(provider: string): boolean {
    switch (provider) {
      case 'anthropic':
        return Boolean(this.env.ANTHROPIC_API_KEY);
      case 'openai':
        return Boolean(this.env.OPENAI_API_KEY);
      case 'google':
        return Boolean(this.env.GOOGLE_API_KEY);
      default:
        return true;
    }
  }

  private resolveLlm(provider: string, task: LlmTask): LlmProvider {
    if (provider !== 'mock' && !this.hasKey(provider)) {
      this.logger.warn(
        { provider, task },
        `LLM_${task.toUpperCase()}_PROVIDER is "${provider}" but its API key is empty - falling back to mock`,
      );
      return this.mock;
    }

    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider(this.env);
      case 'openai':
        return new OpenAiProvider(this.env);
      case 'google':
        return new GoogleProvider(this.env);
      default:
        return this.mock;
    }
  }

  private resolveEmbeddings(provider: string): EmbeddingProvider {
    // Anthropic has no embeddings endpoint. Selecting it here is a
    // configuration mistake worth naming explicitly rather than quietly
    // treating as "mock".
    if (provider === 'anthropic') {
      this.logger.warn(
        'EMBEDDING_PROVIDER=anthropic is not valid (Anthropic has no embeddings API). ' +
          'Use openai or google for embeddings; falling back to mock.',
      );
      return new MockEmbeddingProvider(this.env);
    }

    if (provider !== 'mock' && !this.hasKey(provider)) {
      this.logger.warn({ provider }, 'EMBEDDING_PROVIDER key is empty - falling back to mock embeddings');
      return new MockEmbeddingProvider(this.env);
    }

    switch (provider) {
      case 'openai':
        return new OpenAiEmbeddingProvider(this.env);
      case 'google':
        return new GoogleEmbeddingProvider(this.env);
      default:
        return new MockEmbeddingProvider(this.env);
    }
  }

  getEmbeddingProvider(): EmbeddingProvider {
    return this.embeddings;
  }

  /** True when every task is mocked, so callers can add a banner to replies. */
  get isFullyMocked(): boolean {
    return this.synthesis.name === 'mock' && this.router.name === 'mock';
  }

  /**
   * Run a completion, falling back to the mock provider if the live one fails.
   *
   * Errors are logged with the provider name; the user-visible result is a mock
   * answer that says so.
   */
  async complete(request: LlmRequest): Promise<LlmResult> {
    const provider = request.task === 'synthesis' ? this.synthesis : this.router;

    try {
      return await provider.complete(request);
    } catch (err) {
      this.logger.error(
        { err, provider: provider.name, task: request.task },
        'LLM call failed - using mock fallback for this request',
      );
      if (provider.name === 'mock') throw err;
      return this.mock.complete(request);
    }
  }
}
