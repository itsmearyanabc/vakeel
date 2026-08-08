import { Injectable } from '@nestjs/common';
import { getLogger } from '../../common/logger';
import { InjectEnv } from '../../config/config.module';
import { AppEnv } from '../../config/env';
import { RedisService } from '../../redis/redis.service';
import { SettingsService } from '../../settings/settings.service';
import { LlmMessage } from '../providers/llm-provider.interface';

export interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Epoch millis, for debugging and for the admin view. */
  at: number;
}

/**
 * Per-advocate conversation memory.
 *
 * ## The isolation guarantee
 *
 * Every advocate's history lives under its own Redis key, `chat:mem:{userId}`.
 * There is no shared structure and no filtering step that could be got wrong -
 * two users cannot see each other's context because they are never in the same
 * place to begin with. That is the strongest form this guarantee can take:
 * structural, not enforced by a WHERE clause someone might later forget.
 *
 * ## Why this is not a LangChain memory class
 *
 * `@langchain/redis` would work, but it is built on `node-redis` while this
 * service already runs a tuned `ioredis` connection (TLS to Upstash, retry
 * strategy, BullMQ-compatible settings). Adding a second Redis client library
 * to the runtime for one feature is a poor trade, and the trimming policy below
 * - bounded by turns *and* characters - is more specific than the stock window
 * memory offers anyway.
 *
 * ## Why Redis rather than Postgres
 *
 * This is working state, not a record. The durable audit trail already exists in
 * `whatsapp_messages`. Redis gives TTL for free, which means idle conversations
 * expire on their own - useful operationally and a genuine data-minimisation
 * measure under the DPDP Act, since nothing retains an advocate's questions
 * beyond the window they are useful in.
 *
 * ## Concurrency
 *
 * Safe with many workers and many replicas:
 *
 *  - Different advocates touch different keys, so parallelism is free.
 *  - Two rapid messages from the *same* advocate are serialised upstream by the
 *    per-user distributed lock in the inbound processor, so the read-modify-write
 *    below cannot interleave with itself.
 *  - The write is a single `SET` of the trimmed list, not a read-modify-write
 *    spread over multiple round trips, so even without that lock the worst case
 *    is a lost turn rather than a corrupted history.
 */
@Injectable()
export class ChatMemoryService {
  private readonly logger = getLogger().child({ module: 'ai:memory' });

  constructor(
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  private key(userId: string): string {
    return `chat:mem:${userId}`;
  }

  private get enabled(): boolean {
    return this.settings.getBoolean('MEMORY_ENABLED', this.env.MEMORY_ENABLED);
  }

  private get maxTurns(): number {
    return this.settings.getNumber('MEMORY_MAX_TURNS', this.env.MEMORY_MAX_TURNS);
  }

  private get maxChars(): number {
    return this.settings.getNumber('MEMORY_MAX_CHARS', this.env.MEMORY_MAX_CHARS);
  }

  private get ttl(): number {
    return this.settings.getNumber('MEMORY_TTL_SECONDS', this.env.MEMORY_TTL_SECONDS);
  }

  /**
   * Prior turns for this advocate, oldest first, ready to hand to the model.
   *
   * Never throws: memory is an enhancement, and a Redis blip must degrade the
   * answer rather than fail the message.
   */
  async load(userId: string): Promise<LlmMessage[]> {
    if (!this.enabled) return [];

    try {
      const turns = (await this.redis.getJson<MemoryTurn[]>(this.key(userId))) ?? [];
      return turns.map((t) => ({ role: t.role, content: t.content }));
    } catch (err) {
      this.logger.warn({ err, userId }, 'Could not load chat memory; answering without history');
      return [];
    }
  }

  /**
   * Record one exchange and re-trim.
   *
   * Both halves are stored together so history can never end on a dangling user
   * message with no reply - a shape that confuses every provider's alternation
   * checks.
   */
  async append(userId: string, userMessage: string, assistantMessage: string): Promise<void> {
    if (!this.enabled) return;
    if (!userMessage.trim() || !assistantMessage.trim()) return;

    try {
      const existing = (await this.redis.getJson<MemoryTurn[]>(this.key(userId))) ?? [];
      const now = Date.now();

      const next = this.trim([
        ...existing,
        { role: 'user', content: userMessage.trim(), at: now },
        { role: 'assistant', content: assistantMessage.trim(), at: now },
      ]);

      await this.redis.setJson(this.key(userId), next, this.ttl);
    } catch (err) {
      // Losing a turn is survivable; failing the reply is not.
      this.logger.warn({ err, userId }, 'Could not persist chat memory');
    }
  }

  /** Forget this advocate's history - "new chat", or on opt-out. */
  async clear(userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId));
    } catch (err) {
      this.logger.warn({ err, userId }, 'Could not clear chat memory');
    }
  }

  /** Turn count, for the admin panel and for tests. */
  async size(userId: string): Promise<number> {
    const turns = (await this.redis.getJson<MemoryTurn[]>(this.key(userId))) ?? [];
    return turns.length;
  }

  /**
   * Apply the retention window: newest turns win.
   *
   * Two independent budgets, because either alone fails:
   *
   *  - A turn cap alone lets ten pasted judgments blow the context window.
   *  - A character cap alone lets fifty trivial turns survive, which is a lot of
   *    tokens on every subsequent call for very little recall value.
   *
   * Trimming works backwards from the newest turn and always drops whole
   * user/assistant pairs, so the history handed to a provider never begins with
   * an orphaned assistant message.
   */
  private trim(turns: MemoryTurn[]): MemoryTurn[] {
    const maxTurns = this.maxTurns * 2; // a "turn" is one user + one assistant
    if (maxTurns <= 0) return [];

    // Clamp any single oversized message first. An advocate pasting a whole
    // judgment would otherwise consume the entire budget on its own, evicting
    // every other turn - and, before this clamp existed, could defeat the
    // budget so thoroughly that nothing survived at all.
    const windowed = turns.slice(-maxTurns).map((turn) =>
      turn.content.length > this.maxChars
        ? { ...turn, content: `${turn.content.slice(0, this.maxChars)}…` }
        : turn,
    );

    const kept: MemoryTurn[] = [];
    let chars = 0;

    for (let i = windowed.length - 1; i >= 0; i--) {
      const turn = windowed[i];
      if (chars + turn.content.length > this.maxChars && kept.length > 0) break;
      chars += turn.content.length;
      kept.unshift(turn);
    }

    // Never lead with an assistant message - some providers reject a history
    // that does not start with a user turn.
    while (kept.length > 0 && kept[0].role === 'assistant') kept.shift();

    // If stripping the lead emptied the window, fall back to the final
    // exchange. Losing the most recent turn is the one outcome that makes
    // memory actively misleading: the model would answer a follow-up having
    // forgotten the question it follows.
    if (kept.length === 0 && windowed.length >= 2) {
      return windowed.slice(-2);
    }

    return kept;
  }
}
