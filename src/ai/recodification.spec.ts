import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandQuery } from './legal-patterns';
import { buildSectionExplanationPrompt } from './prompts';

/**
 * "It is not able to search BNS or BNSS - still talking about IPC."
 *
 * Three separate things produced that, and each alone is enough.
 *
 * The corpus has no BNS rows at all. It has IPC rows carrying their BNS
 * equivalent in corresponding_act/corresponding_section, which is the right
 * shape for a seed built around the 2023 recodification - and search_statutes
 * filtered on act_code only, so a BNS lookup matched nothing.
 *
 * The lexical expansion treated "ipc" and "bns" as synonyms and appended the
 * IPC terms to every BNS query, which then outranked everything, because the
 * corpus is almost entirely IPC.
 *
 * And the explanation prompt was handed IPC 302's row with no idea that BNS 103
 * had been the question, so it answered about the IPC - correctly, for the
 * question it could see.
 */

describe('the lexical expansion', () => {
  it('does not append IPC terms to a BNS query', () => {
    const expanded = expandQuery('what does BNS 103 say').toLowerCase();

    expect(expanded).not.toContain('indian penal code');
    expect(expanded).not.toMatch(/\bipc\b/);
  });

  it('does not append CrPC terms to a BNSS query', () => {
    const expanded = expandQuery('BNSS 35 arrest without warrant').toLowerCase();

    expect(expanded).not.toContain('code of criminal procedure');
    expect(expanded).not.toMatch(/\bcrpc\b/);
  });

  it('still expands within one act', () => {
    // The groups were not deleted, only split: naming an act by abbreviation
    // should still reach its full name.
    expect(expandQuery('IPC 302').toLowerCase()).toContain('indian penal code');
    expect(expandQuery('BNS 103').toLowerCase()).toContain('bharatiya nyaya sanhita');
  });

  it('leaves the unrelated groups alone', () => {
    expect(expandQuery('anticipatory bail').toLowerCase()).toContain('regular bail');
  });
});

describe('the explanation prompt', () => {
  const statutes = [
    {
      act_code: 'IPC',
      act_name: 'Indian Penal Code, 1860',
      section_number: '302',
      section_title: 'Punishment for murder',
      section_text: 'Whoever commits murder shall be punished with death...',
      corresponding_act: 'BNS',
      corresponding_section: '103(1)',
    },
  ] as never;

  it('names the provision the advocate asked about', () => {
    const prompt = buildSectionExplanationPrompt(statutes, 'en', 'Section 103 BNS');

    expect(prompt).toContain('Section 103 BNS');
    expect(prompt).toMatch(/filed under the other code/i);
  });

  it('says outright not to answer about the other code instead', () => {
    // The failure is not that the IPC material is wrong - it is the right
    // material. It is that the answer came back about the IPC.
    const prompt = buildSectionExplanationPrompt(statutes, 'en', 'Section 103 BNS');

    expect(prompt).toMatch(/Do not silently answer about the other code/i);
  });

  it('adds nothing when no provision was named', () => {
    // Asserted on a sentence unique to the conditional block. The prompt's
    // standing instructions already say "Explain the provision the advocate
    // asked about", so matching that phrase matched the wrong sentence.
    const prompt = buildSectionExplanationPrompt(statutes, 'en', null);

    expect(prompt).not.toContain('Answer about that provision.');
    expect(prompt).not.toContain('Do not silently answer about the other code.');
  });
});

describe('migration 0017', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/0017_statute_recodification_lookup.sql'),
    'utf8',
  );

  it('searches the recodification mapping, not only act_code', () => {
    expect(sql).toContain('corresponding_act');
    expect(sql).toContain('corresponding_section');
    expect(sql).toContain('RECODIFIED');
  });

  it('ignores the bracketed sub-clause on both sides', () => {
    // The mapping records "103(1)" and advocates type "103". Refusing to match
    // those two is the same failure with an extra step.
    expect(sql).toContain('split_part');
  });

  it('ranks a real row above the mapping', () => {
    // So that ingesting the bare BNS properly later supersedes this without
    // anything here having to be removed first.
    const exact = Number(/'EXACT'::TEXT AS match_type, ([\d.]+)/.exec(sql)?.[1]);
    const mapped = Number(/'RECODIFIED'::TEXT, ([\d.]+)/.exec(sql)?.[1]);

    expect(exact).toBeGreaterThan(mapped);
  });

  it('replaces the function rather than creating a second one', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION search_statutes');
  });
});
