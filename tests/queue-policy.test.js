"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_QUEUED_PER_CHAT,
  MAX_QUEUED_GLOBAL,
  MAX_ACTIVE_GLOBAL,
  isQueueAtCapacity,
} = require("../queue-policy");

test("queue limits preserve the intended configured values", () => {
  assert.equal(MAX_QUEUED_PER_CHAT, 5);
  assert.equal(MAX_QUEUED_GLOBAL, 30);
  assert.equal(MAX_ACTIVE_GLOBAL, 3);
});

test("allows a chat below both waiting-queue limits", () => {
  const queues = new Map([[101, Array(4).fill({})], [202, Array(24).fill({})]]);
  assert.equal(isQueueAtCapacity(101, queues), false);
});

test("rejects a chat that already has five waiting links", () => {
  const queues = new Map([[101, Array(5).fill({})]]);
  assert.equal(isQueueAtCapacity(101, queues), true);
});

test("rejects additional work when the global waiting queue has 30 links", () => {
  const queues = new Map([
    [101, Array(15).fill({})],
    [202, Array(15).fill({})],
  ]);
  assert.equal(isQueueAtCapacity(303, queues), true);
});
