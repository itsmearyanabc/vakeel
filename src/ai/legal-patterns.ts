/**
 * Pattern matching for Indian legal text.
 *
 * Used in two places with opposite goals:
 *  - on the way IN, to pull structure out of what an advocate typed
 *  - on the way OUT, to find every citation the model produced so the guardrail
 *    can check each one against the corpus
 *
 * The output direction is the one that matters for safety: a citation format
 * missed here is a citation that never gets verified, so these patterns err
 * towards over-matching. A false positive costs one wasted corpus lookup.
 */

/**
 * CNR (Case Number Record): 16 characters.
 *   4 letters   state + district code   e.g. DLCT
 *   2 alnum     court establishment     e.g. 01
 *   6 digits    case number             e.g. 000123
 *   4 digits    year                    e.g. 2024
 *
 * Advocates paste these with hyphens and spaces, so normalise before matching.
 */
const CNR_PATTERN = /\b([A-Z]{4}[A-Z0-9]{2})[\s\-_/]?(\d{6})[\s\-_/]?(\d{4})\b/;

export function extractCnr(text: string): string | null {
  // Matched against the original text with optional separators, rather than
  // against a separator-stripped copy. Stripping first glues the CNR to
  // surrounding words ("CNR: DLCT01/000123/2024 please" -> "...2024PLEASE"),
  // which destroys the trailing word boundary and the match with it.
  const match = CNR_PATTERN.exec(text.toUpperCase());
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

export function isValidCnr(cnr: string): boolean {
  const normalised = cnr.toUpperCase().replace(/[\s\-_/]/g, '');
  if (normalised.length !== 16) return false;
  if (!/^[A-Z]{4}[A-Z0-9]{2}\d{10}$/.test(normalised)) return false;

  // Year sanity check: eCourts data starts in the 1950s, and a case filed in
  // the future is a typo.
  const year = Number(normalised.slice(12, 16));
  return year >= 1950 && year <= new Date().getFullYear() + 1;
}

/**
 * Acts we can resolve provision references against.
 *
 * CPC was missing, which made every civil-procedure question unrecognisable:
 * "order 32 CPC" extracted no act, no provision, and fell through to the
 * classifier as free text - which sent a question about a procedural rule to a
 * case-law search. The list was assembled from the criminal side of practice
 * and never revisited, and civil litigation is most of the work.
 */
export const KNOWN_ACTS = ['IPC', 'BNS', 'CRPC', 'BNSS', 'IEA', 'BSA', 'CPC', 'COI'] as const;
export type ActCode = (typeof KNOWN_ACTS)[number];

const ACT_ALIASES: Record<string, ActCode> = {
  ipc: 'IPC',
  'indian penal code': 'IPC',
  'penal code': 'IPC',
  bns: 'BNS',
  'bharatiya nyaya sanhita': 'BNS',
  'nyaya sanhita': 'BNS',
  crpc: 'CRPC',
  'cr.p.c': 'CRPC',
  'criminal procedure code': 'CRPC',
  'code of criminal procedure': 'CRPC',
  bnss: 'BNSS',
  'bharatiya nagarik suraksha sanhita': 'BNSS',
  'nagarik suraksha sanhita': 'BNSS',
  iea: 'IEA',
  'evidence act': 'IEA',
  'indian evidence act': 'IEA',
  bsa: 'BSA',
  'bharatiya sakshya adhiniyam': 'BSA',
  'sakshya adhiniyam': 'BSA',
  cpc: 'CPC',
  'civil procedure code': 'CPC',
  'code of civil procedure': 'CPC',
  coi: 'COI',
  constitution: 'COI',
  'constitution of india': 'COI',
  'indian constitution': 'COI',
  samvidhan: 'COI',
  'संविधान': 'COI',
};

export function normaliseActCode(raw: string | null | undefined): ActCode | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[.,]/g, '').trim();
  return ACT_ALIASES[key] ?? (KNOWN_ACTS.includes(key.toUpperCase() as ActCode) ? (key.toUpperCase() as ActCode) : null);
}

/**
 * Pull a section number out of free text.
 *
 * Handles the forms that actually turn up: "section 302", "sec 302", "s.302",
 * "u/s 302", "302 IPC", "under section 498A of the IPC". Sub-sections like
 * "156(3)" are kept intact because they change the meaning entirely.
 */
export function extractSectionReference(text: string): { section: string | null; act: ActCode | null } {
  // `crpc` and the criminal codes are listed before `cpc`, and `code of
  // criminal procedure` before `code of civil procedure`, because the regex
  // engine takes the first alternative that matches at a position - and "CrPC"
  // read as "CPC" would answer a criminal question with civil procedure.
  const actMatch =
    /\b(ipc|bns|crpc|cr\.?p\.?c|bnss|iea|bsa|cpc|indian penal code|penal code|bharatiya nyaya sanhita|nyaya sanhita|code of criminal procedure|criminal procedure code|bharatiya nagarik suraksha sanhita|evidence act|indian evidence act|bharatiya sakshya adhiniyam|code of civil procedure|civil procedure code|constitution of india|indian constitution|constitution|संविधान)\b/i.exec(
      text,
    );

  const act = normaliseActCode(actMatch?.[1]);

  // The suffix letter of "498A" must be ADJACENT to the digits. Allowing
  // whitespace before it makes "section 302 IPC" parse as section "302I",
  // swallowing the first letter of the act name - which then fails every
  // lookup, silently.
  const explicit = /\b(?:u\/s|under\s+section|section|sec|s)\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/i.exec(text);
  if (explicit?.[1]) {
    return { section: explicit[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  // "302 IPC" - number immediately before the act name.
  const trailing = /\b(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)\s+(?:ipc|bns|crpc|bnss|iea|bsa)\b/i.exec(text);
  if (trailing?.[1]) {
    return { section: trailing[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  // "BNS 103" - act name immediately before the number. Common in Hinglish
  // ("BNS 103 explain karo") and missed entirely by the two patterns above.
  const leading = /\b(?:ipc|bns|crpc|bnss|iea|bsa)\b\s*(?:section|sec|s)?\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/i.exec(
    text,
  );
  if (leading?.[1]) {
    return { section: leading[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  return { section: null, act };
}

/**
 * A reference to an Order (and optionally a Rule) of the Civil Procedure Code.
 *
 * ## Why this is separate from a section number
 *
 * The CPC is not organised into sections the way the IPC is. Its substantive
 * body has sections, but the procedure practitioners actually cite lives in the
 * First Schedule, as Orders divided into Rules - "Order 32", "Order 37 Rule 3".
 * An advocate asking about civil procedure names an Order, and the section
 * matcher has no concept of one, so the whole question read as free text.
 *
 * Returned as a display string rather than a number because "Order 37 Rule 3"
 * is one reference, not two, and splitting it loses which rule of which order.
 *
 * Deliberately not matched without a following number: "order" is an ordinary
 * English word and appears in "interim order", "order sheet" and "order of the
 * court", none of which is a citation.
 */
export function extractOrderReference(text: string): string | null {
  /*
   * The numeral must end on a word boundary, and a Roman one must be at least
   * two characters.
   *
   * Without either, "interim order in a bail matter" reads the "i" of "in" as
   * Roman one, and answers a bail question with Order 1 of the CPC. The cost of
   * the second rule is that "Order I" written in Roman is missed; in practice it
   * is written "Order 1", and a missed reference degrades to an ordinary search
   * while a false one sends the advocate somewhere unrelated.
   */
  const match =
    /\bo(?:rder)?\.?\s*([IVXLC]{2,}|\d{1,3})\b\s*(?:,?\s*r(?:ule)?\.?\s*(\d{1,3}[A-Z]?))?/i.exec(
      text,
    );
  if (!match) return null;

  // Roman numerals appear on the older reports; normalised so "Order XXXII" and
  // "Order 32" are the same reference to everything downstream.
  const order = fromRoman(match[1]);
  if (!order || order < 1 || order > 51) return null;

  return match[2] ? `Order ${order} Rule ${match[2].toUpperCase()}` : `Order ${order}`;
}

/**
 * A reference to an Article of the Constitution.
 *
 * ## Why this needed its own extractor, like Orders did
 *
 * Constitutional provisions are Articles, and nothing recognised one - so
 * "Article 226" reached the classifier as free text and came back a case-law
 * search, which is the same failure "order 32 CPC" had and for the same reason:
 * the reference was invisible, so a model guessed.
 *
 * Article 226 and Article 32 are two of the most-asked provisions in Indian
 * practice. They are also the kind an advocate quotes by number and expects to
 * be understood without spelling out where it comes from, which is why the act
 * is inferred rather than required.
 *
 * Bounded at 395, the last Article of the original text. The letter suffix
 * carries the amendments - 21A, 300A, 243ZG - and is preserved as typed.
 *
 * Like {@link extractOrderReference}, never matched without a number after it:
 * "article" is an ordinary English word, and "the articles of association" is
 * not a constitutional question.
 */
export function extractArticleReference(text: string): string | null {
  // The amendment suffix must be adjacent to the number - "21A", never "21 A".
  // With a gap allowed, the case-insensitive flag lets the next English word
  // become the suffix, and "article 226 in a writ petition" reads as 226IN.
  const match = /\bart(?:icle)?\.?\s*(\d{1,3})([A-Z]{1,3})?\b/i.exec(text);
  if (!match) return null;

  const article = Number(match[1]);
  if (article < 1 || article > 395) return null;

  return match[2] ? `Article ${article}${match[2].toUpperCase()}` : `Article ${article}`;
}

/** A decimal string, or a Roman numeral, as a number. Null when neither. */
function fromRoman(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);

  const digits: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  const upper = value.toUpperCase();
  if (!/^[IVXLC]+$/.test(upper)) return null;

  let total = 0;
  for (let i = 0; i < upper.length; i++) {
    const here = digits[upper[i]];
    const next = digits[upper[i + 1]] ?? 0;
    total += here < next ? -here : here;
  }
  return total;
}

/**
 * Every case-citation format we recognise.
 *
 * Order matters only for readability; matches are deduplicated by the caller.
 */
const CITATION_PATTERNS: RegExp[] = [
  // Neutral citations: 2024 INSC 452, 2023 DHC 1234
  /\b(\d{4}\s+(?:INSC|SCC\s+OnLine\s+[A-Z][a-z]*|[A-Z]{2,5})\s+\d+)\b/g,
  // AIR 2018 SC 1234
  /\b(AIR\s+\d{4}\s+[A-Z]{2,4}\s+\d+)\b/gi,
  // (2018) 5 SCC 1
  /(\(\d{4}\)\s*\d+\s*SCC\s*\d+)/gi,
  // 2018 (5) SCC 1  /  2018 (2) Crimes 45
  /\b(\d{4}\s*\(\d+\)\s*[A-Z][A-Za-z]*\s*\d+)\b/g,
  // (2020) 7 SCC 1 style with reporter variants
  /(\(\d{4}\)\s*\d+\s*[A-Z]{2,6}\s*\d+)/g,
];

/** Extract case citations from model output, deduplicated and trimmed. */
export function extractCitations(text: string): string[] {
  const found = new Set<string>();

  for (const pattern of CITATION_PATTERNS) {
    // Fresh lastIndex each pass: these are module-level /g regexes and would
    // otherwise resume mid-string on the next call.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const citation = match[1]?.replace(/\s+/g, ' ').trim();
      if (citation && citation.length >= 8) found.add(citation);
    }
  }

  const candidates = [...found];

  // The patterns overlap by design (over-matching is safer than missing a
  // citation), which means "AIR 2018 SC 1234" also yields the fragment
  // "2018 SC 1234" via the neutral-citation pattern. Left in, that fragment is
  // verified separately, found not to exist, and struck from the answer -
  // corrupting the valid citation it came from. Keep only maximal matches.
  return candidates.filter(
    (candidate) => !candidates.some((other) => other !== candidate && other.includes(candidate)),
  );
}

/**
 * Extract statutory references from model output as normalised 'ACT SECTION'
 * strings, ready for verify_statute_refs().
 */
export function extractStatuteRefs(text: string): string[] {
  const refs = new Set<string>();

  // "Section 302 IPC" / "Section 302 of the IPC" / "Sections 302 IPC and ..."
  // `sections?` matters: an answer listing several provisions almost always
  // writes the plural, and requiring the singular missed all of them.
  // The suffix letter is adjacent to the digits for the same reason as in
  // extractSectionReference - otherwise "302 IPC" becomes section "302I".
  const forward =
    /\b(?:u\/s|under\s+sections?|sections?|secs?|s)\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)\s*(?:of\s+(?:the\s+)?)?\b(IPC|BNS|CrPC|BNSS|IEA|BSA)\b/gi;
  // "IPC Section 302" / "IPC 302"
  const backward =
    /\b(IPC|BNS|CrPC|BNSS|IEA|BSA)\b\s*(?:sections?|secs?|s)?\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/gi;
  // Bare "302 IPC" with no section keyword at all. Needed for the second and
  // later items in a list - "Sections 302 IPC and 498A IPC" carries the keyword
  // only once, so without this every provision after the first goes unverified.
  const bare =
    /\b(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)\s+(?:of\s+(?:the\s+)?)?(IPC|BNS|CrPC|BNSS|IEA|BSA)\b/gi;

  let match: RegExpExecArray | null;

  while ((match = forward.exec(text)) !== null) {
    refs.add(`${match[2].toUpperCase()} ${match[1].replace(/\s+/g, '').toUpperCase()}`);
  }
  while ((match = backward.exec(text)) !== null) {
    refs.add(`${match[1].toUpperCase()} ${match[2].replace(/\s+/g, '').toUpperCase()}`);
  }
  while ((match = bare.exec(text)) !== null) {
    refs.add(`${match[2].toUpperCase()} ${match[1].replace(/\s+/g, '').toUpperCase()}`);
  }

  return [...refs];
}

/**
 * Query-side synonym expansion.
 *
 * The architecture spec puts this in an Elasticsearch synonym filter. Postgres'
 * equivalent is a thesaurus dictionary, which needs a file on the database
 * server's filesystem - not possible on managed Supabase. Expanding at query
 * time gets the same recall benefit with no infrastructure, at the cost of a
 * slightly longer tsquery.
 */
const SYNONYM_GROUPS: string[][] = [
  ['bail', 'interim bail', 'anticipatory bail', 'regular bail'],
  ['fir', 'first information report'],
  ['ipc', 'indian penal code', 'bns', 'bharatiya nyaya sanhita'],
  ['crpc', 'code of criminal procedure', 'bnss', 'bharatiya nagarik suraksha sanhita'],
  ['quash', 'quashing', 'quashment'],
  ['acquittal', 'acquitted', 'acquit'],
  ['conviction', 'convicted', 'convict'],
  ['ndps', 'narcotic drugs and psychotropic substances'],
  ['maintenance', 'alimony', 'interim maintenance'],
  ['injunction', 'stay order', 'restraint order'],
  ['cheque bounce', 'dishonour of cheque', 'section 138', 'negotiable instruments act'],
  ['custody', 'judicial custody', 'police remand'],
  ['dowry', 'dowry death', 'dowry harassment'],
  ['chargesheet', 'charge sheet', 'final report'],
];

/**
 * Append synonyms for any group the query touches.
 *
 * Deliberately additive and capped: the goal is recall on the lexical arm of
 * the hybrid search, and an unbounded expansion starts pulling in noise that
 * outranks the actual answer.
 */
export function expandQuery(query: string, maxExtraTerms = 6): string {
  const lower = query.toLowerCase();
  const additions: string[] = [];

  for (const group of SYNONYM_GROUPS) {
    const hit = group.find((term) => lower.includes(term));
    if (!hit) continue;
    for (const term of group) {
      if (term !== hit && !lower.includes(term) && additions.length < maxExtraTerms) {
        additions.push(term);
      }
    }
  }

  return additions.length > 0 ? `${query} ${additions.join(' ')}` : query;
}
