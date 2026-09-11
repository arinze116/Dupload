require('dotenv').config();
const { Telegraf } = require('telegraf');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { fetchVideo, cleanup, MAX_FILE_SIZE_MB } = require('./downloader');

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env file. Get one from @BotFather and add it.');
  process.exit(1);
}

// Forces HTTP/1.1 for Telegram uploads — HTTP/2 causes "socket hang up" on
// this Termux/Android setup. Confirmed via curl testing. Bypasses Telegraf's
// internal HTTP client which doesn't reliably accept a custom agent.
const http1Agent = new https.Agent({
  keepAlive: true,
  ALPNProtocols: ['http/1.1'],
});

async function sendVideoDirect(chatId, filePath) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', fs.createReadStream(filePath));

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    body: form,
    agent: http1Agent,
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'Telegram API returned an error');
  }
  return data;
}

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 9000000,
});

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

// --- Job tracking and queue ---
// job shape: { jobId, cancelled, proc (yt-dlp child process, if active) }
const activeJobs = new Map();  // chatId -> job
const jobQueues = new Map();   // chatId -> Array of { url, ctx }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, options) {
  const attempts = (options && options.attempts) || 3;
  const baseDelayMs = (options && options.baseDelayMs) || 2000;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // 413 means Telegram rejected the request because the upload is too large.
      // Retrying the same file will not fix a permanent size error.
      if (err.message && /Request Entity Too Large|413/.test(err.message)) {
        throw err;
      }

      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        console.log(`Attempt ${i + 1} failed (${err.message}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

/**
 * Processes a single download job.
 * The job object is shared with /stop so it can cancel immediately by:
 * 1. Setting job.cancelled = true
 * 2. Killing job.proc (the yt-dlp child process) if it's running
 */
async function processJob(ctx, url) {
  const chatId = ctx.chat.id;
  const jobId = crypto.randomBytes(6).toString('hex');
  const job = { jobId, cancelled: false, proc: null };
  activeJobs.set(chatId, job);

  const statusMsg = await ctx.reply('Fetching your video, this can take a moment depending on size and quality.');

  // Helper to safely edit the status message
  async function updateStatus(text) {
    try {
      await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text);
    } catch (err) {
      // Ignore edit errors (message may have been deleted etc.)
    }
  }

  // Progress callback passed into downloader so the user gets live updates
  async function onProgress(text) {
    if (!job.cancelled) await updateStatus(text);
  }

  let result;
  try {
    if (job.cancelled) {
      await updateStatus('Download cancelled.');
      return;
    }

    result = await fetchVideo(url, jobId, job, onProgress);

    if (job.cancelled) {
      cleanup(result && result.filePath);
      await updateStatus('Download cancelled.');
      return;
    }

  } catch (err) {
    if (err.message === 'CANCELLED' || job.cancelled) {
      await updateStatus('Download cancelled.');
      return;
    }
    console.error(`[${jobId}] Download failed:`, err.message);
    await updateStatus('Could not download that video. The link may be private, region-locked, or from an unsupported platform.');
    return;
  }

  if (result.wasCompressed) {
    await updateStatus(`Video was over ${MAX_FILE_SIZE_MB}MB, compressed to ~${result.finalSizeMB.toFixed(1)}MB. Uploading now...`);
  } else {
    await updateStatus('Got it. Uploading now...');
  }

  try {
    await withRetry(() => sendVideoDirect(chatId, result.filePath));
  } catch (err) {
    console.error(`[${jobId}] Send failed after retries:`, err.message);
    await ctx.reply('Downloaded the video but the upload to Telegram kept failing. Try again or switch networks.');
  } finally {
    cleanup(result.filePath);
  }
}

/**
 * Runs the queue for a chat, one job at a time.
 */
async function runQueue(chatId) {
  const queue = jobQueues.get(chatId) || [];

  while (queue.length > 0) {
    const { url, ctx } = queue.shift();
    try {
      await processJob(ctx, url);
    } catch (err) {
      console.error('Unhandled error in processJob:', err.message);
    } finally {
      activeJobs.delete(chatId);
    }
  }

  jobQueues.delete(chatId);
}

// --- Commands ---

bot.start((ctx) => {
  ctx.reply(
    "Send me a video link from X, Facebook, Instagram, Pinterest, TikTok, Reddit, YouTube, or most other platforms and I'll download it for you.\n\n/stop — cancel current download\n/queue — check download queue"
  );
});

bot.help((ctx) => {
  ctx.reply(
    "Paste any video link and I'll fetch the best quality available, compressing if needed to fit Telegram's 50MB bot limit.\n\n/stop — cancel the current download\n/queue — see how many links are queued"
  );
});

bot.command('stop', (ctx) => {
  const chatId = ctx.chat.id;
  const job = activeJobs.get(chatId);
  const queue = jobQueues.get(chatId) || [];

  if (!job && queue.length === 0) {
    return ctx.reply('No active download to stop.');
  }

  if (job) {
    job.cancelled = true;
    // Kill the yt-dlp child process immediately if it's running
    if (job.proc) {
      try {
        job.proc.kill('SIGKILL');
      } catch (err) {
        // Process may have already exited
      }
    }
  }

  // Clear the queue
  jobQueues.set(chatId, []);

  const queueMsg = queue.length > 0 ? ` and cleared ${queue.length} queued link(s)` : '';
  ctx.reply(`Download stopped${queueMsg}.`);
});

bot.command('queue', (ctx) => {
  const chatId = ctx.chat.id;
  const queue = jobQueues.get(chatId) || [];
  const active = activeJobs.get(chatId);

  if (!active && queue.length === 0) {
    return ctx.reply('No active downloads or queued links.');
  }

  const lines = [];
  if (active) lines.push('Downloading: 1 in progress');
  if (queue.length > 0) lines.push(`Queued: ${queue.length} link(s) waiting`);
  ctx.reply(lines.join('\n'));
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const match = text.match(URL_REGEX);

  if (!match) {
    return ctx.reply("That doesn't look like a link. Paste a video URL from a supported platform.");
  }

  const url = match[1];
  const chatId = ctx.chat.id;
  const isActive = activeJobs.has(chatId);
  const queue = jobQueues.get(chatId) || [];

  if (isActive) {
    queue.push({ url, ctx });
    jobQueues.set(chatId, queue);
    return ctx.reply(`Added to queue (position ${queue.length}). Send /stop to cancel the current download.`);
  }

  queue.push({ url, ctx });
  jobQueues.set(chatId, queue);
  runQueue(chatId);
});

bot.launch({ dropPendingUpdates: true });
console.log('Bot is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
