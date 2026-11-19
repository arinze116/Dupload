"use strict";

function cancellationError() {
  const error = new Error("CANCELLED");
  error.code = "UPLOAD_CANCELLED";
  return error;
}

function throwIfCancelled(job) {
  if (job && job.cancelled) {
    throw cancellationError();
  }
}

function trackUploadStream(stream, signal) {
  const onAbort = () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let cleaned = false;
  return function cleanupUploadStream() {
    if (cleaned) return;
    cleaned = true;

    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }

    if (!stream.destroyed) {
      stream.destroy();
    }
  };
}

function sleepWithCancellation(ms, job) {
  throwIfCancelled(job);

  const signal = job && job.abortController && job.abortController.signal;

  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  if (signal.aborted) {
    return Promise.reject(cancellationError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);

    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }

    function finish() {
      cleanup();
      try {
        throwIfCancelled(job);
        resolve();
      } catch (error) {
        reject(error);
      }
    }

    function onAbort() {
      cleanup();
      reject(cancellationError());
    }

    signal.addEventListener("abort", onAbort, { once: true });

    // Handle cancellation that occurred while the listener was being attached.
    if (signal.aborted || (job && job.cancelled)) {
      onAbort();
    }
  });
}

async function withRetry(fn, options = {}) {
  const attempts = options.attempts || 3;
  const baseDelayMs = options.baseDelayMs || 2000;
  const job = options.job;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfCancelled(job);

    try {
      const result = await fn();
      throwIfCancelled(job);
      return result;
    } catch (error) {
      if (
        (job && job.cancelled) ||
        error.message === "CANCELLED" ||
        error.code === "UPLOAD_CANCELLED" ||
        error.name === "AbortError" ||
        error.code === "ABORT_ERR"
      ) {
        throw cancellationError();
      }

      lastError = error;

      // Telegram's 413 response is permanent for the same file.
      if (error.message && /Request Entity Too Large|413/.test(error.message)) {
        throw error;
      }

      if (attempt < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(
          `Attempt ${attempt + 1} failed (${error.message}), retrying in ${delay}ms...`
        );
        await sleepWithCancellation(delay, job);
      }
    }
  }

  throw lastError;
}

module.exports = {
  cancellationError,
  throwIfCancelled,
  trackUploadStream,
  sleepWithCancellation,
  withRetry,
};
