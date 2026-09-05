/**
 * "Rajesh Kumar Mittal vs State of Bihar" is a case, not a topic.
 *
 * ## The failure this exists to stop
 *
 * An advocate asked for that case, by name, in the Patna High Court. What came
 * back was headed "Case law - 10 precedents" and the first result was *Sunil
 * Bharti Mittal vs The State Of Bihar*. Nothing about that reply was flagged as
 * uncertain: ten unrelated judgments, presented as authority, in the confident
 * format the product uses for a topic search that worked.
 *
 * The retrieval did nothing wrong on its own terms. It was handed free text and
 * ranked by relevance, and "Mittal" plus "State of Bihar" genuinely is the best
 * lexical match available when the named case is not in the result set. The
 * mistake is one level up: a request for *one named judgment* and a request for
 * *authorities on a question* are different questions, and only one of them is
 * answered by "here are ten relevant cases, newest first".
 *
 * ## What this module decides, and what it does not
 *
 * It decides two things, both purely from text: whether the advocate named a
 * case, and how well a given judgment title matches the name they gave. It does
 * not fetch, rank, or format anything - the caller does that, so this stays
 * testable without a network or a corpus.
 *
 * It deliberately does **not** try to decide whether a case exists. Absence
 * from Kanoon's index is not absence from the law reports, and a bot that says
 * "no such case" on that basis would be wrong in a way an advocate cannot
 * check. What the caller says instead is "I could not find a judgment by that
 * name", which is true and is a different claim.
 */

export interface CaseName {
  /** The party before the "vs". */
  petitioner: string;
  /** The party after it. */
  respondent: string;
  /**
   * The court the advocate named, as they wrote it - "Patna High court".
   *
   * Stripped out of the parties, and kept rather than discarded, because it
   * still narrows the search - but as a `doctypes:` restriction resolved from
   * it, never as words in the query. Leaving "Patna High Court" in the text
   * being matched puts three tokens into it that every judgment of that court
   * also contains, which crowds out the parties. See namedCaseQuery.
   */
  court?: string;
}

/**
 * Words that carry no identifying force in a case title.
 *
 * "State", "Union of India" and "Ors" appear in a large fraction of Indian
 * judgments, so matching on them matches almost everything - which is exactly
 * how *Sunil Bharti Mittal vs The State Of Bihar* came first for a query about
 * a different Mittal. They are kept for display and ignored for scoring.
 */
const NOISE = new Set([
  'the', 'of', 'and', 'a', 'an', 'in', 'at', 'on', 'v', 'vs', 'versus',
  'ors', 'ors.', 'anr', 'anr.', 'others', 'another', 'etc',
  'state', 'states', 'union', 'india', 'govt', 'government',
  'ltd', 'ltd.', 'limited', 'pvt', 'pvt.', 'private', 'co', 'co.', 'company',
  'm/s', 'ms', 'mr', 'mrs', 'shri', 'smt', 'sri',
]);

/**
 * Everything an advocate puts in front of a case name that is not part of it.
 *
 * `law` is in the noun list and `for|on|about` in the preposition list because
 * of a real reply: "case law for Rajesh Kumar Mittal vs ..." lost only the word
 * "case", and the petitioner came out as "law for Rajesh Kumar Mittal". Both
 * halves are repeated so the whole phrase goes, not just its first word.
 */
const LEAD_IN =
  /^(?:(?:the\s+)?(?:case|judgment|judgement|matter|decision|order|citation|ruling|law)\s+)+(?:(?:of|in|for|on|about|titled|named|regarding|re)\s+)*/i;

/**
 * The date Kanoon puts in its own titles, which advocates paste back verbatim.
 *
 * Every Kanoon result is titled "X vs Y on 18 January, 2005", so the fastest
 * way for somebody to ask about one is to copy that line - and the respondent
 * then came out as "State Of Bihar on 18 January", which is quoted back in the
 * heading and diluted the score with two tokens that identify nothing.
 */
const TRAILING_DATE = /\s+on\s+\d{1,2}\s+[A-Za-z]+,?\s*(?:(?:19|20)\d{2})?\s*$/i;

/**
 * A court named as context for the search, not as a party.
 *
 * The first version required punctuation in front of it, which caught
 * "... vs State of Bihar . Patna High court" and missed "... vs State of Bihar
 * in Patna High Court" - and the second is the ordinary way to write it.
 *
 * A case genuinely brought *against* a court - a writ on the administrative
 * side - loses its respondent here and the whole extraction returns null, so
 * the query falls back to an ordinary topic search. That is the right way for
 * this to fail: a topic search on a cause title still finds the case, while a
 * name lookup with an empty respondent could not.
 */
const TRAILING_COURT =
  /[\s.,;]+(?:(?:in|from|at|before|of|by)\s+)?(?:the\s+)?[A-Za-z]*\s*\b(?:high\s+court|supreme\s+court|apex\s+court|tribunal|district\s+court|sessions\s+court)\b.*$/i;

/**
 * The separator, in the forms that appear in practice.
 *
 * `v.` and `vs.` are the reported forms; `versus` is written out in cause
 * titles; `vs` unpunctuated is what people type on a phone. Requiring word
 * boundaries on both sides keeps it from firing inside a word - without them,
 * "Ms" and "Advs" both contain a match.
 */
const SEPARATOR = /\s+(?:vs?\.?|versus)\s+/i;

/**
 * Pull a case name out of a message, or null when there is not one.
 *
 * Null is the common answer and the right one for most queries: "anticipatory
 * bail after chargesheet" names no case and must go on being answered as a
 * topic search.
 */
export function extractCaseName(text: string): CaseName | null {
  if (!text) return null;

  // Trailing court and date qualifiers - "... . Patna High court", "... (2017)"
  // - are context for the search, not part of the name.
  const withoutLeadIn = text
    .trim()
    .replace(LEAD_IN, '')
    .replace(/[.,;]?\s*\(?\b(19|20)\d{2}\)?\s*$/, '');

  const courtMatch = TRAILING_COURT.exec(withoutLeadIn);
  const trimmed = withoutLeadIn
    .replace(TRAILING_COURT, '')
    .replace(TRAILING_DATE, '')
    .trim();

  const parts = trimmed.split(SEPARATOR);
  if (parts.length !== 2) return null;

  const petitioner = tidyParty(parts[0]);
  const respondent = tidyParty(parts[1]);
  if (!petitioner || !respondent) return null;

  // A separator with a whole sentence on one side is not a cause title. "Is
  // bail granted when the accused vs the complainant have settled" is a
  // question, and answering it with a case-name lookup would be worse than
  // answering it as a topic.
  if (words(petitioner).length > 8 || words(respondent).length > 8) return null;

  const court = courtMatch ? courtMatch[0].replace(/^[\s.,;]+/, '').trim() : undefined;
  return court ? { petitioner, respondent, court } : { petitioner, respondent };
}

/**
 * How well a judgment title matches the name the advocate gave: 0 to 1.
 *
 * ## Why the two halves are not weighted equally
 *
 * The petitioner is what identifies an Indian case. The respondent is very
 * often the State, and "vs State of Bihar" is shared by tens of thousands of
 * judgments - so a respondent match is nearly free and must not be able to
 * carry a result on its own. Scoring them equally is what let a title agreeing
 * on *only* the common half rank first.
 *
 * The distinctive tokens are what count on both sides. Once "the", "state",
 * "of" and "ors" are removed, "Rajesh Kumar Mittal" contributes {rajesh,
 * kumar, mittal} and "Sunil Bharti Mittal" matches one of the three.
 */
export function caseNameScore(name: CaseName, title: string): number {
  const parts = title.split(SEPARATOR);
  const titlePetitioner = signal(parts[0] ?? '');
  const titleRespondent = signal(parts[1] ?? '');

  const wantPetitioner = signal(name.petitioner);
  const wantRespondent = signal(name.respondent);

  // No distinctive tokens on either side of the request - "State vs State".
  // Nothing to match on, so nothing is claimed.
  if (wantPetitioner.length === 0 && wantRespondent.length === 0) return 0;

  const petitioner = overlap(wantPetitioner, titlePetitioner);
  const respondent = overlap(wantRespondent, titleRespondent);

  // When the request has no distinctive petitioner, the respondent is all there
  // is and carries the score alone; otherwise it is worth a quarter.
  if (wantPetitioner.length === 0) return respondent;
  if (wantRespondent.length === 0) return petitioner;
  return petitioner * 0.75 + respondent * 0.25;
}

/**
 * The score at which a title is the case that was asked for.
 *
 * Set from the failure it exists to catch. *Sunil Bharti Mittal vs The State Of
 * Bihar* scores 0.33 x 0.75 + 1 x 0.25 = 0.5 against "Rajesh Kumar Mittal vs
 * State of Bihar" - one shared surname and the universal respondent - so the
 * bar has to sit above that. A genuine match, differing only in "The" and
 * capitalisation, scores 1.
 *
 * Deliberately not higher than 0.7: an advocate types "Mittal vs State of
 * Bihar" from memory more often than they type the full cause title, and that
 * abbreviation scores 1 against the real case and must still be found.
 */
export const CASE_NAME_MATCH = 0.7;

/** Distinctive tokens: lowercased, punctuation gone, noise words dropped. */
function signal(value: string): string[] {
  return words(value).filter((word) => !NOISE.has(word) && word.length > 1);
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** What fraction of the wanted tokens appear in the candidate. */
function overlap(wanted: string[], found: string[]): number {
  if (wanted.length === 0) return 0;
  const have = new Set(found);
  const hits = wanted.filter((word) => have.has(word)).length;
  return hits / wanted.length;
}

/** Strip the decorations around a party name without altering the name. */
function tidyParty(value: string): string {
  return value
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
