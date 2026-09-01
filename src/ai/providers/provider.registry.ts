import { Injectable } from '@nestjs/common';
import { getLogger } from '../../common/logger';
import { InjectEnv } from '../../config/config.module';
import { AppEnv } from '../../config/env';
import { GoogleEmbeddingProvider } from './google.provider';
import { ChatProviderName, LangChainProvider } from './langchain.provider';
import { EmbeddingProvider, LlmProvider, LlmRequest, LlmResult, LlmTask } from './llm-provider.interface';
import { MockEmbeddingProvider, MockLlmProvider } from './mock.provider';
import { OpenAiEmbeddingProvider } from './openai.provider';

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
      case 'deepseek':
        return Boolean(this.env.DEEPSEEK_API_KEY);
      case 'groq':
        return Boolean(this.env.GROQ_API_KEY);
      default:
        return true;
    }
  }

  private resolveLlm(provider: string, task: LlmTask): LlmProvider {
    if (provider === 'mock') return this.mock;

    if (!this.hasKey(provider)) {
      this.logger.warn(
        { provider, task },
        `LLM_${task.toUpperCase()}_PROVIDER is "${provider}" but its API key is empty - falling back to mock`,
      );
      return this.mock;
    }

    // Every real provider goes through LangChain, which is what makes adding a
    // vendor a switch case rather than a new SDK integration.
    try {
      return new LangChainProvider(provider as ChatProviderName, task, this.env);
    } catch (err) {
      // A bad model id or malformed base URL throws at construction. Falling
      // back keeps the bot answering (with a visible notice) instead of taking
      // the webhook offline over a typo in a config value.
      this.logger.error({ err, provider, task }, 'Could not construct provider - falling back to mock');
      return this.mock;
    }
  }

  private resolveEmbeddings(provider: string): EmbeddingProvider {
    // Several providers have no embeddings endpoint at all. Selecting one here
    // is a configuration mistake worth naming explicitly rather than quietly
    // treating as "mock" - especially DeepSeek, which is an attractive default
    // for chat precisely because it is cheap, and then silently cannot embed.
    const noEmbeddings: Record<string, string> = {
      anthropic: 'Anthropic has no embeddings API',
      deepseek: 'DeepSeek has no embeddings API',
      groq: 'Groq has no embeddings API',
    };

    if (noEmbeddings[provider]) {
      this.logger.warn(
        `EMBEDDING_PROVIDER=${provider} is not valid (${noEmbeddings[provider]}). ` +
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
   * True when legal analysis specifically is a placeholder.
   *
   * Narrower than {@link isFullyMocked} on purpose. A deployment can route
   * intent classification through the mock and still answer with a real model,
   * and the reverse costs far more: the landing page uses this to decide
   * whether to tell visitors that answers are not yet real, and "the router is
   * also mocked" is not a condition anyone should have to meet before that
   * warning appears.
   */
  get isSynthesisMocked(): boolean {
    return this.synthesis.name === 'mock';
  }

  /**
   * True when the cheap task is a placeholder.
   *
   * Read by callers whose feature is *better off skipped* than mocked. The mock
   * provider returns a fixed placeholder string, which is right for an answer
   * the reply can label as a placeholder, and wrong for a field rendered inside
   * a list of real judgments - there the placeholder reads as a finding about
   * the case in front of it.
   */
  get isRouterMocked(): boolean {
    return this.router.name === 'mock';
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
