import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { RetrievedChunk } from '../database/types';
import { extractCitations, extractStatuteRefs } from './legal-patterns';

export interface GuardrailReport {
  /** The answer after removing anything that could not be verified. */
  text: string;
  /** Citations that survived verification. */
  verifiedCitations: string[];
  /** Fabricated references that were stripped. */
  removed: string[];
  /** Real, but not among the passages retrieved for this query. */
  flagged: string[];
  /** True if anything was removed or flagged - drives the auditor queue. */
  triggered: boolean;
  reason: string | null;
}

/**
 * Post-generation citation verification (spec section 9.2).
 *
 * This is the load-bearing safety control of the product. Prompt instructions
 * reduce how often a model invents a citation; they do not prevent it. A
 * fabricated "AIR 2019 SC 1234" that reads perfectly and does not exist is the
 * single worst thing this system could produce, because an advocate may repeat
 * it in court.
 *
 * So every case citation and every section number in the generated answer is
 * checked against the database before the message is sent, and there are two
 * distinct outcomes:
 *
 *   REMOVED - not in the corpus at all. Almost certainly fabricated. The text
 *             is struck from the answer and replaced with a visible marker, so
 *             the advocate sees that something was withheld rather than reading
 *             a subtly altered answer.
 *
 *   FLAGGED - real and present in the corpus, but not among the passages
 *             retrieved for this query. Probably drawn from model memory rather
 *             than the provided context. Kept (it is a genuine case) but
 *             recorded for auditor review.
 *
 * Erring towards removal is deliberate: a missing citation is an inconvenience,
 * a fabricated one is a professional liability.
 */
@Injectable()
export class GuardrailsService {
  private readonly logger = getLogger().child({ module: 'guardrails' });

  constructor(private readonly corpus: CorpusRepository) {}

  async verify(answer: string, retrieved: RetrievedChunk[]): Promise<GuardrailReport> {
    if (!answer.trim()) {
      return { text: answer, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null };
    }

    const citations = extractCitations(answer);
    const statuteRefs = extractStatuteRefs(answer);

    if (citations.length === 0 && statuteRefs.length === 0) {
      return { text: answer, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null };
    }

    // Everything the model was actually shown, normalised for comparison.
    const grounded = new Set<string>();
    for (const chunk of retrieved) {
      if (chunk.neutral_citation) grounded.add(this.normalise(chunk.neutral_citation));
      for (const reporter of chunk.reporter_citations ?? []) grounded.add(this.normalise(reporter));
    }

    const [citationChecks, statuteChecks] = await Promise.all([
      this.corpus.verifyCitations(citations),
      this.corpus.verifyStatuteRefs(statuteRefs),
    ]);

    const removed: string[] = [];
    const flagged: string[] = [];
    const verified: string[] = [];

    for (const check of citationChecks) {
      if (!check.found) {
        removed.push(check.citation);
      } else if (!grounded.has(this.normalise(check.citation))) {
        flagged.push(check.citation);
        verified.push(check.citation);
      } else {
        verified.push(check.citation);
      }
    }

    const removedStatuteRefs: string[] = [];
    for (const check of statuteChecks) {
      if (!check.found) {
        removed.push(check.ref);
        removedStatuteRefs.push(check.ref);
      }
    }

    let text = answer;
    for (const item of removed) {
      text = removedStatuteRefs.includes(item) ? this.strikeStatuteRef(text, item) : this.strike(text, item);
    }

    if (removed.length > 0) {
      // Without this the advocate cannot tell the answer was altered, and an
      // answer that quietly lost its authority reads as an unsupported
      // assertion.
      text += '\n\n_One or more references could not be verified against the case law database and were removed._';
    }

    const triggered = removed.length > 0 || flagged.length > 0;

    if (triggered) {
      this.logger.warn(
        { removed, flagged, citationCount: citations.length },
        'Guardrail modified a generated answer',
      );
    }

    return {
      text,
      verifiedCitations: verified,
      removed,
      flagged,
      triggered,
      reason: triggered
        ? [
            removed.length > 0 ? `${removed.length} unverifiable reference(s) removed` : null,
            flagged.length > 0 ? `${flagged.length} citation(s) not in retrieved context` : null,
          ]
            .filter(Boolean)
            .join('; ')
        : null,
    };
  }

  /** Strip punctuation and case so "AIR 2018 S.C. 1234" matches "AIR 2018 SC 1234". */
  private normalise(citation: string): string {
    return citation.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  /**
   * Remove one reference from the answer.
   *
   * Also drops a wrapping parenthesis pair, so striking the citation out of
   * "*Case Name* (AIR 2019 SC 1234)" does not leave "*Case Name* ()".
   */
  private strike(text: string, reference: string): string {
    const escaped = this.escapeRegex(reference);
    return text
      .replace(new RegExp(`\\(\\s*${escaped}\\s*\\)`, 'gi'), '[unverified]')
      .replace(new RegExp(escaped, 'gi'), '[unverified]');
  }

  /**
   * Remove a statutory reference.
   *
   * Statute refs are normalised to "ACT SECTION" ("IPC 999") for verification,
   * but the answer text says "section 999 IPC" or "IPC Section 999". Searching
   * for the normalised form finds nothing, so the invented section would stay
   * in the reply while being reported as removed - the worst possible
   * combination. Both word orders are struck instead.
   */
  private strikeStatuteRef(text: string, ref: string): string {
    const [act, section] = ref.split(' ');
    if (!act || !section) return text;

    const a = this.escapeRegex(act);
    const s = this.escapeRegex(section);

    return (
      text
        // "section 999 IPC", "u/s 999 IPC", "999 IPC"
        .replace(
          new RegExp(`\\b(?:u/s|under\\s+sections?|sections?|secs?|s)?\\.?\\s*${s}\\s*(?:of\\s+(?:the\\s+)?)?${a}\\b`, 'gi'),
          '[unverified]',
        )
        // "IPC 999", "IPC Section 999"
        .replace(new RegExp(`\\b${a}\\s*(?:sections?|secs?|s)?\\.?\\s*${s}\\b`, 'gi'), '[unverified]')
    );
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
