/**
 * Queue names and job payload contracts.
 *
 * Shared by the web process (which enqueues) and the worker process (which
 * consumes), so the payload shape can only drift if you change it here.
 */

export const QUEUE_WHATSAPP_INBOUND = 'whatsapp-inbound';

/** One inbound WhatsApp message, handed off for asynchronous processing. */
export interface InboundMessageJob {
  /** Meta's message id (wamid...). Doubles as the BullMQ job id for dedupe. */
  waMessageId: string;
  /** Sender, digits only, as Meta delivers it. */
  from: string;
  /** Our own phone number id, for multi-number setups later. */
  phoneNumberId: string;
  /** Unix seconds from Meta's payload. */
  timestamp: number;
  type: 'text' | 'interactive' | 'audio' | 'image' | 'document' | 'button' | 'unsupported';
  /** Plain text body, or the title/id of the tapped button or list row. */
  text?: string;
  /** Set for interactive replies: the id we encoded into the button or row. */
  interactiveId?: string;
  /** Media id for audio/image/document, to be fetched from the Graph API. */
  mediaId?: string;
  mediaMimeType?: string;
  /** Display name from Meta's contacts block, used to greet new users. */
  profileName?: string;
}

/** Deterministic BullMQ job id, so a redelivered webhook cannot double-enqueue. */
export function inboundJobId(waMessageId: string): string {
  return `wa-${waMessageId}`;
}
