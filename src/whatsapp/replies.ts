import { CaseStatus } from '../ecourts/ecourts.service';
import { StatuteRow } from '../database/types';

/**
 * Static reply copy and menu definitions.
 *
 * Kept out of the conversation service so the wording can be reviewed and
 * edited without reading control flow. Free-form answers are generated and
 * translated by the LLM; only these fixed strings live here.
 */

/**
 * Closing lines that every substantive answer carries.
 *
 * Defined once because they are a product commitment, not decoration: an
 * advocate must never be able to receive a case status, a section synopsis or a
 * precedent list without also being told it is unverified, and without a way
 * back to the menu. Three copies of this string in three formatters is three
 * chances for one of them to drift.
 */
export const CAVEAT =
  '_This is a research aid. Verify from original sources before court use. Not legal advice._';

export const RETURN_TO_MENU = "Type *0* to return to the help menu.";

/** Interactive payload ids. These are matched on exactly - do not reword. */
export const ACTION = {
  MAIN_MENU: 'menu:main',
  CASE_STATUS: 'menu:case_status',
  SECTION_LOOKUP: 'menu:section',
  RESEARCH: 'menu:research',
  VERIFY: 'menu:verify',
  LANGUAGE: 'menu:language',
  USAGE: 'menu:usage',
  HELP: 'menu:help',
  CANCEL: 'menu:cancel',
} as const;

/**
 * The three languages offered at session start.
 *
 * Narrowed from eight. The list is read aloud on a phone as a numbered choice,
 * and eight options across three scripts is a wall of text that costs more
 * comprehension than the extra coverage buys. `aliases` is what lets an
 * advocate type "hindi", "हिंदी" or "2" and be understood either way.
 */
export const LANGUAGES: { code: string; label: string; aliases: string[] }[] = [
  { code: 'en', label: 'English', aliases: ['english', 'eng', 'angrezi'] },
  { code: 'hi', label: 'हिंदी', aliases: ['hindi', 'हिंदी', 'हिन्दी'] },
  { code: 'kn', label: 'ಕನ್ನಡ', aliases: ['kannada', 'ಕನ್ನಡ', 'kannad'] },
];

/**
 * Resolve whatever the advocate typed into a language code.
 *
 * Accepts the menu number, the English name or the native name, because all
 * three are things people actually send and rejecting two of them would make
 * the menu feel broken. Returns null when nothing matches, which the caller
 * turns into a re-prompt rather than a guess.
 */
export function matchLanguage(input: string): { code: string; label: string } | null {
  const cleaned = input.trim().toLowerCase().replace(/[.)\s]+$/, '');
  if (!cleaned) return null;

  const byNumber = Number(cleaned);
  if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= LANGUAGES.length) {
    const picked = LANGUAGES[byNumber - 1];
    return { code: picked.code, label: picked.label };
  }

  const picked = LANGUAGES.find(
    (l) => l.code === cleaned || l.label.toLowerCase() === cleaned || l.aliases.includes(cleaned),
  );
  return picked ? { code: picked.code, label: picked.label } : null;
}

/** The numbered language prompt, identical everywhere it is shown. */
export const LANGUAGE_PROMPT = [
  '*Select your language:*',
  LANGUAGES.map((l, i) => `${i + 1}. ${l.label}`).join('   '),
].join('\n');

/**
 * The capability list, repeated in the greeting and in the help menu.
 *
 * Deliberately duplicated rather than shown once at signup. WhatsApp threads
 * scroll away and an advocate returning after a week should not have to hunt
 * upwards to remember what the bot does - the three things it can do are
 * cheaper to restate than to look up.
 */
const CAPABILITIES = [
  '• Case Status (send CNR)',
  '• Law Sections (e.g., IPC 420)',
  '• Case Law / Precedents',
].join('\n');

/**
 * The browser half of the product, mentioned where somebody wants it.
 *
 * WhatsApp linkifies a bare https:// URL, so it arrives tappable with no
 * markup. Renders as nothing when the deployment has no public URL - a line
 * reading "Full app:" above an empty space is worse than silence.
 *
 * Always placed *before* whatever the message asks for. The last line of a
 * WhatsApp message is the one people act on, and that line should be the
 * question, not a link that changes the subject.
 */
function siteLine(site: string, lead: string): string[] {
  const url = site.trim().replace(/\/+$/, '');
  return url ? ['', lead, url] : [];
}

/**
 * First contact: greet, list capabilities, point at the website, ask for the
 * profile.
 *
 * The website is named here rather than after onboarding because this is the
 * moment a new advocate decides whether the thing is real. It is also the
 * honest framing - the two surfaces are one account, and somebody who starts
 * on WhatsApp today can sign in on the site later with this same number and
 * find their history waiting. PhoneVerificationService does that merge.
 */
export function greetingNewUser(site = ''): string {
  return [
    '*Jai Hind!*',
    '',
    'Welcome to *Vakeel Saathi*. I can help you with:',
    CAPABILITIES,
    ...siteLine(site, 'Full app in your browser — same account, same credits:'),
    '',
    'To get started here, please send your *Name, Bar Council ID, City, State*',
    '',
    '_Example: Ramesh Kumar, D/1234/2015, Patna, Bihar_',
  ].join('\n');
}

/**
 * A known advocate starting a new session.
 *
 * Carries the balance, because "how many credits do I have left" is the
 * question every returning user has and the one they would otherwise spend a
 * message asking.
 */
export function greetingReturning(name: string | null, credits = '', site = ''): string {
  const who = name ? ` ${name.split(',')[0].trim()}` : '';
  return [
    '*Jai Hind!*',
    '',
    `Welcome back${who} to *Vakeel Saathi*. I can help you with:`,
    CAPABILITIES,
    ...(credits ? ['', `_${credits}_`] : []),
    ...siteLine(site, 'Full app:'),
    '',
    LANGUAGE_PROMPT,
  ].join('\n');
}

/**
 * Somebody asked a real question before registering.
 *
 * Distinct from NOT_UNDERSTOOD deliberately. "I could not understand that" is
 * true of a malformed profile and false of "what is IPC 420" - that was
 * understood perfectly and simply cannot be answered yet. Telling an advocate
 * their question was gibberish reads as a broken bot, and what they need is
 * not to rephrase it but to register.
 */
export function profileNeededFirst(site = ''): string {
  return [
    'I can answer that as soon as you are registered.',
    '',
    'Please send your *Name, Bar Council ID, City, State* first.',
    '',
    '_Example: Ramesh Kumar, D/1234/2015, Patna, Bihar_',
    ...siteLine(site, 'Or register in your browser:'),
  ].join('\n');
}

/**
 * Confirm the language and show the numbered menu.
 *
 * Credits are shown here rather than only on request, because the decision an
 * advocate makes next - which of the three options to pick - is the decision
 * the balance is relevant to.
 */
export function menuAfterLanguage(
  name: string | null,
  languageLabel: string,
  credits: string,
): string {
  const who = name ? name.split(',')[0].trim() : 'You';
  return [
    `${who}, you have selected *${languageLabel}*.`,
    '',
    'I can help you with:',
    '1. Case Status (send CNR)',
    '2. Law Sections (e.g., IPC 420)',
    '3. Case Law / Precedents',
    '',
    `_${credits}_`,
    '',
    'Reply with *1*, *2* or *3*.',
  ].join('\n');
}

/** The same menu, for every later return to it. */
export function helpMenu(credits: string): string {
  return [
    '*I can help you with:*',
    '1. Case Status (send CNR)',
    '2. Law Sections (e.g., IPC 420)',
    '3. Case Law / Precedents',
    '',
    `_${credits}_`,
    '',
    'Reply with *1*, *2* or *3*.',
  ].join('\n');
}

/**
 * Shown when input cannot be understood.
 *
 * Says what happened before showing the menu again. A bare menu in response to
 * a real question reads as the bot ignoring it, and the advocate retypes the
 * same thing rather than rephrasing.
 */
export const NOT_UNDERSTOOD = 'I could not understand that.';

export const INVALID_CNR =
  'The case number is invalid. Please confirm and try again.\n\n' +
  '_A CNR is 16 characters: 4 letters, then 10 digits ending in a year — e.g. BRMG030000191989_';

export const NO_CASE_DATA =
  'No case data found for the provided CNR number. Please verify the CNR and try again.\n\n' +
  CAVEAT;

export const MAIN_MENU_SECTIONS = [
  {
    title: 'Research',
    rows: [
      {
        id: ACTION.RESEARCH,
        title: 'Case law search',
        description: 'Find precedents and judgments on a legal question',
      },
      {
        id: ACTION.SECTION_LOOKUP,
        title: 'Section lookup',
        description: 'Explain a section of the IPC, BNS, CrPC, BNSS or Evidence Act',
      },
      {
        id: ACTION.CASE_STATUS,
        title: 'Case status',
        description: 'Check a case by its 16-digit CNR number',
      },
    ],
  },
  {
    title: 'Account',
    rows: [
      { id: ACTION.VERIFY, title: 'Verify my licence', description: 'Submit bar council details' },
      { id: ACTION.USAGE, title: 'My usage', description: "Today's query count" },
      { id: ACTION.LANGUAGE, title: 'Change language', description: 'Choose your reply language' },
      { id: ACTION.HELP, title: 'Help', description: 'What this assistant can do' },
    ],
  },
];

export function welcome(name?: string | null): string {
  const greeting = name ? `Namaste ${name.split(' ')[0]}` : 'Namaste';
  return [
    `${greeting} — welcome to *Vakeel Saathi* (वकील साथी).`,
    '',
    'I am a legal research assistant for advocates practising in India. I can:',
    '',
    '· Search Supreme Court and High Court judgments for precedents',
    '· Explain sections of the IPC, BNS, CrPC, BNSS and Evidence Act',
    '· Look up case status by CNR number',
    '',
    'Just type your question in plain language — English, Hindi or Hinglish all work.',
  ].join('\n');
}

export const HELP_TEXT = [
  '*What I can do*',
  '',
  '*1. Case law research*',
  'Ask in plain language:',
  '_"bail precedents in NDPS cases with intermediate quantity"_',
  '',
  '*2. Section lookup*',
  '_"what is section 302 IPC"_ or _"498A ka punishment"_',
  'I also map IPC↔BNS and CrPC↔BNSS sections.',
  '',
  '*3. Case status*',
  'Send a 16-digit CNR number, e.g. `DLCT010001232024`',
  '',
  '*Voice notes* work too — record your question instead of typing.',
  '',
  'Type *menu* at any time to see all options.',
].join('\n');

export const ASK_FOR_CNR = [
  'Send the *16-character CNR number* of the case.',
  '',
  'It looks like: `DLCT010001232024`',
  '_(4 letters for state and district, 2 for the court establishment, 6 for the case number, 4 for the year)_',
  '',
  'You will find it on any order sheet or on the eCourts portal.',
].join('\n');

export const ASK_FOR_QUERY = [
  'What would you like me to research?',
  '',
  'Describe the legal question in your own words — the more specific, the better the precedents.',
  '',
  '_Example: "Is anticipatory bail maintainable after a chargesheet is filed?"_',
].join('\n');

export const ASK_FOR_SECTION = [
  'Which section would you like explained?',
  '',
  'Examples: _"section 302 IPC"_, _"BNS 103"_, _"CrPC 438"_',
].join('\n');

export const ASK_FOR_BAR_COUNCIL_ID = [
  '*Verify your licence*',
  '',
  'Verification confirms your licence on the account.',
  '',
  'Send your *bar council enrolment number*, for example: `D/1234/2015` or `MAH/12345/2010`',
  '',
  'It is encrypted before storage and is never shared.',
].join('\n');

export const BAR_ID_INVALID = [
  'That does not look like a bar council enrolment number.',
  '',
  'The format is usually a state code, your enrolment serial and the year — for example `D/1234/2015`.',
  '',
  'Send it again, or type *menu* to go back.',
].join('\n');

export const BAR_ID_DUPLICATE = [
  'That enrolment number is already registered to another account.',
  '',
  'If you believe this is an error, reply here and an administrator will review it.',
].join('\n');

export const BAR_ID_ACCEPTED = [
  '*Received.* Your details are queued for verification.',
  '',
  'You can now optionally send a *photo of your bar council ID card* to speed this up.',
  '',
  'You will get a message here once your account is verified.',
].join('\n');

export const ID_CARD_RECEIVED = 'ID card received. Your verification is now with our team.';

export const CNR_NOT_FOUND = [
  'I could not find a case with that CNR number.',
  '',
  'Please check:',
  '· It is exactly 16 characters',
  '· The year at the end is correct',
  '',
  'Send it again, or type *menu* to go back.',
].join('\n');

export const ECOURTS_UNAVAILABLE = [
  'The court records service is not responding at the moment.',
  '',
  'This is usually temporary. Try again in a few minutes.',
].join('\n');

/**
 * Out of credits.
 *
 * It used to say when they came back, because on a monthly cycle "the 1st" is
 * not obvious to somebody who ran out on the 3rd. Since migration 0014 the free
 * allowance is granted once for the life of the account and never refills, so
 * there is no date to give - and inventing one would be the more expensive
 * mistake, since an advocate who believes credits return next month simply
 * waits instead of buying more.
 */
export function quotaExceeded(
  remaining: number,
  cost: number,
  monthlyAllowance: number,
): string {
  const shortfall =
    remaining > 0
      ? `That costs *${cost} credit${cost === 1 ? '' : 's'}* and you have *${remaining}* left.`
      : `You have used all *${monthlyAllowance} free credits* on this account.`;

  return [
    shortfall,
    '',
    'Top up to keep searching. Type *verify* to confirm your licence on the account — it takes under a minute.',
  ].join('\n');
}

export function usageSummary(
  creditLine: string,
  searchesToday: number,
  verified: boolean,
): string {
  const status = verified ? '*Verified advocate*' : 'Unverified (guest)';

  return [
    '*Your account*',
    '',
    `Status: ${status}`,
    creditLine,
    `Searches today: ${searchesToday}`,
    // Neither "the daily limit" nor "unlimited searches": there is no reset
    // (migration 0014) and no unmetered tier - usage is credits, for everyone.
    // Both promises sent advocates looking for something that is not there.
    verified ? '' : '\nType *verify* to confirm your licence on this account.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const UNSUPPORTED_MESSAGE_TYPE = [
  'I can read text messages, voice notes and images.',
  '',
  'Please type your question, or record it as a voice note.',
].join('\n');

export const TRANSCRIPTION_UNAVAILABLE = [
  'I could not process that voice note.',
  '',
  'Please type your question instead.',
].join('\n');

export const PROCESSING_ERROR = [
  'Something went wrong while processing that.',
  '',
  'Please try again. If it keeps happening, type *menu* to start over.',
].join('\n');

/**
 * The two halves of opting out.
 *
 * The words offered as the way back are listed literally in the goodbye, and
 * `RESUME_WORDS` is what the handler matches, so the promise and the check
 * cannot drift apart. They used to: the goodbye said "send *start* to resume"
 * and nothing anywhere handled the word.
 */
export const RESUME_WORDS = ['start', 'resume', 'unstop'] as const;

export const UNSUBSCRIBED = [
  'You will not receive further messages from Vakeel Saathi.',
  '',
  'Our conversation history has been cleared. Send *start* whenever you want to use the service again.',
].join('\n');

export const RESUBSCRIBED = [
  '*Welcome back.*',
  '',
  'You will receive messages here again. Send your question, or type *menu* to see what I can do.',
].join('\n');

export const MOCK_MODE_NOTICE =
  '\n\n_⚠️ No AI provider is configured, so this is a placeholder answer._';

/** Render an eCourts result as a WhatsApp message. */
/**
 * The case status card.
 *
 * Every field is always printed, "Not available" where the court record has
 * nothing. A card whose shape changes with the data is hard to read down a
 * phone screen, and a missing row reads as an omission by the bot rather than
 * a gap in the record.
 *
 * ## The disposed-case rule
 *
 * A disposed case whose "next hearing" is in the past is showing a date that
 * already happened for a matter that is over. Left in, an advocate scanning
 * quickly reads it as an upcoming listing. It is blanked rather than removed,
 * so the row still exists and the absence is visible.
 */
export function formatCaseStatus(status: CaseStatus): string {
  const value = (v: string | null): string => (v && v.trim() ? v.trim() : 'Not available');

  const nextHearing =
    status.status === 'DISPOSED' && isPast(status.nextHearingDate)
      ? 'Not available'
      : value(status.nextHearingDate);

  return [
    `*Case status — ${status.cnr}*`,
    '',
    `• Case Type: ${value(status.caseType)}`,
    // Two different numbers. This printed `caseNumber` on both lines, which
    // asserted they were the same - on the first real record they were
    // "9623/2024" and "138/2024".
    `• Filing Number: ${value(status.filingNumber)}`,
    `• Filing Date: ${value(status.filingDate)}`,
    `• Registration Number: ${value(status.caseNumber)}`,
    `• Registration Date: ${value(status.registrationDate)}`,
    `• CNR Number: ${status.cnr}`,
    // Was printing lastHearingDate under a "First Hearing" label. The two are
    // the same day only on a case that has been heard once.
    `• First Hearing Date: ${value(status.firstHearingDate)}`,
    `• Last Hearing Date: ${value(status.lastHearingDate)}`,
    `• Next Hearing Date: ${nextHearing}`,
    `• Case Status: ${value(status.status)}`,
    `• Stage of Case: ${value(status.stage)}`,
    // The court was mapped and then never printed - so a card told an advocate
    // everything about a matter except which court it is in.
    `• Court: ${value(status.court)}`,
    `• Judge: ${value(status.judge)}`,
    `• Petitioner and Advocate: ${pair(status.petitioner, status.petitionerAdvocate)}`,
    `• Respondent and Advocate: ${pair(status.respondent, status.respondentAdvocate)}`,
    '',
    status.mocked
      ? '_⚠️ Sample data — no eCourts provider is configured, so this is not a real case record._\n'
      : '',
    CAVEAT,
    '',
    RETURN_TO_MENU,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** "Party (Advocate)", degrading to whichever half the record actually has. */
function pair(party: string | null, advocate: string | null): string {
  if (!party && !advocate) return 'Not available';
  if (!advocate) return party as string;
  if (!party) return `Not available (${advocate})`;
  return `${party} (${advocate})`;
}

function isPast(date: string | null): boolean {
  if (!date) return false;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < Date.now();
}

/** Compact statute card, used when the LLM is unavailable. */
export function formatStatute(statute: StatuteRow): string {
  const flags = [
    statute.is_cognizable === null ? null : statute.is_cognizable ? 'Cognizable' : 'Non-cognizable',
    statute.is_bailable === null ? null : statute.is_bailable ? 'Bailable' : 'Non-bailable',
    statute.is_compoundable === null ? null : statute.is_compoundable ? 'Compoundable' : 'Non-compoundable',
  ].filter(Boolean);

  return [
    `*${statute.act_code} Section ${statute.section_number}*`,
    `_${statute.section_title}_`,
    '',
    statute.section_text,
    '',
    statute.punishment ? `*Punishment:* ${statute.punishment}` : null,
    flags.length > 0 ? `*Classification:* ${flags.join(' · ')}` : null,
    statute.triable_by ? `*Triable by:* ${statute.triable_by}` : null,
    statute.corresponding_section
      ? `*Now:* ${statute.corresponding_act} Section ${statute.corresponding_section}`
      : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}
