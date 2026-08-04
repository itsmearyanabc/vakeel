import Anthropic from '@anthropic-ai/sdk';
import { getLogger } from '../../common/logger';
import { AppEnv } from '../../config/env';
import { LlmProvider, LlmRequest, LlmResult } from './llm-provider.interface';

/**
 * Models that predate adaptive thinking and the effort parameter.
 *
 * This is not cosmetic. Sending `thinking: {type: 'adaptive'}` or
 * `output_config.effort` to Claude Haiku 4.5 is a 400, and Haiku 4.5 is exactly
 * what we route cheap high-volume intent classification to. Getting this wrong
 * breaks the router for every message while leaving synthesis working, which is
 * a confusing failure to chase down.
 *
 * Claude 4.6 and later (including the 5 family) take adaptive thinking and
 * effort; 4.5 and earlier take neither.
 */
const LEGACY_MODEL = /(haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|claude-3)/i;

function supportsAdaptiveThinking(model: string): boolean {
  return !LEGACY_MODEL.test(model);
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly logger = getLogger().child({ module: 'llm:anthropic' });
  private readonly client: Anthropic;

  constructor(private readonly env: AppEnv) {
    this.client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    });
  }

  private modelFor(task: LlmRequest['task']): string {
    return task === 'synthesis' ? this.env.ANTHROPIC_SYNTHESIS_MODEL : this.env.ANTHROPIC_ROUTER_MODEL;
  }

  private effortFor(task: LlmRequest['task']): string {
    return task === 'synthesis' ? this.env.ANTHROPIC_SYNTHESIS_EFFORT : this.env.ANTHROPIC_ROUTER_EFFORT;
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const model = this.modelFor(request.task);

    // With thinking enabled, max_tokens caps thinking AND the visible answer
    // together. A budget sized only for the answer truncates mid-sentence, so
    // synthesis gets generous headroom even though WhatsApp will only show
    // ~4000 characters of it.
    const maxTokens = request.maxTokens ?? (request.task === 'synthesis' ? 8192 : 1024);

    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (supportsAdaptiveThinking(model)) {
      params.thinking = { type: 'adaptive' };
      params.output_config = { effort: this.effortFor(request.task) };
    }

    // No temperature / top_p anywhere: they are rejected outright on Opus 5,
    // Sonnet 5 and the 4.7+ family. Behaviour is steered by prompting instead.

    const response = await this.client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsNonStreaming,
    );

    if (response.stop_reason === 'refusal') {
      this.logger.warn({ model, stopDetails: response.stop_details }, 'Model declined the request');
      return {
        text: '',
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    }

    // Skip thinking blocks; only visible text is the answer.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (response.stop_reason === 'max_tokens') {
      this.logger.warn({ model, maxTokens }, 'Response hit max_tokens and may be truncated');
    }

    return {
      text,
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
