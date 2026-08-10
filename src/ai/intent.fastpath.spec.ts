import { IntentService } from './intent.service';
import { ProviderRegistry } from './providers/provider.registry';

/**
 * The fast path must never swallow a real question.
 *
 * Skipping the router model saves about a second and a billed call, but it is
 * only safe while the skipped cases are genuinely unambiguous. The risk is not
 * that the fast path is too slow to trigger - it is that it triggers on
 * something like "thanks, now what does section 420 cover" and answers a legal
 * question with a greeting. Everything below the first block guards that edge.
 */

function serviceWithSpy() {
  const complete = jest.fn(async () => ({
    text: JSON.stringify({ intent: 'GENERAL_LEGAL', language: 'en', search_query: 'x', confidence: 0.9 }),
    model: 'test',
    inputTokens: 0,
    outputTokens: 0,
  }));
  const service = new IntentService({ complete } as unknown as ProviderRegistry);
  return { service, complete };
}

describe('IntentService fast path', () => {
  describe('resolves without calling the model', () => {
    it.each([
      ['menu', 'MENU_NAVIGATION'],
      ['Menu', 'MENU_NAVIGATION'],
      ['help', 'MENU_NAVIGATION'],
      ['मेन्यू', 'MENU_NAVIGATION'],
      ['hi', 'SMALL_TALK'],
      ['Hello!', 'SMALL_TALK'],
      ['namaste', 'SMALL_TALK'],
      ['thank you', 'SMALL_TALK'],
      ['नमस्ते', 'SMALL_TALK'],
    ])('%s -> %s', async (text, expected) => {
      const { service, complete } = serviceWithSpy();

      const result = await service.classify(text);

      expect(result.intent).toBe(expected);
      expect(complete).not.toHaveBeenCalled();
    });

    it('detects Devanagari as Hindi without the model', async () => {
      const { service } = serviceWithSpy();
      expect((await service.classify('नमस्ते')).language).toBe('hi');
    });
  });

  describe('still asks the model when the meaning is not certain', () => {
    it.each([
      ['a greeting with a question attached', 'thanks, now what does section 420 cover'],
      ['a word containing a keyword', 'helpful precedents on anticipatory bail'],
      ['a real legal question', 'what is the punishment under section 302 IPC'],
      ['a precedent search', 'recent Patna High Court cases on Order 31 CPC'],
      ['menu as part of a sentence', 'is there a menu of services you offer'],
    ])('%s', async (_label, text) => {
      const { service, complete } = serviceWithSpy();

      await service.classify(text);

      expect(complete).toHaveBeenCalled();
    });
  });
});
