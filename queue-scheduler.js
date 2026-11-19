"use strict";

const { createSemaphore } = require("./global-semaphore");

/**
 * Runs at most one worker per chat and limits total concurrent workers.
 * Queues and active-job tracking are injected so the scheduler can be
 * tested without Telegram, yt-dlp, or production services.
 */
function createQueueScheduler({
  jobQueues,
  activeJobs,
  processJob,
  maxActive = 3,
  onError = (err) => console.error("Unhandled error in processJob:", err.message),
}) {
  if (!(jobQueues instanceof Map) || !(activeJobs instanceof Map)) {
    throw new TypeError("jobQueues and activeJobs must be Maps");
  }
  if (typeof processJob !== "function") {
    throw new TypeError("processJob must be a function");
  }

  const semaphore = createSemaphore(maxActive);
  const runningQueues = new Set();

  async function runQueue(chatId) {
    if (runningQueues.has(chatId)) return;

    runningQueues.add(chatId);
    const queue = jobQueues.get(chatId) || [];

    try {
      while (queue.length > 0) {
        const releaseSlot = await semaphore.acquire();

        // The queue may have been cleared while this runner waited.
        if (queue.length === 0) {
          releaseSlot();
          break;
        }

        const item = queue.shift();

        try {
          await processJob(
            item.ctx,
            item.url,
            item.audioMode,
            item.quality,
            item.clip
          );
        } catch (err) {
          try {
            onError(err, chatId, item);
          } catch {
            // Logging must not break slot release or queue cleanup.
          }
        } finally {
          activeJobs.delete(chatId);
          releaseSlot();
        }
      }
    } finally {
      runningQueues.delete(chatId);

      if (jobQueues.get(chatId) === queue) {
        jobQueues.delete(chatId);
      }

      // Handle an enqueue that lands as this runner is shutting down.
      if ((jobQueues.get(chatId) || []).length > 0) {
        void runQueue(chatId);
      }
    }
  }

  return {
    runQueue,
    isRunning: (chatId) => runningQueues.has(chatId),
    runningQueues,
    semaphore,
  };
}

module.exports = { createQueueScheduler };
