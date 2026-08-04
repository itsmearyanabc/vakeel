import { getLogger } from './logger';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(name: string, retryInMs: number) {
    super(`Circuit "${name}" is open; retry in ${Math.ceil(retryInMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Circuit breaker for third-party calls (spec section 6.2).
 *
 * The case that motivates this: eCourts goes down or starts serving CAPTCHAs.
 * Without a breaker, every queued CNR lookup waits the full timeout before
 * failing, worker slots fill with doomed jobs, and unrelated messages stop
 * being answered. The breaker converts a slow failure into a fast one, which is
 * what keeps the rest of the bot responsive.
 *
 * States:
 *   CLOSED    - normal. Consecutive failures are counted.
 *   OPEN      - threshold hit. Calls fail immediately without touching the
 *               network, until the reset window elapses.
 *   HALF_OPEN - one probe call is allowed. Success closes the circuit, failure
 *               re-opens it for another window.
 */
export class CircuitBreaker {
  private readonly logger = getLogger().child({ module: 'circuit-breaker' });

  private failures = 0;
  private state: BreakerState = 'CLOSED';
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  get currentState(): BreakerState {
    return this.state;
  }

  /**
   * @param fn        the call to protect
   * @param isFailure decides whether a thrown error counts towards opening the
   *                  circuit. Defaults to "all errors count". Pass a predicate
   *                  to exclude expected outcomes - a 404 for a CNR that does
   *                  not exist is a correct answer from a healthy upstream, and
   *                  counting it would let a run of typo'd CNRs take the
   *                  integration offline for everyone.
   */
  async execute<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean = () => true): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.resetMs) {
        throw new CircuitOpenError(this.name, this.resetMs - elapsed);
      }
      // Window elapsed: let exactly one call through to test the water.
      this.state = 'HALF_OPEN';
      this.logger.info({ circuit: this.name }, 'Circuit half-open; probing');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (isFailure(err)) {
        this.onFailure();
      } else if (this.state === 'HALF_OPEN') {
        // The probe reached a working upstream and got a valid answer, so the
        // circuit should close even though the call "failed" from the caller's
        // point of view.
        this.onSuccess();
      }
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.info({ circuit: this.name }, 'Probe succeeded; circuit closed');
    }
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures++;

    // A failed probe re-opens immediately - one success is required to close,
    // one failure is enough to re-open.
    if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.logger.warn(
        { circuit: this.name, failures: this.failures, resetMs: this.resetMs },
        'Circuit opened',
      );
    }
  }
}
