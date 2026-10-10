"use strict";

/**
 * A small FIFO semaphore for bounding concurrent asynchronous jobs.
 * Each acquire returns an idempotent release function.
 */
function createSemaphore(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("Semaphore limit must be a positive integer");
  }

  let active = 0;
  const waiters = [];

  function makeRelease() {
    let released = false;
    return function release() {
      if (released) return;
      released = true;

      const next = waiters.shift();
      if (next) {
        // Transfer the occupied slot directly; active remains unchanged.
        next();
      } else {
        active -= 1;
      }
    };
  }

  async function acquire() {
    if (active < limit) {
      active += 1;
      return makeRelease();
    }

    await new Promise((resolve) => waiters.push(resolve));
    return makeRelease();
  }

  return {
    acquire,
    activeCount: () => active,
    waitingCount: () => waiters.length,
  };
}

module.exports = { createSemaphore };
