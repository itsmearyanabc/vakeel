/**
 * The things people type that are not questions.
 *
 * ## Why this is shared rather than local to either caller
 *
 * Two places need the same judgement, for two different reasons, and they used
 * to make it separately - which meant only one of them was ever right.
 *
 * `IntentService.fastPath` uses it to answer "thanks" without spending a router
 * call. The session router uses it to decide that "thanks" is not a research
 * question and must not be *billed* as one: an advocate who taps *2. Law
 * sections*, reads the answer and replies "thanks" is still in SECTION_INFO,
 * and every state below the menu turns whatever arrives into a paid lookup. The
 * classifier's list would have caught it; the classifier never saw it, because
 * the charge is taken before classification.
 *
 * One list, one meaning. A word added here stops being billed and stops costing
 * a model call in the same commit.
 */

/**
 * Trimmed, lowercased, and stripped of the punctuation people trail messages
 * with. "Thanks!!" and "ok." are the same word as "thanks" and "ok".
 */
function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s!.?,;:]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A greeting, an acknowledgement or a sign-off - anything whose only content is
 * social.
 *
 * Matched whole, never as a prefix. "Thanks, now what about anticipatory bail"
 * is a question with manners on the front and is charged like any other.
 *
 * A message reduced to nothing by normalisation - "." or "?" alone - counts.
 * Somebody sent a keystroke, and charging two credits for retrieval over a full
 * stop is indefensible.
 */
export function isAcknowledgement(text: string): boolean {
  const t = normalise(text);
  if (!t) return true;
  // Above this, it is a sentence. The cap is what stops a real question that
  // happens to open with "ok" from being read as a sign-off.
  if (t.length > 20) return false;

  return ACKNOWLEDGEMENTS.has(t);
}

/** Asking for the menu, in the words people actually use for it. */
export function isMenuWord(text: string): boolean {
  return MENU_WORDS.has(normalise(text));
}

const ACKNOWLEDGEMENTS = new Set([
  // Greetings. "hi" is here and deliberately *not* in the language matcher -
  // see matchLanguage, where it used to select Hindi by its ISO code.
  'hi',
  'hii',
  'hello',
  'helo',
  'hey',
  'namaste',
  'नमस्ते',
  'namaskar',
  'jai hind',
  'hola',
  'good morning',
  'good afternoon',
  'good evening',
  // Acknowledgements.
  'ok',
  'okay',
  'k',
  'kk',
  'hmm',
  'right',
  'fine',
  'sure',
  'done',
  'got it',
  'noted',
  'understood',
  'theek hai',
  'thik hai',
  'ठीक है',
  // Thanks.
  'thanks',
  'thank you',
  'thanks a lot',
  'thankyou',
  'thx',
  'ty',
  'tq',
  'dhanyawad',
  'dhanyavaad',
  'धन्यवाद',
  'shukriya',
  'शुक्रिया',
  // Yes and no, in the three scripts this bot is spoken to in.
  'yes',
  'yep',
  'yeah',
  'ya',
  'no',
  'nope',
  'haan',
  'han',
  'nahi',
  'nahin',
  'हाँ',
  'हां',
  'नहीं',
  // Sign-offs. Every one of these was a two-credit search.
  "that's it",
  'thats it',
  'that is it',
  'nothing',
  'nothing else',
  'no thanks',
  'no thank you',
  'bye',
  'goodbye',
  'ok bye',
  'tata',
  'see you',
  // Approval. Said to a good answer, charged for like a new question.
  'great',
  'nice',
  'good',
  'perfect',
  'cool',
  'super',
  'awesome',
  'excellent',
  'wow',
  'well done',
]);

const MENU_WORDS = new Set(['menu', 'help', 'start', 'options', 'मदद', 'मेन्यू', 'main menu']);
