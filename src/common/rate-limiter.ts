/**
 * In-process failure counters, for sign-in throttling.
 *
 * ## What this replaced, and what it gave up
 *
 * Redis held these counters, which made them shared across processes. This does
 * not: with a web process and a worker process, each keeps its own count, so an
 * attacker spreading attempts across both gets double the budget.
 *
 * That is a real weakening and it is acceptable here for three reasons. Only
 * the web process serves sign-ins, so in practice there is one counter, not
 * two. Cloudflare rate-limits `/api/auth/*` at the edge, which is the outer
 * bound and stops the traffic before it costs any CPU. And the passwords behind
 * it are scrypt-hashed, so guessing is expensive regardless of how many
 * attempts are permitted.
 *
 * **If this service is ever scaled to several web replicas, this needs to move
 * back to a shared store.** That is the condition to watch for; it is not true
 * today and the comment is here so it is noticed when it becomes true.
 *
 * ## Why the window is fixed rather than sliding
 *
 * The TTL is set from the first failure and not extended by later ones. A
 * sliding window sounds stricter and is worse: a slow trickle of guesses keeps
 * pushing the expiry out, so an attacker can lock a legitimate user out
 * indefinitely for the cost of one attempt every few minutes.
 */

interface Counter {
  count: number;
  /** Epoch milliseconds. Fixed at the first failure; never extended. */
  expiresAt: number;
}

export class RateLimiter {
  private readonly counters = new Map<string, Counter>();
  /** Entries are swept lazily; this bounds how often that costs anything. */
  private lastSweep = Date.now();

  constructor(private readonly windowSeconds: number) {}

  /** Current count for a key. Zero once the window has lapsed. */
  count(key: string): number {
    const counter = this.counters.get(key);
    if (!counter) return 0;

    if (counter.expiresAt <= Date.now()) {
      this.counters.delete(key);
      return 0;
    }

    return counter.count;
  }

  /** Record a failure. Returns the new count. */
  record(key: string): number {
    this.sweepOccasionally();

    const now = Date.now();
    const counter = this.counters.get(key);

    if (!counter || counter.expiresAt <= now) {
      this.counters.set(key, { count: 1, expiresAt: now + this.windowSeconds * 1000 });
      return 1;
    }

    counter.count += 1;
    return counter.count;
  }

  /** Forget a key. Called on a successful sign-in. */
  clear(...keys: string[]): void {
    for (const key of keys) this.counters.delete(key);
  }

  /**
   * Drop expired counters.
   *
   * Lazy rather than on a timer, because a `setInterval` keeps the event loop
   * alive and would hold a container awake to tidy a map that is usually empty.
   * Sweeping at most once a minute keeps the cost off the hot path.
   */
  private sweepOccasionally(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;

    this.lastSweep = now;
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= now) this.counters.delete(key);
    }
  }
}
