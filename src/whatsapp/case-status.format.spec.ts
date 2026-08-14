import { CaseStatus } from '../ecourts/ecourts.service';
import { formatCaseStatus } from './replies';

function status(overrides: Partial<CaseStatus> = {}): CaseStatus {
  return {
    cnr: 'BRMG030000191989',
    caseNumber: 'CS/123/2024',
    caseType: 'Civil Suit',
    filingDate: '2024-01-10',
    registrationDate: '2024-01-15',
    court: 'Munger District Court',
    judge: 'Court 3 — Sri Alok Gupta',
    petitioner: 'State of Bihar',
    respondent: 'Ram Kumar',
    petitionerAdvocate: 'Adv. S. Sinha',
    respondentAdvocate: 'Adv. M. Verma',
    stage: 'Evidence',
    nextHearingDate: '2099-01-01',
    lastHearingDate: '2024-02-01',
    status: 'PENDING',
    mocked: false,
    ...overrides,
  };
}

describe('formatCaseStatus', () => {
  it('prints every field in the agreed order', () => {
    const out = formatCaseStatus(status());
    const labels = [
      'Case Type', 'Filing Number', 'Filing Date', 'Registration Number',
      'Registration Date', 'CNR Number', 'First Hearing Date', 'Next Hearing Date',
      'Case Status', 'Stage of Case', 'Court Number and Judge',
      'Petitioner and Advocate', 'Respondent and Advocate',
    ];
    let cursor = -1;
    for (const label of labels) {
      const at = out.indexOf(`• ${label}:`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('prints "Not available" rather than dropping a row', () => {
    // A card whose shape changes with the data is hard to read down a phone
    // screen, and a missing row reads as the bot omitting something.
    const out = formatCaseStatus(status({ caseType: null, stage: null, judge: null }));
    expect(out).toContain('• Case Type: Not available');
    expect(out).toContain('• Stage of Case: Not available');
    expect(out).toContain('• Court Number and Judge: Not available');
  });

  it('blanks a past next-hearing date on a disposed case', () => {
    // Left in, an advocate scanning quickly reads a date that already happened
    // as an upcoming listing on a matter that is over.
    const out = formatCaseStatus(status({ status: 'DISPOSED', nextHearingDate: '2020-05-05' }));
    expect(out).toContain('• Next Hearing Date: Not available');
    expect(out).not.toContain('2020-05-05');
  });

  it('keeps a future next-hearing date on a disposed case', () => {
    // Restoration and review applications do get relisted after disposal.
    const out = formatCaseStatus(status({ status: 'DISPOSED', nextHearingDate: '2099-01-01' }));
    expect(out).toContain('• Next Hearing Date: 2099-01-01');
  });

  it('pairs each party with its advocate, degrading gracefully', () => {
    expect(formatCaseStatus(status())).toContain('State of Bihar (Adv. S. Sinha)');
    expect(formatCaseStatus(status({ respondentAdvocate: null }))).toContain(
      '• Respondent and Advocate: Ram Kumar',
    );
    expect(
      formatCaseStatus(status({ petitioner: null, petitionerAdvocate: null })),
    ).toContain('• Petitioner and Advocate: Not available');
  });

  it('always carries the caveat and the way back', () => {
    const out = formatCaseStatus(status());
    expect(out).toMatch(/research aid.*Not legal advice/i);
    expect(out).toContain('Type *0*');
  });

  it('says so when the data is synthetic', () => {
    expect(formatCaseStatus(status({ mocked: true }))).toContain('Sample data');
  });
});
