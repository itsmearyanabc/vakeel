import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { getLogger } from '../../common/logger';
import { AppEnv } from '../../config/env';
import { LlmProvider, LlmRequest, LlmResult, LlmTask } from './llm-provider.interface';

export type ChatProviderName = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'groq';

/**
 * The slice of a LangChain chat model this file actually uses.
 *
 * Deliberately structural rather than `BaseChatModel` from
 * `@langchain/core/language_models/chat_models`. That base class carries two
 * generic parameters (call options, output message type) which each vendor
 * package specialises differently, and assigning a `ChatAnthropic` to a bare
 * `BaseChatModel` trips TypeScript's protected-member nominal check:
 *
 *     Property '_separateRunnableConfigFromCallOptionsCompat' is protected but
 *     type 'BaseChatModel<...>' is not a class derived from 'BaseChatModel<...>'
 *
 * Declaring the two members we depend on states the real contract, keeps every
 * vendor class assignable, and does not break when LangChain adjusts those
 * generics in a minor release.
 */
interface ChatModelResponse {
  content: unknown;
  /** LangChain's normalised token accounting. Absent on some providers. */
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
}

interface InvokableChatModel {
  invoke(messages: BaseMessage[], options?: Record<string, unknown>): Promise<ChatModelResponse>;
}

/**
 * Does this model accept `output_config.effort`?
 *
 * The parameter arrived with the 4.6 generation. Every model before it - Haiku
 * 4.5 included, which is the default router model - rejects it outright with a
 * 400, and a 400 on the synthesis path is not a degraded answer, it is no
 * answer at all.
 *
 * So this is an allow-list rather than a deny-list, and the failure mode is
 * chosen deliberately. An unrecognised model does not get the parameter and
 * answers at the provider's own default: slower than the operator asked for,
 * but working. A deny-list would make the next unknown model id an outage.
 */
export function acceptsEffort(modelId: string): boolean {
  // The generation number must end here or be followed by a separator, so
  // "claude-opus-5" and "claude-opus-5-20260101" both qualify while a future
  // "claude-opus-54" is not assumed to.
  return /^claude-(?:opus|sonnet|haiku|fable)-(?:[5-9](?![0-9])|4-[6-9])/.test(modelId.trim());
}

/**
 * Every chat provider, behind LangChain.
 *
 * ## Why LangChain sits here and nowhere else
 *
 * LangChain's value in this codebase is a single message format and one
 * `.invoke()` across five vendors whose SDKs disagree about nearly everything -
 * how system prompts are passed, how JSON mode is requested, where token counts
 * live in the response. That normalisation is exactly what this file needs and
 * is the whole reason the dependency is here.
 *
 * It deliberately does NOT reach further into the app. Retrieval stays in
 * Postgres (see the RAG service), and conversation memory is our own
 * implementation rather than a LangChain memory class - both for reasons noted
 * at their definitions. Keeping the framework at this one boundary means the
 * `LlmProvider` interface is unchanged, so nothing upstream knows or cares that
 * LangChain exists.
 *
 * ## Adding an OpenAI-compatible vendor
 *
 * Most new entrants (DeepSeek, Groq, Together, Fireworks, OpenRouter) speak the
 * OpenAI wire format. For those, add a case that returns `ChatOpenAI` with a
 * `baseURL` - there is no new SDK to integrate.
 */
export class LangChainProvider implements LlmProvider {
  private readonly logger = getLogger().child({ module: 'llm:langchain' });
  private readonly model: InvokableChatModel;

  readonly name: string;
  readonly modelId: string;

  constructor(
    private readonly provider: ChatProviderName,
    private readonly task: LlmTask,
    private readonly env: AppEnv,
  ) {
    this.modelId = LangChainProvider.modelFor(provider, task, env);
    this.name = `${provider}:${this.modelId}`;
    this.model = this.build();
  }

  /** Which model id this provider/task pair uses. */
  static modelFor(provider: ChatProviderName, task: LlmTask, env: AppEnv): string {
    const synthesis = task === 'synthesis';
    switch (provider) {
      case 'anthropic':
        return synthesis ? env.ANTHROPIC_SYNTHESIS_MODEL : env.ANTHROPIC_ROUTER_MODEL;
      case 'openai':
        return synthesis ? env.OPENAI_SYNTHESIS_MODEL : env.OPENAI_ROUTER_MODEL;
      case 'google':
        return synthesis ? env.GOOGLE_SYNTHESIS_MODEL : env.GOOGLE_ROUTER_MODEL;
      case 'deepseek':
        return synthesis ? env.DEEPSEEK_SYNTHESIS_MODEL : env.DEEPSEEK_ROUTER_MODEL;
      case 'groq':
        return synthesis ? env.GROQ_SYNTHESIS_MODEL : env.GROQ_ROUTER_MODEL;
    }
  }

  private build(): InvokableChatModel {
    const common = {
      model: this.modelId,
      maxRetries: this.env.LLM_MAX_RETRIES,
      timeout: this.env.LLM_TIMEOUT_MS,
    };

    switch (this.provider) {
      case 'anthropic':
        return new ChatAnthropic({
          ...common,
          apiKey: this.env.ANTHROPIC_API_KEY,
          /*
           * The latency dial, finally connected to something.
           *
           * ANTHROPIC_SYNTHESIS_EFFORT is validated at boot, documented in
           * .env.example and named in the README as *the* control for the
           * spec's <2.5s p95 target - and nothing read it. Setting it to `low`
           * changed the environment and nothing else, which is the worst kind
           * of knob: it invites you to tune and then conclude the tuning had
           * no effect.
           *
           * Synthesis only. The router model is chosen for being cheap and
           * fast, and spending thinking budget on classifying "hi" is the
           * opposite of what this variable is for.
           */
          ...(this.task === 'synthesis' && acceptsEffort(this.modelId)
            ? { outputConfig: { effort: this.env.ANTHROPIC_SYNTHESIS_EFFORT } }
            : {}),
        });

      case 'google':
        return new ChatGoogleGenerativeAI({ ...common, apiKey: this.env.GOOGLE_API_KEY });

      case 'deepseek':
        return new ChatDeepSeek({
          ...common,
          apiKey: this.env.DEEPSEEK_API_KEY,
          configuration: { baseURL: this.env.DEEPSEEK_BASE_URL },
        });

      case 'groq':
        // Groq speaks the OpenAI wire format, so ChatOpenAI with a base URL is
        // the whole integration - no separate SDK needed.
        return new ChatOpenAI({
          ...common,
          apiKey: this.env.GROQ_API_KEY,
          configuration: { baseURL: this.env.GROQ_BASE_URL },
        });

      case 'openai':
      default:
        return new ChatOpenAI({
          ...common,
          apiKey: this.env.OPENAI_API_KEY,
          ...(this.env.OPENAI_BASE_URL
            ? { configuration: { baseURL: this.env.OPENAI_BASE_URL } }
            : {}),
        });
    }
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const messages: BaseMessage[] = [new SystemMessage(request.system)];

    for (const message of request.messages) {
      messages.push(
        message.role === 'assistant' ? new AIMessage(message.content) : new HumanMessage(message.content),
      );
    }

    // JSON mode is requested per-call rather than baked into the model, because
    // the same provider instance serves both JSON (intent classification) and
    // prose (legal synthesis) requests.
    const options = request.json ? this.jsonModeOptions() : undefined;

    const response = await this.model.invoke(messages, options);

    return {
      text: this.flatten(response.content),
      model: this.name,
      // usage_metadata is LangChain's normalised shape; providers that omit it
      // report zero rather than breaking the caller's accounting.
      inputTokens: response.usage_metadata?.input_tokens ?? 0,
      outputTokens: response.usage_metadata?.output_tokens ?? 0,
    };
  }

  /**
   * Ask for JSON back, where the provider supports it.
   *
   * Anthropic and Google have no `response_format` equivalent on this path, so
   * they rely on the prompt alone - which is why every caller still parses with
   * `parseJsonLoose` rather than `JSON.parse`.
   */
  private jsonModeOptions(): Record<string, unknown> | undefined {
    switch (this.provider) {
      case 'openai':
      case 'deepseek':
      case 'groq':
        return { response_format: { type: 'json_object' } };
      default:
        return undefined;
    }
  }

  /**
   * Reduce LangChain's content union to a string.
   *
   * `content` is `string | (string | {type,text,...})[]` - the array form shows
   * up with multimodal and thinking-capable models, where indexing `[0].text`
   * would silently drop everything after the first block.
   */
  private flatten(content: unknown): string {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            return String((part as { text: unknown }).text ?? '');
          }
          return '';
        })
        .join('')
        .trim();
    }

    this.logger.warn({ contentType: typeof content }, 'Unexpected message content shape from provider');
    return '';
  }
}
