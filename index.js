require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { fetchVideo, downloadAudio, getVideoInfo, cleanup, MAX_FILE_SIZE_MB } = require('./downloader');
const analytics = require('./analytics');

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env file. Get one from @BotFather and add it.');
  process.exit(1);
}

const LOCAL_API_URL = process.env.LOCAL_API_URL;
if (!LOCAL_API_URL) {
  console.error('Missing LOCAL_API_URL in .env. Set it to your local Bot API base URL, e.g. http://127.0.0.1:8081');
  process.exit(1);
}

const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : null;
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '10', 10);
const userRequestLog = new Map(); // userId -> array of timestamps

const localAgent = new http.Agent({
  keepAlive: true,
});

async function sendVideoDirect(chatId, filePath) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', fs.createReadStream(filePath));

  const res = await fetch(`${LOCAL_API_URL}/bot${BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    body: form,
    agent: localAgent,
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'Telegram API returned an error');
  }
  return data;
}

async function sendAudioDirect(chatId, filePath) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('audio', fs.createReadStream(filePath));

  const res = await fetch(`${LOCAL_API_URL}/bot${BOT_TOKEN}/sendAudio`, {
    method: 'POST',
    body: form,
    agent: localAgent,
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'Telegram API returned an error');
  }
  return data;
}

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 9000000,
  telegram: {
    apiRoot: LOCAL_API_URL,
  },
});

// Recover analytics records left in progress by a previous bot process.
analytics.recoverStaleDownloads();

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

// Track every Telegram user who interacts with the bot.
bot.use(async (ctx, next) => {
  try {
    if (ctx.from?.id) {
      analytics.trackUser(ctx.from.id);
    }
  } catch (err) {
    console.error('Analytics user tracking failed:', err.message);
  }

  return next();
});

function detectPlatform(url) {
  if (/tiktok\.com|vm\.tiktok/i.test(url)) return 'TikTok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/twitter\.com|x\.com/i.test(url)) return 'X (Twitter)';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'Facebook';
  if (/reddit\.com|redd\.it/i.test(url)) return 'Reddit';
  if (/pinterest\.com|pin\.it/i.test(url)) return 'Pinterest';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  if (/twitch\.tv/i.test(url)) return 'Twitch';
  return null;
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function isRateLimited(userId) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const timestamps = (userRequestLog.get(userId) || []).filter(
    (t) => now - t < windowMs
  );
  userRequestLog.set(userId, timestamps);

  if (timestamps.length >= RATE_LIMIT_PER_HOUR) {
    return true;
  }

  timestamps.push(now);
  userRequestLog.set(userId, timestamps);
  return false;
}

function isAdmin(ctx) {
  return ADMIN_ID && ctx.from.id === ADMIN_ID;
}

// --- Job tracking and queue ---
// job shape: { jobId, cancelled, proc (yt-dlp child process, if active) }
const activeJobs = new Map();  // chatId -> job
const jobQueues = new Map();   // chatId -> Array of { url, ctx, audioMode, quality }

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
async function processJob(ctx, url, audioMode = false, quality = null) {
  const chatId = ctx.chat.id;
  const jobId = crypto.randomBytes(6).toString('hex');
  const job = { jobId, cancelled: false, proc: null };
  const analyticsDownloadId = analytics.startDownload(ctx.from?.id || chatId);
  activeJobs.set(chatId, job);

  const platform = detectPlatform(url);
  const platformStr = platform ? ` from ${platform}` : '';

  const statusMsg = await ctx.reply(
    audioMode
      ? `Extracting audio${platformStr}...`
      : quality
        ? `Fetching your video${platformStr} at ${quality}...`
        : `Fetching your video${platformStr}, this can take a moment depending on size and quality.`
  );

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
      analytics.finishDownload(analyticsDownloadId, 'cancelled');
      await updateStatus('Download cancelled.');
      return;
    }

    result = await fetchVideo(url, jobId, job, onProgress, audioMode, quality);

    if (job.cancelled) {
      cleanup(result && result.filePath);
      analytics.finishDownload(analyticsDownloadId, 'cancelled');
      await updateStatus('Download cancelled.');
      return;
    }

  } catch (err) {
    if (err.message === 'CANCELLED' || job.cancelled) {
      analytics.finishDownload(analyticsDownloadId, 'cancelled');
      await updateStatus('Download cancelled.');
      return;
    }

    analytics.finishDownload(analyticsDownloadId, 'failed');
    console.error(`[${jobId}] Download failed:`, err.message);
    await updateStatus('Could not download that video. The link may be private, region-locked, or from an unsupported platform.');
    return;
  }

  if (result.wasCompressed) {
    await updateStatus(`Video was over ${MAX_FILE_SIZE_MB}MB, compressed to ~${result.finalSizeMB.toFixed(1)}MB. Uploading now...`);
  } else {
    await updateStatus(audioMode ? 'Got it. Sending audio file...' : 'Got it. Uploading now...');
  }

  try {
    if (audioMode) {
      await withRetry(() => sendAudioDirect(chatId, result.filePath));
    } else {
      await withRetry(() => sendVideoDirect(chatId, result.filePath));
    }

    const fileSizeMB = fs.statSync(result.filePath).size / (1024 * 1024);

    analytics.finishDownload(
      analyticsDownloadId,
      'completed',
      fileSizeMB
    );
  } catch (err) {
    analytics.finishDownload(analyticsDownloadId, 'failed');

    console.error(`[${jobId}] Send failed after retries:`, err.message);
    await ctx.reply('Downloaded the file but the upload to Telegram kept failing. Try again or switch networks.');
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
    const { url, ctx, audioMode, quality } = queue.shift();
    try {
      await processJob(ctx, url, audioMode, quality);
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
    "Send me a video link from YouTube, TikTok, Instagram, X, Facebook, Reddit, Pinterest, or most other platforms and I'll download it.\n\nFor audio only, add the word 'audio' to your message.\nExample: audio https://youtu.be/xxx\n\n/stop — cancel current download\n/queue — check download queue\n/info <url> — preview video info before downloading"
  );
});

bot.help((ctx) => {
  ctx.reply(
    "Paste any video link and I'll fetch the best quality available.\n\nFor audio only, add the word 'audio' to your message.\nExample: audio https://youtu.be/xxx\n\n/stop — cancel current download\n/queue — check download queue\n/info <url> — preview video info before downloading"
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

bot.command('info', async (ctx) => {
  const text = ctx.message.text;
  const match = text.match(URL_REGEX);

  if (!match) {
    return ctx.reply('Usage: /info <url>\nExample: /info https://youtu.be/xxxxx');
  }

  const url = match[1];
  const waitMsg = await ctx.reply('Fetching video info...');

  try {
    const info = await getVideoInfo(url);
    const lines = [
      `📹 *${escapeMarkdown(info.title)}*`,
      `👤 ${escapeMarkdown(info.uploader || 'Unknown')}`,
      `⏱ ${formatDuration(info.duration)}`,
      `📐 Available: ${info.formats.join(', ')}`,
    ];
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      undefined,
      lines.join('\n'),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitMsg.message_id,
      undefined,
      'Could not fetch info for that URL. It may be private or unsupported.'
    );
  }
});

bot.command('stats', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Unknown command.');

  try {
    const stats = analytics.getStats();

    const totalGB = stats.totalDataMB >= 1024
      ? `${(stats.totalDataMB / 1024).toFixed(2)} GB`
      : `${stats.totalDataMB.toFixed(2)} MB`;

    const activeCount = activeJobs.size;
    const queuedCount = [...jobQueues.values()].reduce(
      (sum, q) => sum + q.length,
      0
    );

    ctx.reply(
      `📊 Dupload Stats\n\n` +
      `Users\n` +
      `Total: ${stats.totalUsers}\n` +
      `New today: ${stats.newUsersToday}\n` +
      `New this week: ${stats.newUsersThisWeek}\n` +
      `New this month: ${stats.newUsersThisMonth}\n` +
      `Active today: ${stats.activeToday}\n` +
      `Active this week: ${stats.activeThisWeek}\n` +
      `Active this month: ${stats.activeThisMonth}\n\n` +
      `Downloads\n` +
      `Total attempts: ${stats.totalDownloads}\n` +
      `Successful: ${stats.successfulDownloads}\n` +
      `Failed: ${stats.failedDownloads}\n` +
      `Cancelled: ${stats.cancelledDownloads}\n` +
      `Interrupted: ${stats.interruptedDownloads}\n` +
      `In progress: ${stats.inProgressDownloads}\n\n` +
      `Data delivered\n` +
      `${totalGB}\n\n` +
      `Runtime\n` +
      `Active jobs: ${activeCount}\n` +
      `Queued jobs: ${queuedCount}\n` +
      `Rate limit: ${RATE_LIMIT_PER_HOUR}/hour per user\n\n` +
      `Timezone: ${stats.timezone}`
    );
  } catch (err) {
    console.error('Stats command failed:', err.message);
    ctx.reply('Could not load statistics.');
  }
});

bot.command('cleardownloads', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Unknown command.');

  const downloadDir = process.env.DOWNLOAD_DIR || './downloads';
  const files = fs.readdirSync(downloadDir);
  let deleted = 0;

  for (const f of files) {
    try {
      fs.unlinkSync(path.join(downloadDir, f));
      deleted++;
    } catch {
      // skip locked files
    }
  }

  ctx.reply(`Cleared ${deleted} file(s) from downloads/.`);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const match = text.match(URL_REGEX);

  if (!match) {
    return ctx.reply("That doesn't look like a link. Paste a video URL from a supported platform.");
  }

  const userId = ctx.from.id;
  if (isRateLimited(userId)) {
    return ctx.reply(
      `You've reached the limit of ${RATE_LIMIT_PER_HOUR} downloads per hour. Please wait before sending more links.`
    );
  }

  const url = match[1];
  const audioMode = /\baudio\b/i.test(text);
  const qualityMatch = text.match(/\b(360p|480p|720p|1080p)\b/i);
  const quality = qualityMatch ? qualityMatch[1].toLowerCase() : null;

  const chatId = ctx.chat.id;
  const isActive = activeJobs.has(chatId);
  const queue = jobQueues.get(chatId) || [];

  if (isActive) {
    queue.push({ url, ctx, audioMode, quality });
    jobQueues.set(chatId, queue);
    return ctx.reply(`Added to queue (position ${queue.length}). Send /stop to cancel the current download.`);
  }

  queue.push({ url, ctx, audioMode, quality });
  jobQueues.set(chatId, queue);
  runQueue(chatId);
});

bot.launch({ dropPendingUpdates: true });
console.log('Bot is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
