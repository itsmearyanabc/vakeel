import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  const fail = () => Promise.reject(new Error('upstream down'));
  const succeed = () => Promise.resolve('ok');

  it('stays closed while calls succeed', async () => {
    const breaker = new CircuitBreaker('test', 3, 1000);
    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('opens after the failure threshold', async () => {
    const breaker = new CircuitBreaker('test', 3, 1000);

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    }

    expect(breaker.currentState).toBe('OPEN');
  });

  it('fails fast while open, without calling the upstream', async () => {
    // The point of the breaker: a queued job must not wait a full timeout to
    // discover the upstream is still down.
    const breaker = new CircuitBreaker('test', 1, 10000);
    await expect(breaker.execute(fail)).rejects.toThrow();

    const upstream = jest.fn(succeed);
    await expect(breaker.execute(upstream)).rejects.toThrow(CircuitOpenError);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('resets the failure count on success', async () => {
    const breaker = new CircuitBreaker('test', 3, 1000);
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(fail)).rejects.toThrow();
    await breaker.execute(succeed);
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('probes after the reset window and closes on success', async () => {
    const breaker = new CircuitBreaker('test', 1, 20);
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe('OPEN');

    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('re-opens immediately when the probe fails', async () => {
    const breaker = new CircuitBreaker('test', 2, 20);
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(fail)).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 30));

    // One failed probe is enough; it must not need another full threshold.
    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.currentState).toBe('OPEN');
  });

  describe('expected errors', () => {
    class NotFound extends Error {}

    it('does not count an excluded error towards opening', async () => {
      // A run of typo'd CNRs must not take the eCourts integration offline for
      // everyone else.
      const breaker = new CircuitBreaker('test', 2, 1000);
      const isFailure = (err: unknown) => !(err instanceof NotFound);

      for (let i = 0; i < 5; i++) {
        await expect(breaker.execute(() => Promise.reject(new NotFound()), isFailure)).rejects.toThrow(
          NotFound,
        );
      }

      expect(breaker.currentState).toBe('CLOSED');
    });

    it('still opens for genuine failures', async () => {
      const breaker = new CircuitBreaker('test', 2, 1000);
      const isFailure = (err: unknown) => !(err instanceof NotFound);

      await expect(breaker.execute(() => Promise.reject(new NotFound()), isFailure)).rejects.toThrow();
      await expect(breaker.execute(fail, isFailure)).rejects.toThrow();
      await expect(breaker.execute(fail, isFailure)).rejects.toThrow();

      expect(breaker.currentState).toBe('OPEN');
    });
  });
});
