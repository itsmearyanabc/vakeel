import { CorpusRepository } from '../database/repositories/corpus.repository';
import { RetrievedChunk } from '../database/types';
import { GuardrailsService } from './guardrails.service';

/**
 * The guardrail is the product's core safety control, so these tests are
 * written around the failure it exists to prevent: a fabricated citation
 * reaching an advocate who then repeats it in court.
 */

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 'c1',
    judgment_id: 'j1',
    content: 'The appellant is entitled to bail.',
    para_number: 14,
    case_title: 'Sample v. Illustration',
    neutral_citation: '2024 INSC 452',
    reporter_citations: ['AIR 2018 SC 1234'],
    court_name: 'Supreme Court of India',
    judgment_date: new Date('2024-01-01'),
    ratio_decidendi: null,
    dense_rank: 1,
    sparse_rank: 1,
    score: 0.9,
    ...overrides,
  };
}

function makeService(
  citationResults: { citation: string; exists: boolean }[] = [],
  statuteResults: { ref: string; exists: boolean }[] = [],
): GuardrailsService {
  const corpus = {
    verifyCitations: jest.fn().mockImplementation((citations: string[]) =>
      Promise.resolve(
        citations.map((citation) => ({
          citation,
          exists: citationResults.find((r) => r.citation === citation)?.exists ?? false,
          judgment_id: null,
          case_title: null,
        })),
      ),
    ),
    verifyStatuteRefs: jest.fn().mockImplementation((refs: string[]) =>
      Promise.resolve(
        refs.map((ref) => ({
          ref,
          exists: statuteResults.find((r) => r.ref === ref)?.exists ?? false,
          act_code: null,
          section_number: null,
          section_title: null,
        })),
      ),
    ),
  } as unknown as CorpusRepository;

  return new GuardrailsService(corpus);
}

describe('GuardrailsService', () => {
  it('passes through an answer with no citations', async () => {
    const service = makeService();
    const answer = 'Bail is discretionary in non-bailable offences.';

    const result = await service.verify(answer, []);

    expect(result.text).toBe(answer);
    expect(result.triggered).toBe(false);
  });

  it('keeps a citation that was in the retrieved passages', async () => {
    const service = makeService([{ citation: 'AIR 2018 SC 1234', exists: true }]);
    const answer = 'As held in *Sample v. Illustration* (AIR 2018 SC 1234), bail may be granted.';

    const result = await service.verify(answer, [chunk()]);

    expect(result.text).toContain('AIR 2018 SC 1234');
    expect(result.verifiedCitations).toContain('AIR 2018 SC 1234');
    expect(result.removed).toHaveLength(0);
    expect(result.triggered).toBe(false);
  });

  it('REMOVES a fabricated citation', async () => {
    // The headline case. The model invents a citation that does not exist
    // anywhere in the corpus; it must not survive into the reply.
    const service = makeService([{ citation: 'AIR 2019 SC 9999', exists: false }]);
    const answer = 'The position is settled by *Invented Case* (AIR 2019 SC 9999).';

    const result = await service.verify(answer, [chunk()]);

    expect(result.text).not.toContain('AIR 2019 SC 9999');
    expect(result.text).toContain('[unverified]');
    expect(result.removed).toContain('AIR 2019 SC 9999');
    expect(result.triggered).toBe(true);
  });

  it('tells the reader that something was removed', async () => {
    // Silently altering the answer would leave an unsupported assertion looking
    // like a sourced one.
    const service = makeService([{ citation: 'AIR 2019 SC 9999', exists: false }]);

    const result = await service.verify('See AIR 2019 SC 9999.', [chunk()]);

    expect(result.text).toMatch(/could not be verified/i);
  });

  it('flags but keeps a real citation that was not retrieved', async () => {
    // Genuine case, drawn from model memory rather than the provided context.
    // Keeping it is right; recording it for audit is also right.
    const service = makeService([{ citation: '(2020) 7 SCC 1', exists: true }]);
    const answer = 'See also (2020) 7 SCC 1.';

    const result = await service.verify(answer, [chunk()]);

    expect(result.text).toContain('(2020) 7 SCC 1');
    expect(result.flagged).toContain('(2020) 7 SCC 1');
    expect(result.removed).toHaveLength(0);
    expect(result.triggered).toBe(true);
  });

  it('matches citations regardless of punctuation and case', async () => {
    // Models reformat citations; "AIR 2018 S.C. 1234" is the same authority.
    const service = makeService([{ citation: 'AIR 2018 S.C. 1234', exists: true }]);

    const result = await service.verify('Relying on AIR 2018 S.C. 1234.', [chunk()]);

    expect(result.removed).toHaveLength(0);
    expect(result.flagged).toHaveLength(0);
  });

  it('removes an invented statutory section', async () => {
    const service = makeService([], [{ ref: 'IPC 999', exists: false }]);

    const result = await service.verify('This falls under section 999 IPC.', []);

    expect(result.removed).toContain('IPC 999');
    expect(result.text).toContain('[unverified]');
  });

  it('keeps a real statutory section', async () => {
    const service = makeService([], [{ ref: 'IPC 302', exists: true }]);

    const result = await service.verify('Punishable under section 302 IPC.', []);

    expect(result.removed).toHaveLength(0);
    expect(result.text).toContain('302');
  });

  it('does not leave empty parentheses behind', async () => {
    const service = makeService([{ citation: 'AIR 2019 SC 9999', exists: false }]);

    const result = await service.verify('*Invented Case* (AIR 2019 SC 9999) applies.', []);

    expect(result.text).not.toMatch(/\(\s*\)/);
  });

  it('handles an empty answer without calling the database', async () => {
    const service = makeService();
    const result = await service.verify('   ', []);
    expect(result.triggered).toBe(false);
  });
});
