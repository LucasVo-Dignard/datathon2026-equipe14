'use strict';
// Client-side rate limiting and retry policy, so we stay under a provider's
// quota and survive transient failures.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sliding window: at most `maxCalls` per `periodMs`. `acquire()` resolves
// when a call is allowed. Calls are served in order, so one instance can be
// shared by every fetcher that uses the same API key.
class RateLimiter {
  constructor(maxCalls, periodMs, { clock = () => performance.now(), wait = sleep } = {}) {
    if (!(maxCalls >= 1) || !(periodMs > 0)) throw new RangeError('maxCalls must be >= 1 and periodMs > 0');
    this.maxCalls = maxCalls;
    this.periodMs = periodMs;
    this.clock = clock;
    this.wait = wait;
    this.calls = [];
    this.queue = Promise.resolve();
  }

  acquire() {
    const turn = this.queue.then(() => this.#take());
    this.queue = turn.catch(() => {});
    return turn;
  }

  async #take() {
    for (;;) {
      const now = this.clock();
      while (this.calls.length && this.calls[0] <= now - this.periodMs) this.calls.shift();
      if (this.calls.length < this.maxCalls) {
        this.calls.push(now);
        return;
      }
      await this.wait(this.calls[0] + this.periodMs - now);
    }
  }
}

// Exponential backoff: wait `backoffMs * factor ** (n - 1)` after the n-th
// failed attempt, for at most `maxAttempts` attempts.
class RetryPolicy {
  constructor({ maxAttempts = 3, backoffMs = 1000, factor = 2 } = {}) {
    if (!(maxAttempts >= 1)) throw new RangeError('maxAttempts must be at least 1');
    Object.assign(this, { maxAttempts, backoffMs, factor });
    Object.freeze(this);
  }

  delayAfter(attempt) {
    return this.backoffMs * this.factor ** (attempt - 1);
  }

  isLast(attempt) {
    return attempt >= this.maxAttempts;
  }
}

module.exports = { RateLimiter, RetryPolicy, sleep };
