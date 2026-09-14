import { APP_JS } from './app.js';

/**
 * The website's case-status card, checked as the source string it ships as.
 *
 * The browser script is a template literal, so nothing in `nest build` looks
 * inside it. What is asserted is that the card carries the same case numbers as
 * the WhatsApp card, in the same order - an advocate who checks a matter on
 * both should not have to work out why one shows a number the other hides.
 */
describe('the website case card', () => {
  const start = APP_JS.indexOf('function renderCaseStatus');
  const card = APP_JS.slice(start, APP_JS.indexOf('\nfunction ', start + 1));

  it('exists', () => {
    expect(start).toBeGreaterThan(-1);
    expect(card.length).toBeGreaterThan(0);
  });

  it.each([
    ['Case type', 'data.caseType'],
    ['Filing number', 'data.filingNumber'],
    ['Registration number', 'data.caseNumber'],
    ['CNR case number', 'data.cnrCaseNumber'],
    ['Registered', 'data.registrationDate'],
  ])('shows %s from %s', (label, field) => {
    expect(card).toContain(`['${label}', ${field}]`);
  });

  it('keeps the three numbers together, in the WhatsApp order', () => {
    const filing = card.indexOf("'Filing number'");
    const registration = card.indexOf("'Registration number'");
    const cnrCase = card.indexOf("'CNR case number'");

    expect(filing).toBeLessThan(registration);
    expect(registration).toBeLessThan(cnrCase);
  });
});
