import { CaseStatus } from '../ecourts/ecourts.service';
import { StatuteRow } from '../database/types';

/**
 * Static reply copy and menu definitions.
 *
 * Kept out of the conversation service so the wording can be reviewed and
 * edited without reading control flow. Free-form answers are generated and
 * translated by the LLM; only these fixed strings live here.
 */

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

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'mr', label: 'मराठी (Marathi)' },
  { code: 'gu', label: 'ગુજરાતી (Gujarati)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'te', label: 'తెలుగు (Telugu)' },
  { code: 'bn', label: 'বাংলা (Bengali)' },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)' },
];

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
  'Verified advocates get unlimited daily queries.',
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

export function quotaExceeded(limit: number): string {
  return [
    `You have used all *${limit} free queries* for today.`,
    '',
    'Verified advocates get unlimited queries. Type *verify* to submit your bar council enrolment number — it takes under a minute.',
    '',
    'Otherwise your quota resets tomorrow.',
  ].join('\n');
}

export function usageSummary(used: number, limit: number, verified: boolean): string {
  const status = verified ? '*Verified advocate*' : 'Unverified (guest)';
  const quota = limit < 0 ? 'Unlimited' : `${used} of ${limit} used today`;

  return [
    '*Your account*',
    '',
    `Status: ${status}`,
    `Queries: ${quota}`,
    verified ? '' : '\nType *verify* to remove the daily limit.',
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

export const MOCK_MODE_NOTICE =
  '\n\n_⚠️ No AI provider is configured, so this is a placeholder answer._';

/** Render an eCourts result as a WhatsApp message. */
export function formatCaseStatus(status: CaseStatus): string {
  const line = (label: string, value: string | null): string | null =>
    value ? `*${label}:* ${value}` : null;

  return [
    `*Case status — ${status.cnr}*`,
    '',
    line('Case', status.caseNumber),
    line('Type', status.caseType),
    line('Court', status.court),
    line('Judge', status.judge),
    '',
    line('Petitioner', status.petitioner),
    line('Respondent', status.respondent),
    '',
    line('Stage', status.stage),
    line('Last hearing', status.lastHearingDate),
    line('Next hearing', status.nextHearingDate),
    status.mocked
      ? '\n_⚠️ Sample data — no eCourts provider is configured, so this is not a real case record._'
      : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
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
