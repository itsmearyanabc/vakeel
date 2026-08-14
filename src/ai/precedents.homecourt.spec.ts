import { PrecedentRow } from '../database/types';
import { homeHighCourt, prioritiseHomeCourt, splitParties, stripEllipsis } from './precedents.service';

function row(court: string, title = 'A vs B'): PrecedentRow {
  return {
    judgment_id: court + title,
    case_title: title,
    neutral_citation: null,
    reporter_citations: [],
    court_name: court,
    court_type: 'HIGH_COURT',
    judgment_date: new Date('2024-01-01'),
    bench: [],
    bench_strength: null,
    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,
    source_url: null,
    best_excerpt: 'x',
    para_number: null,
    score: 1,
    relevance_rank: 1,
    total_matches: 1,
  } as PrecedentRow;
}

describe('homeHighCourt', () => {
  it('maps a state to the High Court that actually serves it', () => {
    expect(homeHighCourt('Karnataka')).toBe('karnataka high court');
    expect(homeHighCourt('  bihar ')).toBe('patna high court');
  });

  it.each([
    ['Bihar', 'patna high court'],
    ['Maharashtra', 'bombay high court'],
    ['Punjab', 'punjab & haryana high court'],
    ['Uttar Pradesh', 'allahabad high court'],
    ['West Bengal', 'calcutta high court'],
    ['Tamil Nadu', 'madras high court'],
    ['Assam', 'gauhati high court'],
  ])('%s is served by a court not named after it: %s', (state, court) => {
    // The whole reason this is a lookup and not a substring match on the court
    // name - these are exactly the advocates who would notice it being wrong.
    expect(homeHighCourt(state)).toBe(court);
  });

  it('returns null for an unknown or missing state rather than guessing', () => {
    expect(homeHighCourt(null)).toBeNull();
    expect(homeHighCourt('Atlantis')).toBeNull();
  });
});

describe('prioritiseHomeCourt', () => {
  const rows = [
    row('Delhi High Court'),
    row('Karnataka High Court', 'K1 vs X'),
    row('Bombay High Court'),
    row('Karnataka High Court', 'K2 vs X'),
    row('Karnataka High Court', 'K3 vs X'),
    row('Karnataka High Court', 'K4 vs X'),
  ];

  it('floats the advocate’s own High Court to the top', () => {
    const out = prioritiseHomeCourt(rows, 'Karnataka');
    expect(out.slice(0, 3).map((r) => r.case_title)).toEqual(['K1 vs X', 'K2 vs X', 'K3 vs X']);
  });

  it('caps promotion so one court cannot crowd out everything else', () => {
    // The fourth Karnataka judgment stays where it was; the advocate still
    // needs to see recent authority from elsewhere.
    const out = prioritiseHomeCourt(rows, 'Karnataka');
    expect(out[3].court_name).toBe('Delhi High Court');
    expect(out.map((r) => r.case_title)).toContain('K4 vs X');
  });

  it('preserves relative order within each group', () => {
    const out = prioritiseHomeCourt(rows, 'Karnataka');
    expect(out.slice(3).map((r) => r.court_name)).toEqual([
      'Delhi High Court',
      'Bombay High Court',
      'Karnataka High Court',
    ]);
  });

  it('leaves the list untouched when the state is unknown', () => {
    expect(prioritiseHomeCourt(rows, null)).toEqual(rows);
    expect(prioritiseHomeCourt(rows, 'Atlantis')).toEqual(rows);
  });

  it('never drops or duplicates a result', () => {
    const out = prioritiseHomeCourt(rows, 'Karnataka');
    expect(out).toHaveLength(rows.length);
    expect(new Set(out.map((r) => r.judgment_id)).size).toBe(rows.length);
  });
});

describe('splitParties', () => {
  it.each([
    ['State of Bihar vs Ram Kumar', 'State of Bihar', 'Ram Kumar'],
    ['A v. B', 'A', 'B'],
    ['A versus B', 'A', 'B'],
    ['A v/s B', 'A', 'B'],
  ])('splits %s', (title, petitioner, respondent) => {
    expect(splitParties(title)).toEqual({ petitioner, respondent });
  });

  it('splits on the first separator only', () => {
    // One case with a messy respondent, not three parties. Splitting on every
    // occurrence would silently drop the tail.
    expect(splitParties('State of Bihar vs Ram Kumar vs Anr')).toEqual({
      petitioner: 'State of Bihar',
      respondent: 'Ram Kumar vs Anr',
    });
  });

  it('does not split a party whose name merely contains "vs"', () => {
    expect(splitParties('Advseva Foundation').petitioner).toBe('Advseva Foundation');
    expect(splitParties('Advseva Foundation').respondent).toBeNull();
  });

  it('removes the ellipses Kanoon leaves behind', () => {
    expect(splitParties('Tiger Global International Iii ... vs The Authority ...')).toEqual({
      petitioner: 'Tiger Global International Iii',
      respondent: 'The Authority',
    });
  });
});

describe('stripEllipsis', () => {
  it.each([
    ['A ... vs B', 'A vs B'],
    ['A… vs B', 'A vs B'],
    ['Trailing ...', 'Trailing'],
  ])('%s -> %s', (input, expected) => {
    expect(stripEllipsis(input)).toBe(expected);
  });

  it('leaves a normal full stop alone', () => {
    expect(stripEllipsis('R. Gavai, J. held that.')).toBe('R. Gavai, J. held that.');
  });
});
