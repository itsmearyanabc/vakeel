import { CaseStatus, CnrNotFoundError, EcourtsMisconfiguredError, EcourtsService } from './ecourts.service';
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

  it('keeps the two case numbers apart, as the provider does', () => {
    // The live record carries both, and they differ. A card that prints one
    // into both lines asserts something untrue about the matter.
    expect(status.filingNumber).toBe('9623/2024');
    expect(status.caseNumber).toBe('Writ Petition (Civil) 138/2024');
    expect(status.filingNumber).not.toBe(status.caseNumber);
  });

  it('reads the first hearing date from its own field', () => {
    // Guards the fixture as much as the mapper. The first capture trimmed
    // `firstHearingDate` out, so this line rendered "Not available" and looked
    // like a mapping bug - when the live API returns it and always had.
    expect(status.firstHearingDate).toBe('2024-01-05');
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

/**
 * Telling a wrong address apart from a court that is down.
 *
 * This is not hypothetical. A deployment ran with
 * ECOURTS_BASE_URL=https://ecourtsindia.com - the provider's marketing site,
 * not their API host - and every lookup got 403 text/plain. Advocates were told
 * "the court records service is not responding", the operator went looking at
 * eCourts, and eCourts was working the entire time.
 *
 * The distinguishing signal is what kind of thing answered: a provider returns
 * JSON, a web server that has never heard of the path returns HTML or text.
 */
describe('a base URL pointing at the wrong thing', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function serviceReturning(status: number, contentType: string, body = '') {
    global.fetch = jest.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
      json: async () => JSON.parse(body || '{}'),
    }) as never;

    const settings = {
      get: (key: string) =>
        ({
          ECOURTS_MODE: 'http',
          ECOURTS_BASE_URL: 'https://ecourtsindia.com',
          ECOURTS_API_KEY: 'eci_live_x',
        })[key] ?? '',
    };
    const env = {
      ECOURTS_MODE: 'http',
      ECOURTS_BASE_URL: 'https://ecourtsindia.com',
      ECOURTS_API_KEY: 'eci_live_x',
      ECOURTS_TIMEOUT_MS: 5000,
      ECOURTS_BREAKER_THRESHOLD: 5,
      ECOURTS_BREAKER_RESET_MS: 60_000,
    };
    return new EcourtsService(env as never, settings as never);
  }

  it('names the misconfiguration on the 403 the marketing site actually returned', async () => {
    const service = serviceReturning(403, 'text/plain', 'Forbidden');

    await expect(service.lookup('DLHC010001232024')).rejects.toBeInstanceOf(
      EcourtsMisconfiguredError,
    );
  });

  it('points at the two settings that could be wrong', async () => {
    const service = serviceReturning(403, 'text/plain');

    await expect(service.lookup('DLHC010001232024')).rejects.toThrow(
      /ECOURTS_API_KEY[\s\S]*ECOURTS_BASE_URL/,
    );
  });

  it('does not read an HTML 404 as "no such case"', async () => {
    // The silent version, and the worse one: any web server 404s an unknown
    // path, so a wrong host makes every CNR come back as a case that does not
    // exist - charged, refunded, and nothing in the logs looking like an error.
    const service = serviceReturning(404, 'text/html', '<!doctype html>');

    await expect(service.lookup('DLHC010001232024')).rejects.toBeInstanceOf(
      EcourtsMisconfiguredError,
    );
  });

  it('still reads a provider JSON 404 as "no such case"', async () => {
    const service = serviceReturning(404, 'application/json', '{"code":"CASE_NOT_FOUND"}');

    await expect(service.lookup('DLHC010001232024')).rejects.toBeInstanceOf(CnrNotFoundError);
  });

  it('rejects a 200 that is not JSON', async () => {
    // A marketing page, or a proxy holding response. The friendly status code
    // makes this the easiest one to mistake for working.
    const service = serviceReturning(200, 'text/html', '<!doctype html>');

    await expect(service.lookup('DLHC010001232024')).rejects.toBeInstanceOf(
      EcourtsMisconfiguredError,
    );
  });

  it('reports the fault where an operator can see it', async () => {
    // The circuit deliberately stays closed, so `isDegraded` cannot show this
    // and the panel would otherwise report a service that answers nobody as
    // healthy.
    const service = serviceReturning(403, 'text/plain');

    await service.lookup('DLHC010001232024').catch(() => undefined);

    expect(service.isDegraded).toBe(false);
    expect(service.configurationError).toMatch(/ECOURTS_BASE_URL/);
  });

  it('stops reporting a fault once the configuration is fixed', async () => {
    const service = serviceReturning(403, 'text/plain');
    await service.lookup('DLHC010001232024').catch(() => undefined);
    expect(service.configurationError).not.toBeNull();

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => '',
      json: async () => realResponse,
    }) as never;

    await service.lookup('DLHC010001232025');
    expect(service.configurationError).toBeNull();
  });
});

describe('the three numbers an advocate quotes', () => {
  /*
   * Filing number, registration number and eCourts' own case number. The first
   * two were already on the card; the third was left off deliberately, on the
   * reasoning that a 15-digit string "appears on no document anybody holds".
   * Half true - it is not on an order sheet - but it is exactly what the
   * eCourts portal's case-number search keys on, and advocates asked for it.
   */
  const status = mapWith(realResponse);

  it('carries the CNR case number, not the provider internal one', () => {
    /*
     * This asserted "213400001382024" - the provider's internal fifteen-digit
     * caseNumber - on the belief that no cnrCaseNumber field existed. The
     * documentation shows it does, defined as the CNR after its court code:
     * cnr "DLND020047882015", cnrCourtCode "DLND02", cnrCaseNumber "0047882015".
     *
     * This record omits the field, so it is read off the CNR the same way, and
     * only because the record's own cnrCourtCode confirms where the split falls.
     */
    expect(status.cnrCaseNumber).toBe('0001232024');
    expect(status.cnrCaseNumber).not.toBe('213400001382024');
  });

  it('keeps all three distinct, because on real records they are', () => {
    expect(status.filingNumber).toBe('9623/2024');
    expect(status.caseNumber).toBe('Writ Petition (Civil) 138/2024');
    expect(new Set([status.filingNumber, status.caseNumber, status.cnrCaseNumber]).size).toBe(3);
  });

  it('never prints the filing number under Registration when registration is missing', () => {
    // The registration fallback used to reach for filingNumber, then for the
    // 15-digit caseNumber - so a record without a registration number showed a
    // different number wearing that label. Absent is "Not available".
    const copy = JSON.parse(JSON.stringify(realResponse));
    delete copy.data.courtCaseData.registrationNumber;
    const mapped = mapWith(copy);

    expect(mapped.caseNumber).toBeFalsy();
    expect(mapped.filingNumber).toBe('9623/2024');
    expect(formatCaseStatus(mapped)).toContain('• Registration Number: Not available');
  });

  it('takes a field literally named cnrCaseNumber if the provider sends one', () => {
    // The mapping reads the documented name first, so if the docs mean a field
    // other than caseNumber, sending it is enough - no code change.
    const copy = JSON.parse(JSON.stringify(realResponse));
    copy.data.courtCaseData.cnrCaseNumber = '999900000012024';

    expect(mapWith(copy).cnrCaseNumber).toBe('999900000012024');
  });

  it('prints all three on the WhatsApp card', () => {
    const card = formatCaseStatus(status);

    expect(card).toContain('• Filing Number: 9623/2024');
    expect(card).toContain('• Registration Number: Writ Petition (Civil) 138/2024');
    expect(card).toContain('• CNR Case Number: 0001232024');
  });
});

describe('the documented example response', () => {
  /*
   * The eCourtsIndia documentation's own example for Case Detail. Not a live
   * capture - but the only record we hold that carries cnrCaseNumber,
   * disposalTypeRaw and firDetails, which the live High Court capture omits.
   * Each assertion here is a field the card used to drop or mislabel.
   */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const documented = require('./__fixtures__/ecourtsindia-docs-example.json');
  const status = (() => {
    const service = new EcourtsService({} as never, {} as never);
    return (
      service as unknown as {
        mapProviderResponse(cnr: string, body: Record<string, unknown>): CaseStatus;
      }
    ).mapProviderResponse('DLND020047882015', documented);
  })();

  it('reads cnrCaseNumber from the field when the record has it', () => {
    expect(status.cnrCaseNumber).toBe('0047882015');
  });

  it('never shows the internal fifteen-digit caseNumber under that label', () => {
    expect(status.cnrCaseNumber).not.toBe('202400248072016');
  });

  it('carries the decision date and how the case was disposed of', () => {
    expect(status.decisionDate).toBe('2018-07-07');
    expect(status.disposalNature).toBe('DISMISSED AS WITHDRAWN');
  });

  it('carries the FIR for a criminal matter', () => {
    expect(status.fir).toBe('FIR 273/2018, Central Crime Branch-CCB I');
  });

  it('carries when the provider last refreshed the record', () => {
    // A scrape of the court's own site. A hearing date from a record refreshed
    // months ago is a stale date, and the card has to be able to say so.
    expect(status.recordUpdated).toBe('2026-05-01');
  });

  it('prints the provider status label rather than the internal flag', () => {
    expect(status.statusLabel).toBe('Disposed');
  });

  it('prints all of it on the WhatsApp card', () => {
    const card = formatCaseStatus(status);

    expect(card).toContain('• Case Status: Disposed');
    expect(card).toContain('• Disposal Date: 2018-07-07');
    expect(card).toContain('• Nature of Disposal: DISMISSED AS WITHDRAWN');
    expect(card).toContain('• FIR: FIR 273/2018, Central Crime Branch-CCB I');
    expect(card).toContain('Record last updated from eCourts: 2026-05-01');
  });
});

describe('a dismissed case', () => {
  /*
   * DISMISSED is in the documented caseStatus enum and matched none of the
   * patterns, so a dismissed case fell through to UNKNOWN - and was printed
   * that way, with a stale next hearing date still showing.
   */
  const dismissed = mapWith({
    data: {
      courtCaseData: { cnr: 'DLHC010001232024', caseStatus: 'DISMISSED', petitioners: ['A'] },
      descriptions: { enumLookup: { caseStatus: { DISMISSED: 'Dismissed' } } },
    },
  });

  it('is treated as decided', () => {
    expect(dismissed.status).toBe('DISPOSED');
  });

  it('says Dismissed, in the provider words', () => {
    expect(dismissed.statusLabel).toBe('Dismissed');
    expect(formatCaseStatus(dismissed)).toContain('• Case Status: Dismissed');
  });
});

describe('a pending case', () => {
  it('does not print disposal lines that cannot apply to it', () => {
    // "Disposal Date: Not available" on a pending case reads as a missing date
    // rather than one that does not exist yet.
    const pending = mapWith({
      data: { courtCaseData: { cnr: 'DLHC010001232024', caseStatus: 'PENDING', petitioners: ['A'] } },
    });

    const card = formatCaseStatus(pending);
    expect(card).not.toContain('Disposal Date');
    expect(card).not.toContain('Nature of Disposal');
  });

  it('does not print an FIR line on a matter that has none', () => {
    const civil = mapWith({
      data: { courtCaseData: { cnr: 'DLHC010001232024', caseStatus: 'PENDING', petitioners: ['A'] } },
    });

    expect(formatCaseStatus(civil)).not.toContain('FIR');
  });
});

describe('invented case records', () => {
  /*
   * Mock mode returns a plausible case for any valid CNR, and it was the
   * default - so a deployment that never set ECOURTS_MODE served fabricated
   * court records, under a line of small text saying so.
   */
  function service(env: Record<string, unknown>) {
    const settings = { get: () => '', getNumber: (_k: string, d: number) => d };
    return new EcourtsService(env as never, settings as never);
  }

  it('are refused in production', async () => {
    await expect(
      service({ NODE_ENV: 'production', ECOURTS_MODE: 'mock' }).lookup('DLHC010001232024'),
    ).rejects.toBeInstanceOf(EcourtsMisconfiguredError);
  });

  it('are still available for local work and tests', async () => {
    const result = await service({ NODE_ENV: 'development', ECOURTS_MODE: 'mock' }).lookup(
      'DLHC010001232024',
    );

    expect(result.mocked).toBe(true);
  });
});
