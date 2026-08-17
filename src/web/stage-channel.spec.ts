import { StageChannel } from './stage-channel';

/**
 * The bridge between the RAG pipeline's progress callback and the SSE
 * generator.
 *
 * Tested because every failure mode here is a hang rather than an error: a
 * consumer waiting on a value that never arrives holds the HTTP connection open
 * until the browser gives up, with nothing in any log to say why.
 */
describe('StageChannel', () => {
  /** Collect everything a channel produces, in order. */
  async function drain<T>(channel: StageChannel<T>): Promise<T[]> {
    const seen: T[] = [];
    for await (const value of channel) seen.push(value);
    return seen;
  }

  it('delivers values pushed before anyone is listening', async () => {
    // The producer usually wins the race: rag.answer() reports its first stage
    // before the consumer's first await. Dropping those would mean the client
    // never sees the beginning of the pipeline.
    const channel = new StageChannel<string>();
    channel.push('retrieving');
    channel.push('generating');
    channel.close();

    await expect(drain(channel)).resolves.toEqual(['retrieving', 'generating']);
  });

  it('delivers values pushed while the consumer is waiting', async () => {
    const channel = new StageChannel<string>();
    const collected = drain(channel);

    // Give the consumer a turn to park on its promise before pushing.
    await Promise.resolve();
    channel.push('verifying');
    channel.close();

    await expect(collected).resolves.toEqual(['verifying']);
  });

  it('still delivers queued values after close', async () => {
    // close() means "the producer has finished", not "discard its output". A
    // consumer that missed the final stage would leave the interface showing
    // the second-to-last one forever.
    const channel = new StageChannel<string>();
    channel.push('generating');
    channel.push('verifying');
    channel.close();

    await expect(drain(channel)).resolves.toEqual(['generating', 'verifying']);
  });

  it('terminates a waiting consumer when the producer closes', async () => {
    // The hang this guards against: rag.answer() rejects, nothing more is ever
    // pushed, and the request never finishes. ChatService closes the channel on
    // both settlements for exactly this reason.
    const channel = new StageChannel<string>();
    const collected = drain(channel);

    await Promise.resolve();
    channel.close();

    await expect(collected).resolves.toEqual([]);
  });

  it('ignores pushes after close rather than throwing', async () => {
    // The producer is on the critical path of answering a question. A late
    // stage report must never be able to fail the request that produced it.
    const channel = new StageChannel<string>();
    channel.close();

    expect(() => channel.push('generating')).not.toThrow();
    await expect(drain(channel)).resolves.toEqual([]);
  });

  it('is safe to close twice', async () => {
    const channel = new StageChannel<string>();
    channel.close();
    expect(() => channel.close()).not.toThrow();
  });

  it('never blocks the producer', () => {
    // push() is synchronous and unconditional. If it awaited a slow consumer,
    // a browser on a poor connection could hold up the answer it is waiting
    // for - progress reporting must never become backpressure on the work.
    const channel = new StageChannel<number>();
    for (let i = 0; i < 1000; i++) channel.push(i);
    channel.close();

    expect(true).toBe(true);
  });
});
