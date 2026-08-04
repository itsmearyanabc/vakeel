import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { QueryIntent } from '../database/types';
import { ActCode, extractCnr, extractSectionReference, normaliseActCode } from './legal-patterns';
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

    return classified;
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
