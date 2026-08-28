import { InboundMessageJob } from './queue.constants';
import { InboundWorker } from './inbound.worker';

/**
 * Answering a WhatsApp message exactly once.
 *
 * This is the guard on a bug that reached real advocates: the bot sent people
 * unprompted messages, minutes or hours after the conversation had moved on,
 * each one worded differently because the reply was regenerated on every
 * replay. It reads as a bot talking to itself, and it is indistinguishable -
 * from the outside - from the bot answering somebody else's question on your
 * phone.
 *
 * The cause is that the reply is sent partway through handling, and everything
 * after it (conversation state, analytics, memory) can still fail. A retry, or
 * the stalled-job sweep after a deploy, re-runs the whole thing.
 */

const JOB: InboundMessageJob = {
  waMessageId: 'wamid.TEST',
  from: '919876543210',
  phoneNumberId: '1318085158050251',
  timestamp: Math.floor(Date.now() / 1000),
  type: 'text',
  text: 'hello',
};

function build(over: { claim?: jest.Mock; conversation?: jest.Mock } = {}) {
  const jobs = {
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue({ dead: true, attempts: 1, retryAt: null }),
  };
  const messages = {
    // Atomic insert-if-absent: true the first time, false ever after.
    claimWebhookEvent: over.claim ?? jest.fn().mockResolvedValue(true),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const conversation = { handle: over.conversation ?? jest.fn().mockResolvedValue(undefined) };
  const api = { sendText: jest.fn().mockResolvedValue({ ok: true }) };

  const worker = new InboundWorker(
    jobs as never,
    conversation as never,
    api as never,
    messages as never,
    {} as never,
  );

  // `handle` is private by design - nothing outside the poll loop should call
  // it - but it is the unit that owns the once-only decision.
  const run = (attempts = 1): Promise<void> =>
    (worker as unknown as {
      handle(id: string, data: InboundMessageJob, attempts: number, max: number): Promise<void>;
    }).handle('job-1', JOB, attempts, 1);

  return { run, jobs, messages, conversation, api };
}

describe('InboundWorker.handle', () => {
  it('answers a message the first time it is seen', async () => {
    const { run, conversation, jobs } = build();

    await run();

    expect(conversation.handle).toHaveBeenCalledTimes(1);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
  });

  it('drops a replay instead of answering twice', async () => {
    // The claim was taken by the attempt that already replied.
    const { run, conversation, jobs } = build({ claim: jest.fn().mockResolvedValue(false) });

    await run(2);

    expect(conversation.handle).not.toHaveBeenCalled();
    // Completed, not left behind: a job that is dropped but stays ACTIVE would
    // be reclaimed by the next sweep and dropped again, forever.
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
  });

  it('claims before replying, never after', async () => {
    const order: string[] = [];
    const { run } = build({
      claim: jest.fn().mockImplementation(async () => {
        order.push('claim');
        return true;
      }),
      conversation: jest.fn().mockImplementation(async () => {
        order.push('reply');
      }),
    });

    await run();

    // Claiming after the send would leave the window this guard exists to
    // close: a crash between the two replays the message.
    expect(order).toEqual(['claim', 'reply']);
  });

  it('still answers when the claim itself fails', async () => {
    // A database blip must not silence the bot. Answering twice is bad;
    // answering never, because a bookkeeping row could not be written, is
    // worse - and this path is the only one where we get to choose.
    const { run, conversation } = build({
      claim: jest.fn().mockRejectedValue(new Error('connection reset')),
    });

    await run();

    expect(conversation.handle).toHaveBeenCalledTimes(1);
  });

  it('apologises once when handling fails, and does not retry', async () => {
    const { run, api, jobs } = build({
      conversation: jest.fn().mockRejectedValue(new Error('model timed out')),
    });

    await run();

    // max_attempts is 1, so the first failure is terminal and the apology is
    // the only message the advocate gets - never an apology plus a late answer.
    expect(jobs.fail).toHaveBeenCalled();
    expect(api.sendText).toHaveBeenCalledTimes(1);
  });
});
