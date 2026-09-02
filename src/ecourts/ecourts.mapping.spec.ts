import { CaseStatus, EcourtsService } from './ecourts.service';
import { formatCaseStatus } from '../whatsapp/replies';
import realResponse from './__fixtures__/ecourtsindia-case.json';

/**
 * The eCourtsIndia mapping, against a response the live API actually returned.
 *
 * ## Why a captured fixture and not a hand-written one
 *
 * The mapping was written from the provider's prose documentation first, and
 * every one of the three things it got wrong was invisible to a fixture built
 * from the same reading. The case is two levels down, the parties are arrays,
 * and the hearing dates are on a sibling object - none of which the docs say,
 * and all of which produce a card that renders cleanly with the fields an
 * advocate opens it for missing.
 *
 * So the fixture is a trimmed copy of a real `GET /api/partner/case/{cnr}`
 * response (a disposed Delhi High Court writ petition). Trimmed of the order
 * PDFs and AI analysis only; every field the mapper reads is verbatim.
 *
 * The one thing this cannot cover is a *pending* case, because the CNR to hand
 * is disposed - so `nextDateOfHearing` is exercised as null here and asserted
 * separately below against a synthetic pending variant.
 */

/**
 * The mapper is private, and reached here rather than through lookup().
 *
 * Going through the public path would mean a fetch, a circuit breaker and a
 * cache to stand up, none of which is what these assert. What is under test is
 * the translation from one provider's JSON to CaseStatus, so that is what is
 * called.
 */
function mapWith(payload: unknown): CaseStatus {
  const service = new EcourtsService({} as never, {} as never);
  return (
    service as unknown as {
      mapProviderResponse(cnr: string, body: Record<string, unknown>): CaseStatus;
    }
  ).mapProviderResponse('DLHC010001232024', payload as Record<string, unknown>);
}

describe('a real eCourtsIndia response', () => {
  const status = mapWith(realResponse);

  it('finds the parties, which arrive as arrays', () => {
    // The bug that would have shipped: pick() accepted strings only, so every
    // one of these was null and the card showed nothing but dates.
    expect(status.petitioner).toBe('Shubham Pratap Singh');
    expect(status.respondent).toBe('Kendriya Vidyalaya Sangathan (kvs) & ORS');
    expect(status.petitionerAdvocate).toBe('KARAN BABUTA');
  });

  it('joins a multi-judge bench rather than dropping it', () => {
    expect(status.judge).toBe('TUSHAR RAO GEDELA');
  });

  it('reads the court name through the response own lookup table', () => {
    // `courtName` is the string "DLHC". Printing that is not wrong so much as
    // unreadable to the person the card is for.
    expect(status.court).toBe('High Court of Delhi, Delhi');
  });

  it('quotes the case the way an advocate would', () => {
    // Not the internal 15-digit caseNumber, which appears on no document.
    expect(status.caseNumber).toBe('Writ Petition (Civil) 138/2024');
    expect(status.caseType).toBe('Writ Petition (Civil)');
  });

  it('takes the hearing dates from entityInfo, not from the case object', () => {
    expect(status.lastHearingDate).toBe('2024-01-05');
    expect(status.nextHearingDate).toBeNull();
  });

  it('trusts the provider status instead of inferring it from a date', () => {
    // Inferring "pending" from the presence of a next hearing is wrong in both
    // directions: a disposed case can carry a stale listing, and a pending case
    // between hearings has no next date at all. This one says DISPOSED.
    expect(status.status).toBe('DISPOSED');
  });

  it('carries the filing and registration dates as plain days', () => {
    expect(status.filingDate).toBe('2024-01-04');
    expect(status.registrationDate).toBe('2024-01-04');
  });

  it('is never marked as mock data', () => {
    // `mocked` drives a "this is synthetic" label. A real record wearing it, or
    // a synthetic one without it, are both worse than no label.
    expect(status.mocked).toBe(false);
  });

  it('renders a card with no "Not available" in the fields that matter', () => {
    const card = formatCaseStatus(status);

    expect(card).toContain('Shubham Pratap Singh');
    expect(card).toContain('High Court of Delhi, Delhi');
    expect(card).toContain('TUSHAR RAO GEDELA');
  });
});

describe('a pending case', () => {
  // Same envelope, with the fields a listed matter carries.
  const pending = JSON.parse(JSON.stringify(realResponse)) as {
    data: { courtCaseData: Record<string, unknown>; entityInfo: Record<string, unknown> };
  };
  pending.data.courtCaseData.caseStatus = 'PENDING';
  pending.data.courtCaseData.purpose = 'FINAL ARGUMENTS';
  pending.data.entityInfo.nextDateOfHearing = '2026-10-14T00:00:00Z';

  const status = mapWith(pending);

  it('reports the next hearing as a plain day, not an ISO timestamp', () => {
    expect(status.nextHearingDate).toBe('2026-10-14');
  });

  it('is pending, and lists what it is listed for', () => {
    expect(status.status).toBe('PENDING');
    expect(status.stage).toBe('FINAL ARGUMENTS');
  });
});

describe('a response this mapper cannot read', () => {
  it('throws rather than returning a card of "Not available"', () => {
    // The whole point of the guard: a 200 that maps to nothing is a bug here,
    // not an empty court record. Throwing routes it through the refund path and
    // logs the keys the provider actually sent.
    expect(() => mapWith({ data: { somethingElse: { foo: 'bar' } } })).toThrow(
      /could not be mapped/i,
    );
  });

  it('still reads a flat payload from a different provider', () => {
    // This stays an adapter. A gateway that returns the case at the top level,
    // in snake_case, must not need a code change.
    const flat = mapWith({
      case_number: 'CC/1234/2024',
      petitioner: 'State of Bihar',
      respondent: 'Ram Kumar',
      case_stage: 'Framing of Charge',
      next_hearing_date: '2026-11-02',
    });

    expect(flat.petitioner).toBe('State of Bihar');
    expect(flat.stage).toBe('Framing of Charge');
    expect(flat.status).toBe('PENDING');
  });
});
