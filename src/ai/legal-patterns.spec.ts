import {
  expandQuery,
  extractCitations,
  extractCnr,
  extractSectionReference,
  extractStatuteRefs,
  isValidCnr,
  normaliseActCode,
} from './legal-patterns';

describe('CNR extraction', () => {
  it('finds a bare CNR', () => {
    expect(extractCnr('DLCT010001232024')).toBe('DLCT010001232024');
  });

  it('tolerates the separators advocates actually paste', () => {
    expect(extractCnr('DLCT01-000123-2024')).toBe('DLCT010001232024');
    expect(extractCnr('dlct01 000123 2024')).toBe('DLCT010001232024');
    expect(extractCnr('CNR: DLCT01/000123/2024 please check')).toBe('DLCT010001232024');
  });

  it('returns null when there is no CNR', () => {
    expect(extractCnr('what is section 302 IPC')).toBeNull();
    expect(extractCnr('')).toBeNull();
  });

  it('rejects a malformed CNR', () => {
    expect(isValidCnr('DLCT0100012320')).toBe(false); // too short
    expect(isValidCnr('1234010001232024')).toBe(false); // must start with letters
  });

  it('rejects an implausible year', () => {
    // Guards against a transposed year producing a lookup for year 0024.
    expect(isValidCnr('DLCT010001230024')).toBe(false);
    expect(isValidCnr('DLCT010001232024')).toBe(true);
  });
});

describe('section reference extraction', () => {
  it.each([
    ['what is section 302 IPC', '302', 'IPC'],
    ['sec 498A punishment', '498A', null],
    ['u/s 156(3) CrPC', '156(3)', 'CRPC'],
    ['302 IPC ka punishment kya hai', '302', 'IPC'],
    ['under section 438 of the CrPC', '438', 'CRPC'],
    ['BNS 103 explain karo', '103', 'BNS'],
  ])('parses %s', (input, section, act) => {
    const result = extractSectionReference(input);
    expect(result.section).toBe(section);
    expect(result.act).toBe(act);
  });

  it('returns nulls when nothing is referenced', () => {
    expect(extractSectionReference('find me bail precedents')).toEqual({ section: null, act: null });
  });
});

describe('act code normalisation', () => {
  it('maps long form names and aliases', () => {
    expect(normaliseActCode('indian penal code')).toBe('IPC');
    expect(normaliseActCode('Bharatiya Nyaya Sanhita')).toBe('BNS');
    expect(normaliseActCode('ipc')).toBe('IPC');
    expect(normaliseActCode('nonsense')).toBeNull();
    expect(normaliseActCode(null)).toBeNull();
  });
});

describe('citation extraction', () => {
  // This is the safety-critical direction: a format missed here is a citation
  // that never reaches the guardrail and therefore is never verified.
  it.each([
    ['Relying on AIR 2018 SC 1234 the court held...', 'AIR 2018 SC 1234'],
    ['See (2018) 5 SCC 1 at para 14', '(2018) 5 SCC 1'],
    ['as held in 2024 INSC 452', '2024 INSC 452'],
  ])('extracts from %s', (text, expected) => {
    expect(extractCitations(text)).toContain(expected);
  });

  it('deduplicates repeated citations', () => {
    const text = 'AIR 2018 SC 1234 ... later, AIR 2018 SC 1234 again';
    expect(extractCitations(text).filter((c) => c === 'AIR 2018 SC 1234')).toHaveLength(1);
  });

  it('finds every citation in a multi-citation answer', () => {
    const text = 'See AIR 2018 SC 1234 and also (2020) 7 SCC 1, plus 2024 INSC 452.';
    expect(extractCitations(text).length).toBeGreaterThanOrEqual(3);
  });

  it('returns nothing for text without citations', () => {
    expect(extractCitations('Bail is discretionary in non-bailable offences.')).toEqual([]);
  });

  it('does not carry regex state between calls', () => {
    // Module-level /g regexes retain lastIndex; a leak here would make the
    // second call miss the citation and skip verification.
    const text = 'AIR 2018 SC 1234';
    expect(extractCitations(text)).toEqual(extractCitations(text));
  });
});

describe('statute reference extraction', () => {
  it('normalises both word orders to ACT SECTION', () => {
    expect(extractStatuteRefs('under section 302 IPC')).toContain('IPC 302');
    expect(extractStatuteRefs('IPC Section 420')).toContain('IPC 420');
    expect(extractStatuteRefs('BNS 103 applies')).toContain('BNS 103');
  });

  it('handles several references in one answer', () => {
    const refs = extractStatuteRefs('Sections 302 IPC and 498A IPC, with CrPC 438.');
    expect(refs).toEqual(expect.arrayContaining(['IPC 302', 'IPC 498A', 'CRPC 438']));
  });
});

describe('query expansion', () => {
  it('adds synonyms for a matched group', () => {
    const expanded = expandQuery('anticipatory bail in NDPS matters');
    expect(expanded).toContain('anticipatory bail in NDPS matters');
    expect(expanded.length).toBeGreaterThan('anticipatory bail in NDPS matters'.length);
  });

  it('leaves an unmatched query untouched', () => {
    const query = 'zzz nonexistent legal concept';
    expect(expandQuery(query)).toBe(query);
  });

  it('bounds how much it adds', () => {
    // Unbounded expansion drowns the lexical arm of the hybrid search in noise.
    // Terms are multi-word phrases, so this asserts the overall growth is
    // bounded rather than counting words.
    const query = 'bail fir ipc crpc quash acquittal ndps maintenance';
    expect(expandQuery(query).length).toBeLessThan(query.length * 3);
  });

  it('honours an explicit term cap', () => {
    const query = 'bail fir ipc crpc quash acquittal ndps maintenance';
    expect(expandQuery(query, 1).length).toBeLessThan(expandQuery(query, 6).length);
  });
});
