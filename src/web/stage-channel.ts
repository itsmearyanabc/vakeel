/**
 * A one-producer, one-consumer channel for progress events.
 *
 * ## The problem this solves
 *
 * The RAG pipeline reports progress through a callback, and the chat endpoint
 * delivers it from an async generator. A generator cannot `yield` from inside a
 * callback - the two are different control flows - so something has to sit
 * between them.
 *
 * The obvious workaround is to collect stages into an array and replay them
 * once the answer resolves. That compiles, and it is dishonest: every stage
 * arrives *after* the work it describes has finished, so the client shows
 * "Generating" for a few milliseconds at the very end and the progress display
 * becomes a decoration. If the stages are not live they are worse than absent,
 * because an absent progress bar does not claim anything.
 *
 * This channel makes them live. The producer pushes as work begins; the
 * consumer awaits the next value and forwards it immediately.
 *
 * ## Why it drops rather than buffers under pressure
 *
 * There is no backpressure and there should not be. These are progress
 * notifications for a human watching a screen: if the consumer is slow, the
 * right behaviour is to show the newest state, not to queue stale ones and
 * fall further behind. Crucially, `push` never blocks - a slow or dead client
 * must not be able to hold up the answer it is waiting for.
 */
export class StageChannel<T> {
  private readonly pending: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /**
   * Report a value. Never blocks and never throws, so a producer on the
   * critical path is safe to call it without a try/catch at every site.
   */
  push(value: T): void {
    if (this.closed) return;

    // Hand it straight to a waiting consumer rather than through the queue,
    // which is the common case and the one that has to be fast.
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
      return;
    }

    this.pending.push(value);
  }

  /**
   * No more values are coming.
   *
   * Anything already queued is still delivered - closing means "the producer
   * has finished", not "discard what it produced". A consumer that never sees
   * the last stage would leave the interface stuck on the second-to-last one.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  /**
   * Consume until closed.
   *
   * Single-consumer by construction: `waiting` holds one resolver, so a second
   * concurrent iteration would overwrite the first and strand it forever. That
   * is a real limitation and an acceptable one - there is exactly one response
   * stream per request, and enforcing it would cost more than it saves.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.pending.length > 0) {
        yield this.pending.shift() as T;
        continue;
      }

      if (this.closed) return;

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });

      if (next.done) return;
      yield next.value;
    }
  }
}
