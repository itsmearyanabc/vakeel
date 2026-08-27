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

/**
 * A pre-approved template, which is the only thing that reaches a handset
 * outside the 24-hour customer service window.
 *
 * Everything else in this union is free-form, and WhatsApp will only deliver
 * free-form messages to someone who has messaged the business in the last 24
 * hours. That rule is why account verification could not previously be sent to
 * a phone: a person signing up has, by definition, never messaged the bot.
 *
 * ## The body parameter is the code, and nothing else
 *
 * Authentication-category templates take exactly one body parameter - the
 * one-time code - and Meta rejects the template at review if the body contains
 * anything it did not approve. The copy lives in the template, not here, so
 * this type deliberately cannot express a template with arbitrary prose.
 */
export interface OutboundTemplateMessage {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components: TemplateComponent[];
  };
}

export type TemplateComponent =
  | { type: 'body'; parameters: { type: 'text'; text: string }[] }
  /**
   * Authentication templates render their code as a copy-to-clipboard button,
   * and Meta requires the code to be repeated here as well as in the body.
   * Sending the body alone is accepted by the API and then silently delivers a
   * message whose button copies an empty string.
   */
  | {
      type: 'button';
      sub_type: 'url' | 'copy_code';
      index: string;
      parameters: { type: 'text' | 'coupon_code'; text?: string; coupon_code?: string }[];
    };

export type OutboundMessage =
  | OutboundTextMessage
  | OutboundInteractiveMessage
  | OutboundTemplateMessage;
