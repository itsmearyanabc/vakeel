/**
 * WhatsApp Business Cloud API webhook payloads.
 *
 * Hand-written rather than generated because Meta publishes no schema. Every
 * field is optional in practice - Meta adds message types without warning, and
 * a payload shape you have not seen before must not crash the webhook, because
 * repeated non-200s get the phone number throttled.
 *
 * Reference: developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id?: string;
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field?: string;
  value?: WebhookValue;
}

export interface WebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WebhookContact[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
  errors?: { code?: number; title?: string; message?: string }[];
}

export interface WebhookContact {
  profile?: { name?: string };
  wa_id?: string;
}

export interface WebhookMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: 'button_reply' | 'list_reply';
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  /** Legacy template button replies (not the interactive kind). */
  button?: { text?: string; payload?: string };
  audio?: MediaRef;
  image?: MediaRef;
  document?: MediaRef & { filename?: string };
  video?: MediaRef;
  /** Present when the user replied to a specific message. */
  context?: { from?: string; id?: string };
  errors?: { code?: number; title?: string }[];
}

export interface MediaRef {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  voice?: boolean;
}

export interface WebhookStatus {
  id?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string }[];
}

// -----------------------------------------------------------------------------
// Outbound message shapes
// -----------------------------------------------------------------------------

export interface OutboundTextMessage {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
}

export interface OutboundInteractiveMessage {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'interactive';
  interactive: InteractiveButtons | InteractiveList;
}

export interface InteractiveButtons {
  type: 'button';
  header?: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: { buttons: { type: 'reply'; reply: { id: string; title: string } }[] };
}

export interface InteractiveList {
  type: 'list';
  header?: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: {
    button: string;
    sections: { title: string; rows: { id: string; title: string; description?: string }[] }[];
  };
}

export type OutboundMessage = OutboundTextMessage | OutboundInteractiveMessage;
