"use strict";

const { cancellationError, timeoutError } = require("./process-lifecycle");

async function runWithTimeoutAndCancellation(operation, job, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const label = options.label || "Network request";

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }

  if (job?.cancelled) {
    throw cancellationError();
  }

  const controller = new AbortController();
  const parentSignal = job?.abortController?.signal;
  let timedOut = false;

  const onAbort = () => controller.abort();

  if (parentSignal?.aborted || job?.cancelled) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await operation(controller.signal);

    if (job?.cancelled || parentSignal?.aborted) {
      throw cancellationError();
    }

    if (timedOut) {
      throw timeoutError(label, timeoutMs);
    }

    return result;
  } catch (error) {
    if (job?.cancelled || parentSignal?.aborted) {
      throw cancellationError();
    }

    if (timedOut) {
      throw timeoutError(label, timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

module.exports = { runWithTimeoutAndCancellation };
