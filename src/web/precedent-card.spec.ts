import { PrecedentRow } from '../database/types';
import { formatPrecedentPage } from '../ai/precedents.service';
import { toPublicPrecedent } from './chat.service';

/**
 * The web app and the WhatsApp bot must answer a case-law question with the
 * same seven fields.
 *
 * They did not. WhatsApp rendered the labelled card the output format requires;
 * the web app rendered a title, a row of pills and a paragraph of excerpt. Same
 * query, same pipeline, two different answers depending on which screen the
 * advocate happened to open - and nothing failed, so nothing said so.
 *
 * These lock the projection the browser receives to the labels the WhatsApp
 * card prints, so the two can differ in styling and not in content.
 */

function row(over: Partial<PrecedentRow> = {}): PrecedentRow {
  return {
    judgment_id: 'j1',
    case_title: 'State of Bihar vs Ram Kumar',
    neutral_citation: '2024 INSC 452',
    reporter_citations: ['AIR 2024 SC 100'],
    court_name: 'Patna High Court',
    court_type: 'HIGH_COURT',
    judgment_date: new Date('2024-03-15'),
    bench: ['A Kumar'],
    bench_strength: 1,
    act_sections: ['IPC 302'],
    headnote: null,
    ratio_decidendi: 'Bail may be granted where the accused has no antecedents.',
    disposition: 'ALLOWED',
    source_url: null,
    best_excerpt: 'The court considered the question of bail at length.',
    para_number: 12,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 1,
    ...over,
  };
}

describe('the judgment the browser receives', () => {
  it('carries every field the output format names', () => {
    const item = toPublicPrecedent(row());

    expect(item.caseNo).toBe('2024 INSC 452');
    expect(item.petitioner).toBe('State of Bihar');
    expect(item.respondent).toBe('Ram Kumar');
    expect(item.date).toEqual(new Date('2024-03-15'));
    expect(item.bench).toBe('A Kumar');
    expect(item.equivalentCitations).toEqual(['AIR 2024 SC 100']);
    expect(item.legalPrinciple).toContain('no antecedents');
  });

  it('agrees with the WhatsApp card field for field', () => {
    // The two renderers are different; what they render must not be.
    const source = row();
    const item = toPublicPrecedent(source);
    const card = formatPrecedentPage([source], 0, 5, 'bail');

    expect(card).toContain(`CASE NO.: ${item.caseNo}`);
    expect(card).toContain(`PETITIONER: ${item.petitioner}`);
    expect(card).toContain(`RESPONDENT: ${item.respondent}`);
    expect(card).toContain(`BENCH: ${item.bench}`);
    expect(card).toContain(`EQUIVALENT CITATIONS: ${item.equivalentCitations.join('; ')}`);
    expect(card).toContain(`LEGAL PRINCIPLE: ${item.legalPrinciple}`);
  });

  it('never repeats the neutral citation as an equivalent', () => {
    expect(toPublicPrecedent(row()).equivalentCitations).not.toContain('2024 INSC 452');
  });

  it('reports an absent field as null and hands the client the wording for it', () => {
    // Null rather than a blank string, so the renderer can tell "nothing here"
    // from "an empty value" and print the same "Not available" the card does.
    const item = toPublicPrecedent(
      row({ neutral_citation: null, reporter_citations: [], bench: [], bench_strength: null }),
    );

    expect(item.caseNo).toBeNull();
    expect(item.bench).toBeNull();
    expect(item.equivalentCitations).toEqual([]);
    expect(item.notAvailable).toBe('Not available');
  });

  it('passes on the model-written principle when the judgment states none', () => {
    const item = toPublicPrecedent(
      row({
        ratio_decidendi: null,
        headnote: null,
        best_excerpt: '',
        generated_principle: 'Delay in filing an appeal is condonable on sufficient cause.',
      }),
    );

    expect(item.legalPrinciple).toContain('condonable on sufficient cause');
  });

  it('strips the ellipses Kanoon leaves in truncated titles', () => {
    const item = toPublicPrecedent(row({ case_title: 'Tiger Global ... vs The Authority ...' }));
    expect(item.title).not.toContain('...');
    expect(item.title).not.toContain('…');
  });
});
