"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSemaphore } = require("../global-semaphore");

test("semaphore enforces its limit and transfers slots in FIFO order", async () => {
  const semaphore = createSemaphore(2);
  const releaseOne = await semaphore.acquire();
  const releaseTwo = await semaphore.acquire();
  const order = [];

  const thirdPromise = semaphore.acquire().then((release) => {
    order.push("third");
    return release;
  });
  const fourthPromise = semaphore.acquire().then((release) => {
    order.push("fourth");
    return release;
  });

  assert.equal(semaphore.activeCount(), 2);
  assert.equal(semaphore.waitingCount(), 2);

  releaseOne();
  const releaseThree = await thirdPromise;
  assert.deepEqual(order, ["third"]);
  assert.equal(semaphore.activeCount(), 2);
  assert.equal(semaphore.waitingCount(), 1);

  releaseThree();
  const releaseFour = await fourthPromise;
  assert.deepEqual(order, ["third", "fourth"]);
  assert.equal(semaphore.activeCount(), 2);
  assert.equal(semaphore.waitingCount(), 0);

  releaseFour();
  releaseTwo();
  assert.equal(semaphore.activeCount(), 0);
});

test("release is idempotent", async () => {
  const semaphore = createSemaphore(1);
  const release = await semaphore.acquire();

  release();
  release();

  assert.equal(semaphore.activeCount(), 0);
  assert.equal(semaphore.waitingCount(), 0);
});

test("rejects invalid limits", () => {
  assert.throws(() => createSemaphore(0), TypeError);
  assert.throws(() => createSemaphore(1.5), TypeError);
});
