import { parseJsonLoose } from './llm-provider.interface';
import { acceptsEffort } from './langchain.provider';

/**
 * Models wrap JSON in prose and code fences often enough that a bare
 * JSON.parse fails regularly in production, which would drop the router to its
 * heuristic fallback for no good reason.
 */
describe('parseJsonLoose', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoose('{"intent":"SECTION_LOOKUP"}')).toEqual({ intent: 'SECTION_LOOKUP' });
  });

  it('parses JSON in a fenced code block', () => {
    const text = 'Here you go:\n```json\n{"intent":"CASE_STATUS"}\n```';
    expect(parseJsonLoose(text)).toEqual({ intent: 'CASE_STATUS' });
  });

  it('parses a fence without a language tag', () => {
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON surrounded by prose', () => {
    const text = 'Sure! {"intent":"PRECEDENT_SEARCH","confidence":0.9} Hope that helps.';
    expect(parseJsonLoose(text)).toEqual({ intent: 'PRECEDENT_SEARCH', confidence: 0.9 });
  });

  it('handles nested objects', () => {
    // A lazy brace regex would stop at the first closing brace here.
    const text = 'result: {"a":{"b":{"c":1}},"d":2} done';
    expect(parseJsonLoose(text)).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it('ignores braces inside strings', () => {
    const text = '{"query":"what about {this}?","ok":true}';
    expect(parseJsonLoose(text)).toEqual({ query: 'what about {this}?', ok: true });
  });

  it('handles escaped quotes', () => {
    const text = '{"query":"he said \\"bail\\" loudly"}';
    expect(parseJsonLoose(text)).toEqual({ query: 'he said "bail" loudly' });
  });

  it('returns null rather than throwing on unparseable input', () => {
    // Callers all have a fallback; none of them should 500 over formatting.
    expect(parseJsonLoose('no json here at all')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
    expect(parseJsonLoose('{"broken": ')).toBeNull();
  });
});

/**
 * The effort dial only reaches models that accept it.
 *
 * `output_config.effort` arrived with the 4.6 generation. Sending it to Haiku
 * 4.5 - the default router model - is a 400, and a 400 on the synthesis path is
 * not a slower answer, it is no answer. So the check is an allow-list: anything
 * unrecognised silently answers at the provider's default rather than failing.
 */
describe('acceptsEffort', () => {
  it.each(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-sonnet-4-6'])(
    'sends effort to %s',
    (model) => {
      expect(acceptsEffort(model)).toBe(true);
    },
  );

  it.each([
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-latest',
    'gpt-4o',
    '',
  ])('withholds effort from %p', (model) => {
    expect(acceptsEffort(model)).toBe(false);
  });
});
