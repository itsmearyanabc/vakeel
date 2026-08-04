import { LIMITS, buttonMessage, clamp, listMessage, splitForWhatsApp, textMessage, toWhatsAppMarkup } from './message-builder';

describe('clamp', () => {
  it('leaves short text alone', () => {
    expect(clamp('short', 20)).toBe('short');
  });

  it('truncates with an ellipsis and respects the limit', () => {
    const result = clamp('a'.repeat(50), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('splitForWhatsApp', () => {
  it('returns one part when the text fits', () => {
    expect(splitForWhatsApp('short answer')).toEqual(['short answer']);
  });

  it('splits long text into parts within the limit', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the judgment analysis.`).join('\n\n');
    const parts = splitForWhatsApp(long);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMITS.TEXT_BODY);
    }
  });

  it('loses no words', () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const rejoined = splitForWhatsApp(long, 200).join(' ');
    expect(rejoined.split(/\s+/)).toHaveLength(300);
  });

  it('prefers paragraph boundaries', () => {
    const text = `${'a'.repeat(90)}\n\n${'b'.repeat(90)}`;
    const parts = splitForWhatsApp(text, 100);
    expect(parts[0]).toBe('a'.repeat(90));
  });
});

describe('textMessage', () => {
  it('clamps an over-long body rather than letting Meta reject it', () => {
    const message = textMessage('919876543210', 'x'.repeat(9000));
    expect(message.type).toBe('text');
    if (message.type === 'text') {
      expect(message.text.body.length).toBeLessThanOrEqual(LIMITS.TEXT_BODY);
    }
  });
});

describe('buttonMessage', () => {
  it('caps at three buttons', () => {
    // A fourth button makes Meta reject the entire message, not just the button.
    const message = buttonMessage('919876543210', 'Pick one', [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
      { id: 'd', title: 'D' },
    ]);

    if (message.type === 'interactive' && message.interactive.type === 'button') {
      expect(message.interactive.action.buttons).toHaveLength(3);
    } else {
      throw new Error('expected an interactive button message');
    }
  });

  it('truncates button titles to 20 characters', () => {
    const message = buttonMessage('919876543210', 'Body', [
      { id: 'a', title: 'A very long button title that will not fit' },
    ]);

    if (message.type === 'interactive' && message.interactive.type === 'button') {
      expect(message.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(
        LIMITS.BUTTON_TITLE,
      );
    }
  });
});

describe('listMessage', () => {
  it('caps rows at ten ACROSS all sections', () => {
    // The limit is global, not per section - capping per section still gets the
    // message rejected.
    const sections = [
      { title: 'One', rows: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, title: `A${i}` })) },
      { title: 'Two', rows: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, title: `B${i}` })) },
    ];

    const message = listMessage('919876543210', 'Body', 'Open', sections);

    if (message.type === 'interactive' && message.interactive.type === 'list') {
      const total = message.interactive.action.sections.reduce((sum, s) => sum + s.rows.length, 0);
      expect(total).toBe(LIMITS.LIST_ROWS_MAX);
    } else {
      throw new Error('expected an interactive list message');
    }
  });

  it('drops sections left with no rows after the cap', () => {
    const sections = [
      { title: 'One', rows: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, title: `A${i}` })) },
      { title: 'Two', rows: [{ id: 'b', title: 'B' }] },
    ];

    const message = listMessage('919876543210', 'Body', 'Open', sections);

    if (message.type === 'interactive' && message.interactive.type === 'list') {
      // An empty section is itself a validation error.
      expect(message.interactive.action.sections).toHaveLength(1);
    }
  });
});

describe('toWhatsAppMarkup', () => {
  it('converts markdown bold to WhatsApp bold', () => {
    // Models emit ** regardless of prompting; WhatsApp renders it literally.
    expect(toWhatsAppMarkup('**Section 302** applies')).toBe('*Section 302* applies');
  });

  it('converts headings to bold lines', () => {
    expect(toWhatsAppMarkup('## Holding')).toBe('*Holding*');
  });

  it('flattens markdown links', () => {
    expect(toWhatsAppMarkup('[eCourts](https://ecourts.gov.in)')).toBe('eCourts (https://ecourts.gov.in)');
  });

  it('rewrites asterisk bullets so they do not read as bold', () => {
    expect(toWhatsAppMarkup('* first\n* second')).toBe('· first\n· second');
  });
});
