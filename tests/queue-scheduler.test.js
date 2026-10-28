"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createQueueScheduler } = require("../queue-scheduler");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeItem(chatId, url) {
  return {
    url,
    ctx: { chat: { id: chatId } },
    audioMode: false,
    quality: null,
    clip: null,
  };
}

async function until(predicate, description) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

test("limits global concurrency to the configured maximum", async () => {
  const jobQueues = new Map();
  const activeJobs = new Map();
  const gates = [];
  let active = 0;
  let peak = 0;
  let started = 0;

  const scheduler = createQueueScheduler({
    jobQueues,
    activeJobs,
    maxActive: 3,
    processJob: async () => {
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
    },
  });

  for (let id = 1; id <= 4; id += 1) {
    jobQueues.set(id, [makeItem(id, `https://example.test/${id}`)]);
  }

  const runners = [1, 2, 3, 4].map((id) => scheduler.runQueue(id));

  await until(() => started === 3, "three workers to start");
  assert.equal(peak, 3);
  assert.equal(scheduler.semaphore.activeCount(), 3);
  assert.equal(scheduler.semaphore.waitingCount(), 1);

  gates[0].resolve();
  await until(() => started === 4, "fourth worker to start");

  for (const gate of gates) gate.resolve();
  await Promise.all(runners);

  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(scheduler.semaphore.activeCount(), 0);
});

test("never runs two jobs from the same chat concurrently", async () => {
  const jobQueues = new Map([
    [42, [
      makeItem(42, "https://example.test/first"),
      makeItem(42, "https://example.test/second"),
    ]],
  ]);
  const activeJobs = new Map();
  const firstGate = deferred();
  const started = [];

  const scheduler = createQueueScheduler({
    jobQueues,
    activeJobs,
    maxActive: 3,
    processJob: async (_ctx, url) => {
      started.push(url);
      if (url.endsWith("/first")) await firstGate.promise;
    },
  });

  const runner = scheduler.runQueue(42);
  await until(() => started.length === 1, "first chat job to start");
  assert.equal(started[0], "https://example.test/first");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);

  firstGate.resolve();
  await runner;

  assert.deepEqual(started, [
    "https://example.test/first",
    "https://example.test/second",
  ]);
  assert.equal(scheduler.isRunning(42), false);
});

test("does not run queued work cleared while waiting for a global slot", async () => {
  const jobQueues = new Map();
  const activeJobs = new Map();
  const gates = [];
  const startedChats = [];

  const scheduler = createQueueScheduler({
    jobQueues,
    activeJobs,
    maxActive: 3,
    processJob: async (ctx) => {
      startedChats.push(ctx.chat.id);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    },
  });

  for (let id = 1; id <= 3; id += 1) {
    jobQueues.set(id, [makeItem(id, `https://example.test/${id}`)]);
  }
  jobQueues.set(4, [makeItem(4, "https://example.test/4")]);

  const runners = [1, 2, 3, 4].map((id) => scheduler.runQueue(id));

  await until(() => startedChats.length === 3, "three slots to become occupied");
  await until(
    () => scheduler.semaphore.waitingCount() === 1,
    "fourth chat to wait for a slot"
  );

  // Simulate /stop clearing a queue while its runner awaits a slot.
  jobQueues.get(4).length = 0;

  gates[0].resolve();
  await until(
    () => scheduler.semaphore.waitingCount() === 0,
    "cancelled waiter to release its acquired slot"
  );

  for (const gate of gates) gate.resolve();
  await Promise.all(runners);

  assert.equal(startedChats.includes(4), false);
  assert.equal(scheduler.semaphore.activeCount(), 0);
});

test("worker failures do not leak slots or prevent later queued work", async () => {
  const jobQueues = new Map([
    [9, [
      makeItem(9, "https://example.test/fails"),
      makeItem(9, "https://example.test/succeeds"),
    ]],
  ]);
  const activeJobs = new Map();
  const errors = [];
  const completed = [];

  const scheduler = createQueueScheduler({
    jobQueues,
    activeJobs,
    onError: (err) => errors.push(err.message),
    processJob: async (_ctx, url) => {
      if (url.endsWith("/fails")) throw new Error("expected test failure");
      completed.push(url);
    },
  });

  await scheduler.runQueue(9);

  assert.deepEqual(errors, ["expected test failure"]);
  assert.deepEqual(completed, ["https://example.test/succeeds"]);
  assert.equal(scheduler.semaphore.activeCount(), 0);
  assert.equal(scheduler.isRunning(9), false);
});

test("picks up a job enqueued while the current job is running", async () => {
  const firstGate = deferred();
  const jobQueues = new Map([
    [77, [makeItem(77, "https://example.test/first")]],
  ]);
  const activeJobs = new Map();
  const started = [];

  const scheduler = createQueueScheduler({
    jobQueues,
    activeJobs,
    processJob: async (_ctx, url) => {
      started.push(url);
      if (url.endsWith("/first")) await firstGate.promise;
    },
  });

  const runner = scheduler.runQueue(77);
  await until(() => started.length === 1, "first job to start");

  // Simulate a new message arriving while processJob is still awaiting.
  jobQueues.get(77).push(makeItem(77, "https://example.test/second"));
  firstGate.resolve();

  await runner;

  assert.deepEqual(started, [
    "https://example.test/first",
    "https://example.test/second",
  ]);
  assert.equal(scheduler.semaphore.activeCount(), 0);
  assert.equal(scheduler.isRunning(77), false);
});
