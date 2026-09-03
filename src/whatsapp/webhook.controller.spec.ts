import { ForbiddenException } from '@nestjs/common';
import { InboundMessageJob } from '../jobs/queue.constants';
import { WebhookController } from './webhook.controller';
import { WhatsAppWebhookPayload } from './whatsapp.types';

/**
 * Everything that can arrive at the webhook, including the things nobody types.
 *
 * ## Why this file exists
 *
 * The controller decides what an inbound event *is* before anything else in the
 * product sees it, and it had no test of its own. Every case below is something
 * a real advocate does in a WhatsApp thread - tap a menu row, send a voice
 * note, photograph an order sheet, react to an answer - and each one takes a
 * different branch through `toJob`. A branch that mislabels a message does not
 * fail loudly; it just answers the wrong thing, or answers something that was
 * never a question.
 *
 * The signature check and the dedupe layers are covered elsewhere. What is
 * asserted here is normalisation and admission: what becomes a job, what the
 * job says, and what is dropped without one.
 */

function controller(over: { fresh?: boolean } = {}) {
  const queue = { enqueueInbound: jest.fn().mockResolvedValue(undefined) };
  const messages = {
    claimWebhookEvent: jest.fn().mockResolvedValue(over.fresh !== false),
    record: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const signature = {
    verifyWhatsAppSignature: jest.fn().mockReturnValue(true),
    verifySubscription: jest.fn().mockReturnValue(true),
  };
  const settings = {
    whatsappAppSecret: 'secret',
    whatsappVerifyToken: 'token',
    whatsappPhoneNumberId: 'pn-default',
  };

  const instance = new WebhookController(
    signature as never,
    queue as never,
    messages as never,
    settings as never,
    {} as never,
  );

  return { instance, queue, messages, signature };
}

function payload(message: Record<string, unknown>): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ profile: { name: 'Ramesh Kumar' }, wa_id: '919876543210' }],
              messages: [
                { from: '919876543210', id: 'wamid.1', timestamp: '1700000000', ...message },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Drive one inbound event all the way through, and return the queued job. */
async function deliver(
  message: Record<string, unknown>,
  over: { fresh?: boolean } = {},
): Promise<{ job: InboundMessageJob | null; queue: { enqueueInbound: jest.Mock } }> {
  const { instance, queue } = controller(over);

  // dispatch() is deliberately not awaited by receive() - Meta gets its 200
  // straight away - so the private method is driven directly rather than
  // racing the fan-out.
  await (
    instance as unknown as { dispatch(p: WhatsAppWebhookPayload): Promise<void> }
  ).dispatch(payload(message));

  return { job: (queue.enqueueInbound.mock.calls[0]?.[0] as InboundMessageJob) ?? null, queue };
}

describe('what an advocate sends, and what it becomes', () => {
  it('a typed question', async () => {
    const { job } = await deliver({ type: 'text', text: { body: 'what is IPC 420' } });

    expect(job).toMatchObject({
      type: 'text',
      text: 'what is IPC 420',
      from: '919876543210',
      waMessageId: 'wamid.1',
      phoneNumberId: 'pn-1',
      profileName: 'Ramesh Kumar',
    });
  });

  it('a tap on a menu row carries our id, not the label the advocate saw', async () => {
    // Routing keys off the id because it is ours. The title is whatever the
    // menu said at the time, and it is translated.
    const { job } = await deliver({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'action:case_status', title: 'Case status' } },
    });

    expect(job).toMatchObject({ type: 'interactive', interactiveId: 'action:case_status', text: 'Case status' });
  });

  it('a tap on a button', async () => {
    const { job } = await deliver({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'action:verify', title: 'Verify licence' } },
    });

    expect(job).toMatchObject({ type: 'interactive', interactiveId: 'action:verify' });
  });

  it('a voice note, which is most of how this bot is used on the move', async () => {
    const { job } = await deliver({ type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg' } });

    expect(job).toMatchObject({ type: 'audio', mediaId: 'media-1', mediaMimeType: 'audio/ogg' });
  });

  it('a photographed order sheet, with the question in the caption', async () => {
    const { job } = await deliver({
      type: 'image',
      image: { id: 'media-2', mime_type: 'image/jpeg', caption: 'is this order appealable' },
    });

    expect(job).toMatchObject({ type: 'image', mediaId: 'media-2', text: 'is this order appealable' });
  });

  it('a PDF with no caption falls back to the filename', async () => {
    // Better than an empty body: the filename is often the case name, and it is
    // what the advocate will recognise in the message log.
    const { job } = await deliver({
      type: 'document',
      document: { id: 'media-3', mime_type: 'application/pdf', filename: 'order-2024.pdf' },
    });

    expect(job).toMatchObject({ type: 'document', text: 'order-2024.pdf' });
  });

  it.each(['sticker', 'location', 'contacts', 'video', 'something_meta_ships_next'])(
    'labels %s unsupported rather than crashing',
    async (type) => {
      // Meta adds message types without warning. An unknown shape must become a
      // polite refusal, never a 500 - repeated non-200s get the number
      // throttled and eventually the subscription disabled.
      const { job } = await deliver({ type });

      expect(job).toMatchObject({ type: 'unsupported', text: type });
    },
  );

  it('defaults the phone number id when Meta omits the metadata', async () => {
    const { instance, queue } = controller();
    const p = payload({ type: 'text', text: { body: 'hi' } });
    delete p.entry![0].changes![0].value!.metadata;

    await (
      instance as unknown as { dispatch(x: WhatsAppWebhookPayload): Promise<void> }
    ).dispatch(p);

    expect(queue.enqueueInbound).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'pn-default' }),
    );
  });
});

describe('what must never become a reply', () => {
  it('a thumbs-up on an answer is feedback, not a question', async () => {
    /*
     * Meta delivers a reaction through the same `messages` array as everything
     * else, so it fell to the unsupported branch and the worker answered it:
     * "I can read text messages, voice notes and images. Please type your
     * question." An advocate who liked an answer got lectured for saying so.
     *
     * Dropped at the webhook rather than in the worker, so it costs nothing at
     * all - no queue row, no user lookup, and no outbound message.
     */
    const { job, queue } = await deliver({
      type: 'reaction',
      reaction: { message_id: 'wamid.0', emoji: '👍' },
    });

    expect(job).toBeNull();
    expect(queue.enqueueInbound).not.toHaveBeenCalled();
  });

  it('a message with no sender', async () => {
    const { queue } = await deliver({ type: 'text', text: { body: 'hi' }, from: undefined });
    expect(queue.enqueueInbound).not.toHaveBeenCalled();
  });

  it('a redelivery Meta has already sent us', async () => {
    // Meta retries aggressively and each duplicate would otherwise cost a
    // model call and a credit.
    const { queue } = await deliver({ type: 'text', text: { body: 'hi' } }, { fresh: false });
    expect(queue.enqueueInbound).not.toHaveBeenCalled();
  });

  it('a delivery receipt for one of our own replies', async () => {
    const { instance, queue } = controller();

    await (
      instance as unknown as { dispatch(p: WhatsAppWebhookPayload): Promise<void> }
    ).dispatch({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-1' },
                statuses: [{ id: 'wamid.out', status: 'delivered', recipient_id: '919876543210' }],
              },
            },
          ],
        },
      ],
    } as WhatsAppWebhookPayload);

    expect(queue.enqueueInbound).not.toHaveBeenCalled();
  });
});

describe('staying on the air', () => {
  it('answers 200 to a payload it cannot understand', async () => {
    // A 4xx would make Meta retry a payload that will never parse, forever.
    const { instance } = controller();
    const req = { rawBody: Buffer.from('{}'), headers: {}, body: { nonsense: true } };

    await expect(instance.receive(req as never)).resolves.toEqual({ received: true });
  });

  it('rejects a payload whose signature does not verify', async () => {
    const { instance, signature } = controller();
    signature.verifyWhatsAppSignature.mockReturnValue(false);

    const req = { rawBody: Buffer.from('{}'), headers: {}, body: {}, ip: '1.2.3.4' };

    await expect(instance.receive(req as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not make Meta wait for the work', async () => {
    // receive() must return without awaiting dispatch. If this ever starts
    // awaiting, a slow model call becomes a webhook timeout, and sustained
    // timeouts get the subscription disabled.
    const { instance, queue } = controller();
    let release = (): void => undefined;
    queue.enqueueInbound.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const req = {
      rawBody: Buffer.from('{}'),
      headers: {},
      body: payload({ type: 'text', text: { body: 'hi' } }),
    };

    await expect(instance.receive(req as never)).resolves.toEqual({ received: true });
    release();
  });
});
