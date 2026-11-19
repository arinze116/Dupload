"use strict";

function cancellationError() {
  const error = new Error("CANCELLED");
  error.code = "PROCESS_CANCELLED";
  return error;
}

function timeoutError(label, timeoutMs) {
  const error = new Error(
    `${label || "Child process"} timed out after ${timeoutMs}ms`
  );
  error.code = "PROCESS_TIMEOUT";
  return error;
}

function trackChildProcess(proc, job, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const label = options.label || "Child process";

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }

  if (job && !(job.processes instanceof Set)) {
    job.processes = new Set();
  }

  if (job) {
    job.processes.add(proc);
    job.proc = proc;
  }

  const signal = job?.abortController?.signal;
  let timedOut = false;
  let cleaned = false;

  function kill() {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }

    try {
      proc.kill("SIGKILL");
    } catch {
      // The child may have exited between the state check and kill().
    }
  }

  function onAbort() {
    kill();
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;

    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);

    if (job) {
      job.processes.delete(proc);

      if (job.proc === proc) {
        job.proc = [...job.processes].at(-1) || null;
      }
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  timer.unref?.();

  proc.once("close", cleanup);
  proc.once("error", cleanup);

  if (signal) {
    if (signal.aborted || job?.cancelled) {
      kill();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  } else if (job?.cancelled) {
    kill();
  }

  return {
    cleanup,
    get timedOut() {
      return timedOut;
    },
    timeoutError() {
      return timeoutError(label, timeoutMs);
    },
    cancellationError,
  };
}

module.exports = {
  trackChildProcess,
  cancellationError,
  timeoutError,
};
