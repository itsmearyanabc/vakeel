import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { QueryIntent } from '../database/types';
import { isAcknowledgement, isMenuWord } from './conversational';
import {
  ActCode,
  extractCnr,
  extractOrderReference,
  extractSectionReference,
  normaliseActCode,
} from './legal-patterns';
import { INTENT_CLASSIFIER_SYSTEM } from './prompts';
import { parseJsonLoose } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';

export interface ClassifiedIntent {
  intent: QueryIntent;
  language: string;
  cnrNumber: string | null;
  sectionNumber: string | null;
  actCode: ActCode | null;
  /** Query rewritten in English legal terminology, for retrieval. */
  searchQuery: string;
  confidence: number;
}

const VALID_INTENTS: readonly QueryIntent[] = [
  'CASE_STATUS',
  'SECTION_LOOKUP',
  'PRECEDENT_SEARCH',
  'DRAFTING_HELP',
  'GENERAL_LEGAL',
  'SMALL_TALK',
  'MENU_NAVIGATION',
  'UNSUPPORTED',
];

/**
 * Stage one of the pipeline: work out what the user wants and in what language.
 *
 * Everything downstream branches on this, so it runs on the cheap router model
 * and is defended on both sides - deterministic extraction first, the model
 * second, and rule-based fallback if the model output is unusable.
 */
@Injectable()
export class IntentService {
  private readonly logger = getLogger().child({ module: 'intent' });

  constructor(private readonly registry: ProviderRegistry) {}

  async classify(text: string): Promise<ClassifiedIntent> {
    // Deterministic extraction first. A CNR or section number found by regex is
    // more reliable than one transcribed by a model, and it gives us a correct
    // answer even if the LLM call fails entirely.
    const regexCnr = extractCnr(text);
    const { section: regexSection, act: regexAct } = extractSectionReference(text);
    const regexOrder = extractOrderReference(text);

    // Some messages do not need a model to understand. Answering them still
    // cost a full router round trip - roughly a second of the advocate's time,
    // and a billed call - before the switch downstream threw the classification
    // away and sent a fixed menu. See fastPath() for what qualifies.
    const fast = this.fastPath(text, regexCnr, regexOrder, regexAct);
    if (fast) {
      this.logger.debug({ intent: fast.intent }, 'Intent resolved without the router model');
      return fast;
    }

    let classified: ClassifiedIntent;

    try {
      const result = await this.registry.complete({
        task: 'router',
        system: INTENT_CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: text }],
        json: true,
        maxTokens: 512,
      });

      const parsed = parseJsonLoose<Record<string, unknown>>(result.text);
      classified = parsed ? this.fromModel(parsed, text) : this.heuristic(text, regexCnr, regexSection, regexAct);
    } catch (err) {
      this.logger.warn({ err }, 'Intent classification failed; using heuristic fallback');
      classified = this.heuristic(text, regexCnr, regexSection, regexAct);
    }

    // Regex wins where it found something concrete - the model occasionally
    // drops a digit when copying a 16-character CNR.
    if (regexCnr) {
      classified.cnrNumber = regexCnr;
      if (classified.intent === 'GENERAL_LEGAL') classified.intent = 'CASE_STATUS';
    }
    if (regexSection && !classified.sectionNumber) classified.sectionNumber = regexSection;
    if (regexAct && !classified.actCode) classified.actCode = regexAct;

    /*
     * An Order of the CPC is a provision, not a research topic.
     *
     * "order 32 CPC" was classified PRECEDENT_SEARCH and answered with ten
     * unrelated Patna judgments. The model has no reliable sense of this - it
     * sees the word "order" and thinks of judgments - but the regex is certain,
     * so the regex decides. Same principle as the CNR override above.
     *
     * DRAFTING_HELP is left alone: "draft an application under Order 39" is a
     * drafting request that happens to name a provision.
     */
    if (
      regexOrder &&
      (classified.intent === 'PRECEDENT_SEARCH' || classified.intent === 'GENERAL_LEGAL')
    ) {
      classified.intent = 'SECTION_LOOKUP';
    }
    if (regexOrder && !classified.sectionNumber) classified.sectionNumber = regexOrder;

    return classified;
  }

  /**
   * Messages a model cannot classify better than a regex can.
   *
   * This is deliberately narrow, and it is *not* the heuristic fallback below.
   * The fallback is a best effort at every intent when the model is unavailable;
   * this is a short list of cases where the answer is not in doubt, so paying a
   * router call for it buys nothing:
   *
   *   - **menu / help** goes straight to `sendMainMenu`. The classification was
   *     discarded either way, so the call was pure latency.
   *   - **a bare greeting** is small talk by construction. "hi" cannot be a
   *     section lookup. Anchored and length-capped so "thanks, now what does
   *     section 420 cover" still reaches the model.
   *   - **a message that is only a CNR** is a case-status lookup, and the regex
   *     already extracted it more reliably than the model would have.
   *
   * Everything else - and in particular section-lookup vs precedent-search, which
   * turns on phrasing rather than pattern - still goes to the model. Guessing
   * there would trade a second of latency for a wrong answer.
   *
   * Language detection degrades to a script check on this path. That is
   * acceptable because none of these branches generate prose from the query: the
   * menu is templated, and small talk passes the raw text to the LLM anyway.
   */
  private fastPath(
    text: string,
    cnr: string | null,
    order: string | null = null,
    act: ActCode | null = null,
  ): ClassifiedIntent | null {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const language = /[ऀ-ॿ]/.test(trimmed) ? 'hi' : 'en';

    const base = { language, cnrNumber: cnr, sectionNumber: null, actCode: null, searchQuery: trimmed };

    if (isMenuWord(lower)) {
      return { ...base, intent: 'MENU_NAVIGATION', confidence: 0.99 };
    }

    /*
     * Acknowledgements, not questions.
     *
     * The list moved to ai/conversational.ts, because the session router needs
     * the same judgement one step earlier - it takes the credit *before* this
     * method ever runs, so a list that lived only here could stop a wasted
     * model call but never a wasted charge.
     */
    if (isAcknowledgement(trimmed)) {
      return { ...base, intent: 'SMALL_TALK', confidence: 0.99 };
    }

    // Only when the CNR is the entire message. "status of ABCD01..." may carry a
    // question the model should see.
    if (cnr && trimmed.replace(/[\s-]/g, '').length === cnr.length) {
      return { ...base, intent: 'CASE_STATUS', confidence: 0.99 };
    }

    /*
     * A bare Order reference - "order 32 CPC", "O.37 R.3".
     *
     * Short and unambiguous, so it does not need the router model, and the
     * router model gets it wrong: it reads "order" as "judgment" and sends a
     * procedural question to case-law search. Length-capped so "what did the
     * court hold about Order 39 injunctions in NDPS matters" still reaches the
     * model, which is genuinely a research question.
     */
    if (order && trimmed.length <= 32) {
      return {
        ...base,
        intent: 'SECTION_LOOKUP',
        sectionNumber: order,
        actCode: act ?? 'CPC',
        confidence: 0.97,
      };
    }

    return null;
  }

  private fromModel(parsed: Record<string, unknown>, original: string): ClassifiedIntent {
    const rawIntent = String(parsed.intent ?? '').toUpperCase() as QueryIntent;

    return {
      intent: VALID_INTENTS.includes(rawIntent) ? rawIntent : 'GENERAL_LEGAL',
      language: this.normaliseLanguage(parsed.language),
      cnrNumber: parsed.cnr_number ? String(parsed.cnr_number).toUpperCase() : null,
      sectionNumber: parsed.section_number ? String(parsed.section_number).toUpperCase() : null,
      actCode: normaliseActCode(parsed.act_code ? String(parsed.act_code) : null),
      searchQuery: parsed.search_query ? String(parsed.search_query) : original,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
    };
  }

  private normaliseLanguage(value: unknown): string {
    const code = String(value ?? 'en')
      .toLowerCase()
      .slice(0, 2);
    return /^[a-z]{2}$/.test(code) ? code : 'en';
  }

  /**
   * Rule-based fallback.
   *
   * Not a great classifier, but it keeps the bot answering when the router
   * model is unavailable, which beats replying "sorry, try again" to someone
   * standing outside a courtroom.
   */
  private heuristic(
    text: string,
    cnr: string | null,
    section: string | null,
    act: ActCode | null,
  ): ClassifiedIntent {
    const lower = text.toLowerCase().trim();

    // Devanagari covers Hindi and Marathi; a script check is the best we can do
    // without the model, and getting the script right matters more than the
    // exact language for reply formatting.
    const language = /[ऀ-ॿ]/.test(text) ? 'hi' : 'en';

    let intent: QueryIntent = 'GENERAL_LEGAL';
    if (cnr) intent = 'CASE_STATUS';
    else if (section || act) intent = 'SECTION_LOOKUP';
    else if (/\b(menu|help|start|options|मदद|मेन्यू)\b/.test(lower)) intent = 'MENU_NAVIGATION';
    else if (/^(hi|hello|hey|namaste|hola|thanks|thank you|ok|okay|नमस्ते|धन्यवाद)\b/.test(lower))
      intent = 'SMALL_TALK';
    else if (/\b(precedent|judgment|judgement|case law|ruling|held|citation|authority)\b/.test(lower))
      intent = 'PRECEDENT_SEARCH';
    else if (/\b(draft|notice|petition|affidavit|application|reply)\b/.test(lower)) intent = 'DRAFTING_HELP';

    return {
      intent,
      language,
      cnrNumber: cnr,
      sectionNumber: section,
      actCode: act,
      searchQuery: text,
      confidence: 0.3,
    };
  }
}
