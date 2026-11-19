"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry } = require("../upload-lifecycle");

function makeJob() {
  return {
    cancelled: false,
    abortController: new AbortController(),
  };
}

test("does not start an upload attempt when the job is already cancelled", async () => {
  const job = makeJob();
  job.cancelled = true;
  let attempts = 0;

  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
    }, { job, attempts: 3, baseDelayMs: 1 }),
    (error) => error.message === "CANCELLED"
  );

  assert.equal(attempts, 0);
});

test("cancellation during retry backoff prevents the next attempt promptly", async () => {
  const job = makeJob();
  let attempts = 0;

  const retrying = withRetry(async () => {
    attempts += 1;
    throw new Error("temporary upload failure");
  }, { job, attempts: 3, baseDelayMs: 5000 });

  // Allow the first attempt to fail and the retry delay to begin.
  await new Promise((resolve) => setImmediate(resolve));
  job.cancelled = true;
  job.abortController.abort();

  await assert.rejects(
    retrying,
    (error) => error.message === "CANCELLED"
  );

  assert.equal(attempts, 1);
});

test("does not retry an aborted upload", async () => {
  const job = makeJob();
  let attempts = 0;

  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }, { job, attempts: 3, baseDelayMs: 1 }),
    (error) => error.message === "CANCELLED"
  );

  assert.equal(attempts, 1);
});

test("does not retry a Telegram 413 response", async () => {
  const job = makeJob();
  let attempts = 0;

  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
      throw new Error("Request Entity Too Large (413)");
    }, { job, attempts: 3, baseDelayMs: 1 }),
    /Request Entity Too Large/
  );

  assert.equal(attempts, 1);
});

test("retries a temporary error and returns a later successful result", async () => {
  const job = makeJob();
  let attempts = 0;

  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return "sent";
  }, { job, attempts: 3, baseDelayMs: 1 });

  assert.equal(result, "sent");
  assert.equal(attempts, 2);
});

test("destroys the upload stream when its signal is aborted", () => {
  const { EventEmitter } = require("node:events");
  const { trackUploadStream } = require("../upload-lifecycle");

  class FakeStream extends EventEmitter {
    destroyed = false;
    destroyCalls = 0;

    destroy() {
      this.destroyed = true;
      this.destroyCalls += 1;
    }
  }

  const controller = new AbortController();
  const stream = new FakeStream();
  const cleanup = trackUploadStream(stream, controller.signal);

  controller.abort();

  assert.equal(stream.destroyed, true);
  assert.equal(stream.destroyCalls, 1);

  cleanup();
  assert.equal(stream.destroyCalls, 1);
});

test("cleans up the upload stream and abort listener when the request settles", () => {
  const { EventEmitter } = require("node:events");
  const { trackUploadStream } = require("../upload-lifecycle");

  class FakeStream extends EventEmitter {
    destroyed = false;
    destroyCalls = 0;

    destroy() {
      this.destroyed = true;
      this.destroyCalls += 1;
    }
  }

  const controller = new AbortController();
  const stream = new FakeStream();
  const cleanup = trackUploadStream(stream, controller.signal);

  cleanup();
  cleanup();

  assert.equal(stream.destroyed, true);
  assert.equal(stream.destroyCalls, 1);

  controller.abort();
  assert.equal(stream.destroyCalls, 1);
});
