/**
 * Provider-agnostic LLM contract.
 *
 * The whole AI layer talks to this interface, so swapping Anthropic for OpenAI
 * is an environment variable rather than a refactor. That matters here because
 * the deployment has no keys configured yet - the `mock` implementation
 * satisfies the same contract, which is what lets the full WhatsApp pipeline be
 * exercised end to end before anyone pays for a token.
 */

export type LlmTask = 'router' | 'synthesis';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  task: LlmTask;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  /**
   * Ask for a JSON object back. Providers vary in how strictly they honour
   * this, so callers must still parse defensively - see `parseJsonLoose`.
   */
  json?: boolean;
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the answer came from the mock provider, so callers can label it. */
  mocked?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Returns one vector per input, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fenced code blocks often enough that a bare
 * `JSON.parse` fails regularly in production. This tries, in order: the whole
 * string, the contents of a fenced block, then the outermost brace-balanced
 * span. Returns null rather than throwing, because every caller has a sensible
 * fallback and none of them should 500 over formatting.
 */
export function parseJsonLoose<T>(text: string): T | null {
  const attempt = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  };

  const trimmed = text.trim();
  const direct = attempt(trimmed);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = attempt(fenced[1].trim());
    if (parsed) return parsed;
  }

  // Outermost balanced object. Scanning for depth rather than using a regex
  // because nested objects defeat a lazy `\{.*\}` match.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return attempt(trimmed.slice(start, i + 1));
      }
    }
  }

  return null;
}
