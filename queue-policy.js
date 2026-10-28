"use strict";

const MAX_QUEUED_PER_CHAT = 5;
const MAX_QUEUED_GLOBAL = 30;
const MAX_ACTIVE_GLOBAL = 3;

function isQueueAtCapacity(chatId, jobQueues) {
  const totalQueued = [...jobQueues.values()].reduce(
    (total, queue) => total + queue.length,
    0
  );

  return (
    (jobQueues.get(chatId) || []).length >= MAX_QUEUED_PER_CHAT ||
    totalQueued >= MAX_QUEUED_GLOBAL
  );
}

module.exports = {
  MAX_QUEUED_PER_CHAT,
  MAX_QUEUED_GLOBAL,
  MAX_ACTIVE_GLOBAL,
  isQueueAtCapacity,
};
