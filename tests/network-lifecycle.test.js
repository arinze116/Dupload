"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runWithTimeoutAndCancellation } = require("../network-lifecycle");

function abortAwareOperation(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
}

test("rejects before starting a request for a cancelled job", async () => {
  const job = { cancelled: true };
  let started = false;

  await assert.rejects(
    runWithTimeoutAndCancellation(
      async () => {
        started = true;
      },
      job,
      { timeoutMs: 100 },
    ),
    (error) => error.code === "PROCESS_CANCELLED",
  );

  assert.equal(started, false);
});

test("aborts and reports a timed-out network operation", async () => {
  await assert.rejects(
    runWithTimeoutAndCancellation(
      (signal) => abortAwareOperation(signal),
      null,
      { timeoutMs: 50, label: "test API" },
    ),
    (error) => (
      error.code === "PROCESS_TIMEOUT" &&
      /test API timed out after 50ms/.test(error.message)
    ),
  );
});

test("parent cancellation aborts a network operation promptly", async () => {
  const controller = new AbortController();
  const job = { cancelled: false, abortController: controller };

  const request = runWithTimeoutAndCancellation(
    (signal) => abortAwareOperation(signal),
    job,
    { timeoutMs: 3000 },
  );

  controller.abort();

  await assert.rejects(
    request,
    (error) => error.code === "PROCESS_CANCELLED",
  );
});

test("cleans up after a successful network operation", async () => {
  const result = await runWithTimeoutAndCancellation(
    async (signal) => {
      assert.equal(signal.aborted, false);
      return { ok: true };
    },
    null,
    { timeoutMs: 1000 },
  );

  assert.deepEqual(result, { ok: true });
});
