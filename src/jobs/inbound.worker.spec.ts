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

function build(over: { claim?: jest.Mock; conversation?: jest.Mock; touch?: jest.Mock } = {}) {
  const jobs = {
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue({ dead: true, attempts: 1, retryAt: null }),
    touch: over.touch ?? jest.fn().mockResolvedValue(true),
  };
  const messages = {
    // Atomic insert-if-absent: true the first time, false ever after.
    claimWebhookEvent: over.claim ?? jest.fn().mockResolvedValue(true),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const conversation = { handle: over.conversation ?? jest.fn().mockResolvedValue(undefined) };
  const api = { sendText: jest.fn().mockResolvedValue({ ok: true }) };

  // A real lease value, not an empty object: the lease-renewal timer derives
  // its interval from it, and NaN makes setInterval fire immediately and
  // forever.
  const env = { JOB_LEASE_SECONDS: 120 };

  const worker = new InboundWorker(
    jobs as never,
    conversation as never,
    api as never,
    messages as never,
    env as never,
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

describe('holding the lock for as long as the work takes', () => {
  /*
   * Per-advocate serialisation is what stops two messages from one number
   * racing through the same conversation row, and it is enforced by a lease
   * that a clock decides - not by whether this process is alive. So it holds
   * only while the lease outlasts the work, and the work can outlast it: one
   * message makes at least two provider calls, each capable of taking
   * LLM_TIMEOUT_MS x (1 + LLM_MAX_RETRIES) - 135 seconds on the defaults,
   * against a 120-second lease.
   *
   * When it lapses, the sweep marks the job DEAD and frees the lock while the
   * work is still running, and the advocate's next message is claimed alongside
   * it. The failure is silent: the original worker then completes the DEAD row,
   * so it does not even show up in the queue stats.
   */
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick'] }));
  afterEach(() => jest.useRealTimers());

  it('renews the lease while a slow message is still being answered', async () => {
    let finish = (): void => undefined;
    let started = (): void => undefined;
    // Resolved from inside the fake handler, so the timer is only advanced once
    // the worker is genuinely mid-message. Awaiting a fixed number of
    // microtasks instead would depend on how many awaits precede this one.
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const conversation = jest.fn(() => {
      started();
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const { run, jobs } = build({ conversation });

    const pending = run();
    await reached;

    // A third of the 120-second lease, twice over.
    jest.advanceTimersByTime(80_000);
    expect(jobs.touch).toHaveBeenCalledWith('job-1', 120);
    expect(jobs.touch.mock.calls.length).toBeGreaterThanOrEqual(2);

    finish();
    await pending;
  });

  it('stops renewing once the message is answered', async () => {
    const { run, jobs } = build();

    await run();
    jobs.touch.mockClear();
    jest.advanceTimersByTime(300_000);

    // A timer left running would keep renewing the lease of a job nobody is
    // working on, which blocks that advocate until the process restarts.
    expect(jobs.touch).not.toHaveBeenCalled();
  });

  it('stops renewing when handling fails', async () => {
    const { run, jobs } = build({
      conversation: jest.fn().mockRejectedValue(new Error('model timed out')),
    });

    await run();
    jobs.touch.mockClear();
    jest.advanceTimersByTime(300_000);

    expect(jobs.touch).not.toHaveBeenCalled();
  });

  it('does not abandon a message because one heartbeat failed', async () => {
    // A blip on the renewal must not take down a reply that is otherwise going
    // fine; the next beat covers it.
    const { run, jobs, api } = build({ touch: jest.fn().mockRejectedValue(new Error('blip')) });

    await expect(run()).resolves.toBeUndefined();
    expect(jobs.complete).toHaveBeenCalled();
    expect(api.sendText).not.toHaveBeenCalled();
  });
});
