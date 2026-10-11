/**
 * Process-wide FIFO mutex. Callers queue rather than fail, so a second switch
 * request (Stremio can fire the stream request twice) waits, then finds the
 * profile already active.
 */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
    this.busy = false;
  }

  run(fn) {
    const result = this.tail.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }

  /** Resolves once everything queued so far has finished. */
  idle() {
    return this.tail;
  }
}
