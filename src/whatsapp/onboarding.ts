/**
 * Parsing the one free-text form the bot asks for.
 *
 * Onboarding asks for "Name, Bar Council ID, City, State" in a single message.
 * That is four questions collapsed into one to keep first contact to a single
 * round trip, and the cost is that the answer arrives in whatever shape the
 * advocate felt like typing: commas, newlines, numbered lines, labels, a
 * trailing full stop.
 *
 * Rejecting anything but the exact format would make the bot feel broken at the
 * very first interaction, which is the worst possible place for it. So the
 * parser is deliberately forgiving about *separators* and strict about the one
 * field it can actually verify - the Bar Council ID has a recognisable shape,
 * and finding it is what lets everything else be positional.
 */

export interface ParsedProfile {
  fullName: string;
  barCouncilId: string;
  city: string;
  state: string;
}

/**
 * `D/1234/2015`, `MAH/12345/2010`, `KAR 567 2019`.
 *
 * A state code, a serial, and an enrolment year. Anchored with boundaries so it
 * does not match a fragment of a longer token, and the year is constrained to
 * 19xx/20xx so a phone number or a pincode cannot pass for one.
 */
const BAR_ID = /(?:^|[\s,;|])([A-Z]{1,5}[\s/-]?\d{1,6}[\s/-]?(?:19|20)\d{2})(?=$|[\s,;|.])/i;

/** Labels people prefix their answers with, which are not part of the value. */
const LABEL = /^(name|full\s*name|bar\s*(council)?\s*(id|no\.?|number)?|city|state|enrolment(\s*no\.?)?)\s*[:\-]\s*/i;

function tidy(value: string): string {
  return (
    value
      .replace(/\s+/g, ' ')
      // Trim before the anchored patterns below, or a single leading space
      // from splitting on ", " defeats both of them.
      .trim()
      // Leading list markers: "1.", "2)", "-", "•".
      .replace(/^(?:\d+\s*[.)]|[-•*])\s*/, '')
      .trim()
      .replace(LABEL, '')
      .replace(/[.,;:]+$/, '')
      .trim()
  );
}

/**
 * Pull a profile out of a free-text message, or null if it is not one.
 *
 * Returning null rather than a partial profile is deliberate: a half-filled
 * form saved to the database is worse than asking again, because the advocate
 * never finds out their city is blank and nothing ever prompts them for it.
 */
export function parseProfile(input: string): ParsedProfile | null {
  if (!input) return null;

  const barMatch = BAR_ID.exec(input);
  if (!barMatch) return null;

  const barCouncilId = barMatch[1].replace(/\s+/g, '').toUpperCase();

  // Split around the Bar Council ID rather than counting fields. A name with a
  // comma in it ("Ramesh Kumar, Jr.") breaks positional parsing; the ID's
  // position does not move.
  const before = input.slice(0, barMatch.index);
  const after = input.slice(barMatch.index + barMatch[0].length);

  const nameParts = before
    .split(/[,;\n|]/)
    .map(tidy)
    .filter(Boolean);
  const tailParts = after
    .split(/[,;\n|]/)
    .map(tidy)
    .filter(Boolean);

  // The name is everything before the ID. Joined rather than [0] so a comma in
  // the name survives instead of truncating it.
  const fullName = nameParts.join(' ').trim();
  const [city = '', state = ''] = tailParts;

  if (!fullName || !city || !state) return null;

  return {
    fullName: titleCase(fullName),
    barCouncilId,
    city: titleCase(city),
    state: titleCase(state),
  };
}

/**
 * Normalise casing for display.
 *
 * People type their own name in every case imaginable, and it is echoed back in
 * "Welcome back RAMESH KUMAR". Small words inside a name are left alone rather
 * than lowercased, because "Ram Das" and "Ram das" are different names and this
 * function has no business deciding which one was meant.
 */
function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) =>
      // Anything already mixed-case is left exactly as typed - "McLeod",
      // "D'Souza" and "DeSouza" are all deliberate.
      /[a-z]/.test(word) && /[A-Z]/.test(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

/**
 * A CNR is 4 letters then 12 digits, of which the last four are the filing
 * year - `BRMG030000191989`.
 *
 * Validated rather than merely extracted, because this is the one place the
 * advocate is explicitly asked for a CNR and "that is not a CNR" is a more
 * useful answer than a lookup that returns nothing.
 */
const CNR_SHAPE = /^[A-Z]{4}\d{12}$/i;

export function isValidCnr(input: string): boolean {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (!CNR_SHAPE.test(cleaned)) return false;

  // The trailing four digits are a year. A CNR from 1899 or 2999 is a typo, and
  // catching it here saves a pointless round trip to the court API.
  const year = Number(cleaned.slice(-4));
  return year >= 1900 && year <= new Date().getUTCFullYear() + 1;
}

export function normaliseCnr(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Did the advocate try to send a CNR, or change the subject?
 *
 * Having asked for a CNR, replying "I could not find that CNR" to *everything*
 * traps the user - "what is ipc 420" gets a CNR error forever and the only
 * escape is knowing to type "menu".
 *
 * The first attempt at this stripped whitespace and looked for a run of 10+
 * alphanumerics. That is wrong, and shipped: removing spaces turns ordinary
 * sentences into long runs, so "what is ipc 420" became "whatisipc420" (12
 * characters) and was read as a botched CNR.
 *
 * Length alone is not the discriminator either - that was the second wrong
 * answer. English is full of 10+ character words, so "punishment for cheating"
 * and "show me precedents on anticipatory bail" both looked like CNRs.
 *
 * **Digit density is the discriminator.** A CNR is 16 characters of which 10
 * are digits (4 letters + 2 alphanumeric + 6-digit case number + 4-digit year).
 * Ordinary legal English contains almost none. So:
 *
 *   - a single token, 10+ alphanumerics, 6+ of them digits -> an attempt
 *   - <= 4 tokens, 14+ alphanumerics, 8+ of them digits     -> an attempt
 *     (a CNR typed in groups, e.g. "DLCT01 000123 2024")
 *   - anything else                                         -> a new question
 *
 * Exported for tests: pure logic, and the regression it guards has reached
 * production twice.
 */
export function looksLikeCnrAttempt(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const alnum = (value: string): string => value.replace(/[^A-Za-z0-9]/g, '');
  const digits = (value: string): number => (value.match(/\d/g) ?? []).length;

  // One unbroken reference number, possibly mistyped.
  const hasReferenceToken = tokens.some((token) => {
    const compact = alnum(token);
    return compact.length >= 10 && digits(compact) >= 6;
  });
  if (hasReferenceToken) return true;

  // Or the same number typed in groups, which people do with long references.
  const whole = alnum(text);
  return tokens.length <= 4 && whole.length >= 14 && digits(whole) >= 8;
}
