import { InteractiveButtons, InteractiveList, OutboundMessage } from './whatsapp.types';

/**
 * Builders for outbound WhatsApp messages.
 *
 * Meta enforces hard limits on every field and rejects the entire message with
 * a generic error when one is exceeded - it does not truncate for you, and the
 * error does not say which field was at fault. Centralising the truncation here
 * is what stops a long case title silently costing a user their reply.
 */

export const LIMITS = {
  /** Plain text body. */
  TEXT_BODY: 4096,
  /** Body of an interactive message - much smaller than a plain text body. */
  INTERACTIVE_BODY: 1024,
  HEADER: 60,
  FOOTER: 60,
  BUTTON_TITLE: 20,
  BUTTONS_MAX: 3,
  LIST_BUTTON: 20,
  LIST_SECTION_TITLE: 24,
  LIST_ROW_TITLE: 24,
  LIST_ROW_DESCRIPTION: 72,
  LIST_ROWS_MAX: 10,
} as const;

/** Truncate with an ellipsis, respecting the limit including the ellipsis. */
export function clamp(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function textMessage(to: string, body: string, previewUrl = false): OutboundMessage {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: clamp(body, LIMITS.TEXT_BODY), preview_url: previewUrl },
  };
}

/**
 * Split a long answer into WhatsApp-sized parts.
 *
 * Breaks on paragraphs first, then sentences, and only mid-word as a last
 * resort - a legal citation split across two messages is unusable, so the
 * boundaries are chosen to keep them intact where possible.
 */
export function splitForWhatsApp(text: string, limit: number = LIMITS.TEXT_BODY): string[] {
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // Prefer a paragraph break in the last third of the window.
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.6) {
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('।'));
      cut = sentence > limit * 0.5 ? sentence + 1 : -1;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      cut = space > limit * 0.5 ? space : limit;
    }

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

export function buttonMessage(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
  options: { header?: string; footer?: string } = {},
): OutboundMessage {
  const interactive: InteractiveButtons = {
    type: 'button',
    body: { text: clamp(body, LIMITS.INTERACTIVE_BODY) },
    action: {
      // Meta allows at most three; sending a fourth rejects the whole message.
      buttons: buttons.slice(0, LIMITS.BUTTONS_MAX).map((b) => ({
        type: 'reply' as const,
        reply: { id: clamp(b.id, 256), title: clamp(b.title, LIMITS.BUTTON_TITLE) },
      })),
    },
  };

  if (options.header) interactive.header = { type: 'text', text: clamp(options.header, LIMITS.HEADER) };
  if (options.footer) interactive.footer = { text: clamp(options.footer, LIMITS.FOOTER) };

  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive };
}

export function listMessage(
  to: string,
  body: string,
  buttonLabel: string,
  sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
  options: { header?: string; footer?: string } = {},
): OutboundMessage {
  // The 10-row cap is across ALL sections combined, not per section.
  let budget = LIMITS.LIST_ROWS_MAX;
  const cappedSections = sections
    .map((section) => {
      const rows = section.rows.slice(0, budget).map((row) => ({
        id: clamp(row.id, 200),
        title: clamp(row.title, LIMITS.LIST_ROW_TITLE),
        ...(row.description ? { description: clamp(row.description, LIMITS.LIST_ROW_DESCRIPTION) } : {}),
      }));
      budget -= rows.length;
      return { title: clamp(section.title, LIMITS.LIST_SECTION_TITLE), rows };
    })
    .filter((section) => section.rows.length > 0);

  const interactive: InteractiveList = {
    type: 'list',
    body: { text: clamp(body, LIMITS.INTERACTIVE_BODY) },
    action: { button: clamp(buttonLabel, LIMITS.LIST_BUTTON), sections: cappedSections },
  };

  if (options.header) interactive.header = { type: 'text', text: clamp(options.header, LIMITS.HEADER) };
  if (options.footer) interactive.footer = { text: clamp(options.footer, LIMITS.FOOTER) };

  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive };
}

/**
 * Convert common markdown to WhatsApp's markup.
 *
 * Models reliably emit markdown regardless of instructions, and WhatsApp
 * renders `**bold**` literally as asterisks. This is a small cleanup pass on
 * the way out rather than a full parser.
 */
export function toWhatsAppMarkup(text: string): string {
  return (
    text
      // **bold** -> *bold*  (before single-asterisk handling)
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Markdown headings have no equivalent; bold the line instead.
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // [label](url) -> label (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      // Normalise bullets to a middot; '*' at line start would read as bold.
      .replace(/^\s*[-*+]\s+/gm, '· ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
