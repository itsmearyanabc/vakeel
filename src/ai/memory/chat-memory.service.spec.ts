import { AppEnv } from '../../config/env';
import { ChatMemoryService, MemoryTurn } from './chat-memory.service';

/**
 * In-memory stand-in for MemoryRepository.
 *
 * Was a fake Redis until migration 0013 moved this store to Postgres. The
 * substance of these tests is unchanged, because what they actually assert is
 * per-user isolation and trimming - properties of the service, not of whatever
 * is holding the bytes.
 */
class FakeMemoryStore {
  store = new Map<string, unknown>();
  ttls = new Map<string, number>();
  failNext = false;

  async load<T>(userId: string): Promise<T> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database down');
    }
    return (this.store.get(userId) as T) ?? ([] as unknown as T);
  }

  async save(userId: string, turns: unknown, ttl: number): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database down');
    }
    this.store.set(userId, turns);
    this.ttls.set(userId, ttl);
  }

  async clear(userId: string): Promise<void> {
    this.store.delete(userId);
    this.ttls.delete(userId);
  }
}

/** Settings resolve straight through to env in these tests. */
const passthroughSettings = {
  getBoolean: (_k: string, fallback: boolean) => fallback,
  getNumber: (_k: string, fallback: number) => fallback,
};

function makeService(over: Partial<AppEnv> = {}) {
  const redis = new FakeMemoryStore();
  const env = {
    MEMORY_ENABLED: true,
    MEMORY_MAX_TURNS: 3,
    MEMORY_MAX_CHARS: 1000,
    MEMORY_TTL_SECONDS: 3600,
    ...over,
  } as AppEnv;

  const service = new ChatMemoryService(
    redis as never,
    passthroughSettings as never,
    env,
  );
  return { service, redis };
}

describe('ChatMemoryService', () => {
  describe('per-user isolation', () => {
    it('keeps two advocates completely separate', async () => {
      // The central guarantee: concurrent users must never see each other's
      // context. Isolation is structural - different keys - not filtered.
      const { service } = makeService();

      await service.append('user-a', 'What is IPC 420?', 'Cheating and dishonesty.');
      await service.append('user-b', 'Bail in NDPS cases?', 'Section 37 applies.');

      const a = await service.load('user-a');
      const b = await service.load('user-b');

      expect(a.map((m) => m.content)).toEqual(['What is IPC 420?', 'Cheating and dishonesty.']);
      expect(b.map((m) => m.content)).toEqual(['Bail in NDPS cases?', 'Section 37 applies.']);
      expect(JSON.stringify(a)).not.toContain('NDPS');
      expect(JSON.stringify(b)).not.toContain('420');
    });

    it('stores each advocate under their own user id', async () => {
      // Isolation is structural - a row per user - rather than a filter applied
      // at read time that somebody could forget to apply.
      const { service, redis } = makeService();
      await service.append('user-a', 'q', 'a');
      expect([...redis.store.keys()]).toEqual(['user-a']);
    });

    it('clearing one advocate leaves others untouched', async () => {
      const { service } = makeService();
      await service.append('user-a', 'q1', 'a1');
      await service.append('user-b', 'q2', 'a2');

      await service.clear('user-a');

      expect(await service.load('user-a')).toEqual([]);
      expect(await service.load('user-b')).toHaveLength(2);
    });

    it('stays isolated under interleaved writes from many users', async () => {
      // Simulates concurrent workers handling different advocates at once.
      const { service } = makeService();
      const users = ['u1', 'u2', 'u3', 'u4', 'u5'];

      await Promise.all(users.map((u) => service.append(u, 'question from ' + u, 'answer for ' + u)));

      for (const u of users) {
        const history = await service.load(u);
        expect(history).toHaveLength(2);
        expect(history[0].content).toBe('question from ' + u);
        expect(history[1].content).toBe('answer for ' + u);
      }
    });
  });

  describe('trimming', () => {
    it('keeps only the most recent turns', async () => {
      const { service } = makeService({ MEMORY_MAX_TURNS: 2 } as Partial<AppEnv>);

      await service.append('u', 'q1', 'a1');
      await service.append('u', 'q2', 'a2');
      await service.append('u', 'q3', 'a3');

      const history = await service.load('u');
      expect(history).toHaveLength(4); // 2 turns = 4 messages
      expect(history.map((m) => m.content)).toEqual(['q2', 'a2', 'q3', 'a3']);
    });

    it('enforces the character budget independently of the turn count', async () => {
      // A turn cap alone lets a few pasted judgments blow the context window.
      const { service } = makeService({ MEMORY_MAX_TURNS: 10, MEMORY_MAX_CHARS: 60 } as Partial<AppEnv>);

      await service.append('u', 'x'.repeat(50), 'y'.repeat(50));
      await service.append('u', 'short q', 'short a');

      const history = await service.load('u');
      const total = history.reduce((n, m) => n + m.content.length, 0);
      expect(total).toBeLessThanOrEqual(60);
      expect(history.map((m) => m.content)).toEqual(['short q', 'short a']);
    });

    it('never begins the history with an assistant message', async () => {
      // Several providers reject a history that does not start on a user turn.
      const { service } = makeService({ MEMORY_MAX_TURNS: 10, MEMORY_MAX_CHARS: 30 } as Partial<AppEnv>);

      await service.append('u', 'a question that is fairly long here', 'short');

      const history = await service.load('u');
      if (history.length > 0) expect(history[0].role).toBe('user');
    });

    it('always keeps at least the latest exchange, even if oversized', async () => {
      const { service } = makeService({ MEMORY_MAX_CHARS: 10 } as Partial<AppEnv>);
      await service.append('u', 'q'.repeat(100), 'a'.repeat(100));
      expect((await service.load('u')).length).toBeGreaterThan(0);
    });
  });

  describe('resilience', () => {
    it('returns empty history rather than throwing when Redis is down', async () => {
      // Memory is an enhancement. A Redis blip must degrade the answer, not
      // fail the advocate's message.
      const { service, redis } = makeService();
      redis.failNext = true;
      await expect(service.load('u')).resolves.toEqual([]);
    });

    it('swallows write failures', async () => {
      const { service, redis } = makeService();
      redis.failNext = true;
      await expect(service.append('u', 'q', 'a')).resolves.toBeUndefined();
    });

    it('ignores blank exchanges', async () => {
      const { service } = makeService();
      await service.append('u', '', 'an answer');
      await service.append('u', 'a question', '   ');
      expect(await service.load('u')).toEqual([]);
    });

    it('applies the configured TTL so idle conversations expire', async () => {
      const { service, redis } = makeService({ MEMORY_TTL_SECONDS: 7200 } as Partial<AppEnv>);
      await service.append('u', 'q', 'a');
      expect(redis.ttls.get('u')).toBe(7200);
    });
  });

  describe('disabled mode', () => {
    it('reads and writes nothing when memory is switched off', async () => {
      const { service, redis } = makeService({ MEMORY_ENABLED: false } as Partial<AppEnv>);
      await service.append('u', 'q', 'a');
      expect(redis.store.size).toBe(0);
      expect(await service.load('u')).toEqual([]);
    });
  });

  it('stores turns oldest-first with timestamps', async () => {
    const { service, redis } = makeService();
    await service.append('u', 'q', 'a');
    const stored = redis.store.get('u') as MemoryTurn[];
    expect(stored[0].role).toBe('user');
    expect(stored[1].role).toBe('assistant');
    expect(typeof stored[0].at).toBe('number');
  });
});
