const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { trackChildProcess, cancellationError } = require('./process-lifecycle');
const { runWithTimeoutAndCancellation } = require('./network-lifecycle');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const MAX_FILE_SIZE_MB = parseFloat(process.env.MAX_FILE_SIZE_MB || '50');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function buildProgressBar(pct) {
  const filled = Math.floor(pct / 10);
  const empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function qualityToFormatSelector(quality) {
  const heightMap = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080 };
  const h = heightMap[quality];
  if (!h) return null;
  // Prefer h264 at the requested height; fall back to any codec at that height;
  // fall back to best available below that height
  return (
    `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[ext=m4a]` +
    `/bestvideo[height<=${h}][vcodec^=avc]+bestaudio` +
    `/bestvideo[height<=${h}]+bestaudio` +
    `/best[height<=${h}]` +
    `/bestvideo+bestaudio` +
    `/best`
  );
}

function runCommand(command, args, job, options = {}) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(cancellationError());

    let proc;
    try {
      proc = spawn(command, args);
    } catch (error) {
      reject(error);
      return;
    }

    const tracking = trackChildProcess(proc, job, {
      timeoutMs: options.timeoutMs || 10 * 60 * 1000,
      label: options.label || command,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.once('close', (code) => {
      if (job && job.cancelled) return reject(cancellationError());
      if (tracking.timedOut) return reject(tracking.timeoutError());

      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });

    proc.once('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Checks whether a media file actually contains an audio stream.
 * Some TikTok CDN variants claim an audio codec in their metadata but
 * are silent in practice — this catches that.
 */
function hasAudioStream(filePath, job) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(cancellationError());

    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ]);

    const tracking = trackChildProcess(proc, job, {
      timeoutMs: 30_000,
      label: 'ffprobe audio-stream check',
    });

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.once('close', () => {
      if (job && job.cancelled) return reject(cancellationError());
      if (tracking.timedOut) return reject(tracking.timeoutError());
      resolve(stdout.trim().length > 0);
    });

    proc.once('error', (error) => {
      if (job && job.cancelled) return reject(cancellationError());
      // Preserve the existing fail-open behavior for ordinary probe errors.
      console.error('Audio-stream probe failed:', error.message);
      resolve(true);
    });
  });
}

/**
 * Downloads a video from any yt-dlp supported URL.
 * Returns the absolute path to the downloaded file.
 *
 * @param {string} url
 * @param {string} jobId
 * @param {object} job - job object with a `cancelled` flag and optional `proc` reference
 * @param {function} onProgress - called periodically with a status string during download
 * @param {string|null} quality - optional resolution request (e.g. '720p')
 */
async function downloadVideo(url, jobId, job, onProgress, quality = null) {
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok');
  const formatSelector = quality
    ? qualityToFormatSelector(quality)
    : 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio/best';

  const args = [
    '-f', formatSelector,
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--newline',
    ...(isTikTok ? [
      '--impersonate', 'chrome',
      '--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com',
    ] : []),
    '-o', outputTemplate,
    url,
  ];

  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(cancellationError());
    const proc = spawn('yt-dlp', args);
    const tracking = trackChildProcess(proc, job, {
      timeoutMs: 15 * 60 * 1000,
      label: 'yt-dlp video download',
    });

    let stderr = '';
    let lastProgressUpdate = 0;
    let lastPct = 0;
    let progressTimer = null;

    if (onProgress) {
      progressTimer = setInterval(() => {
        if (job && job.cancelled) return;
        const now = Date.now();
        if (now - lastProgressUpdate > 20000) {
          onProgress('Still downloading, please wait...');
          lastProgressUpdate = now;
        }
      }, 20000);
    }

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const match = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+)(MiB|GiB)/);
        if (match && onProgress) {
          const pct = parseFloat(match[1]);
          const size = parseFloat(match[2]);
          const unit = match[3];
          const now = Date.now();

          if (now - lastProgressUpdate >= 5000 || pct >= 99) {
            lastPct = pct;
            lastProgressUpdate = now;

            const bar = buildProgressBar(pct);
            onProgress(`Downloading...\n${bar} ${Math.floor(pct)}%\nSize: ~${size} ${unit}`);
          }
        }
      }
    });

    proc.stderr.on('data', (data) => (stderr += data.toString()));

    proc.on('close', (code) => {
      if (progressTimer) clearInterval(progressTimer);

      if (job && job.cancelled) return reject(cancellationError());
      if (tracking.timedOut) return reject(tracking.timeoutError());

      if (code === 0) {
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(
          (f) => f.startsWith(jobId) && !f.endsWith('.part')
        );
        if (files.length === 0) {
          return reject(new Error('Download completed but no output file was found.'));
        }
        resolve(path.join(DOWNLOAD_DIR, files[0]));
      } else {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (progressTimer) clearInterval(progressTimer);
      reject(err);
    });
  });
}

/**
 * Downloads audio-only format from URL as MP3.
 */
async function downloadAudio(url, jobId, job, onProgress) {
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}.mp3`);

  const args = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--newline',
    '-o', outputPath,
    url,
  ];

  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(cancellationError());
    const proc = spawn('yt-dlp', args);
    const tracking = trackChildProcess(proc, job, {
      timeoutMs: 15 * 60 * 1000,
      label: 'yt-dlp audio download',
    });

    let stderr = '';
    let lastProgressUpdate = 0;
    let lastPct = 0;
    let progressTimer = null;

    if (onProgress) {
      progressTimer = setInterval(() => {
        if (job && job.cancelled) return;
        const now = Date.now();
        if (now - lastProgressUpdate > 20000) {
          onProgress('Still extracting audio, please wait...');
          lastProgressUpdate = now;
        }
      }, 20000);
    }

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const match = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+)(MiB|GiB)/);
        if (match && onProgress) {
          const pct = parseFloat(match[1]);
          const size = parseFloat(match[2]);
          const unit = match[3];
          const now = Date.now();

          if (now - lastProgressUpdate >= 5000 || pct >= 99) {
            lastPct = pct;
            lastProgressUpdate = now;

            const bar = buildProgressBar(pct);
            onProgress(`Extracting audio...\n${bar} ${Math.floor(pct)}%\nSize: ~${size} ${unit}`);
          }
        }
      }
    });

    proc.stderr.on('data', (data) => (stderr += data.toString()));

    proc.on('close', (code) => {
      if (progressTimer) clearInterval(progressTimer);

      if (job && job.cancelled) return reject(cancellationError());
      if (tracking.timedOut) return reject(tracking.timeoutError());

      if (code === 0) {
        // yt-dlp may append .mp3 to the output path or not — find it
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(
          (f) => f.startsWith(jobId) && f.endsWith('.mp3') && !f.endsWith('.part')
        );
        if (files.length === 0) return reject(new Error('Audio extraction completed but no MP3 found.'));
        resolve(path.join(DOWNLOAD_DIR, files[0]));
      } else {
        reject(new Error(stderr || `yt-dlp audio exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (progressTimer) clearInterval(progressTimer);
      reject(err);
    });
  });
}

/**
 * Fixes the case where the downloaded video has no real audio track
 * (a known TikTok CDN quirk). Downloads TikTok's official watermarked
 * "download" format separately, takes only its audio, and muxes it onto
 * the already-downloaded high-quality no-watermark video.
 */
async function fixMissingAudio(videoPath, url, jobId, job) {
  const audioSourcePath = path.join(DOWNLOAD_DIR, `${jobId}_audiosrc.mp4`);
  const muxedPath = path.join(DOWNLOAD_DIR, `${jobId}_muxed.mp4`);

  await runCommand('yt-dlp', [
    '-f', 'download',
    '--no-playlist',
    '-o', audioSourcePath,
    url,
  ], job);

  await runCommand('ffmpeg', [
    '-i', videoPath,
    '-i', audioSourcePath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    '-y',
    muxedPath,
  ], job);

  cleanup(videoPath);
  cleanup(audioSourcePath);

  return muxedPath;
}

function getFileSizeMB(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size / (1024 * 1024);
}

async function getMediaDuration(filePath, job) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(cancellationError());

    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    const tracking = trackChildProcess(proc, job, {
      timeoutMs: 30_000,
      label: 'ffprobe media duration',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.once('close', (code) => {
      if (job && job.cancelled) return reject(cancellationError());
      if (tracking.timedOut) return reject(tracking.timeoutError());
      if (code !== 0) {
        return reject(new Error(stderr || 'ffprobe duration check failed'));
      }

      const duration = parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration < 0) {
        return reject(new Error('Could not determine media duration.'));
      }

      resolve(duration);
    });

    proc.once('error', (error) => {
      reject(error);
    });
  });
}

async function clipVideo(inputPath, jobId, job, startSeconds, endSeconds) {
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}_clip.mp4`);
  const duration = endSeconds - startSeconds;

  try {
    await runCommand('ffmpeg', [
      '-ss', String(startSeconds),
      '-i', inputPath,
      '-t', String(duration),
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ], job);

    if (!fs.existsSync(outputPath)) {
      throw new Error('Clip was created but no output file was found.');
    }

    return outputPath;
  } catch (err) {
    cleanup(outputPath);
    throw err;
  }
}

async function compressVideo(inputPath, jobId, job) {
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}_compressed.mp4`);

  const args = [
    '-i', inputPath,
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264',
    '-crf', '28',
    '-preset', 'fast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-y',
    outputPath,
  ];

  await runCommand('ffmpeg', args, job);
  return outputPath;
}

async function downloadTikTokViaAPI(url, jobId, job) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const json = await runWithTimeoutAndCancellation(async (signal) => {
    const response = await fetch(apiUrl, { signal });
    return response.json();
  }, job, {
    timeoutMs: 30_000,
    label: 'TikTok API request',
  });

  if (json.code !== 0 || !json.data?.play) {
    throw new Error(`TikTok API error: ${json.msg || 'No video found'}`);
  }

  const videoUrl = json.data.play; // no watermark
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

  await runCommand('wget', ['-O', outputPath, videoUrl], job);
  return outputPath;
}

/**
 * Fetches video details without downloading media files.
 */
async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--dump-json',
      '--no-playlist',
      '--no-download',
      url,
    ]);

    const tracking = trackChildProcess(proc, null, {
      timeoutMs: 60_000,
      label: 'yt-dlp video metadata',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.once('close', (code) => {
      if (tracking.timedOut) return reject(tracking.timeoutError());
      if (code !== 0) return reject(new Error(stderr || 'yt-dlp info failed'));

      try {
        const data = JSON.parse(stdout);
        const heights = [...new Set(
          (data.formats || [])
            .map((format) => format.height)
            .filter(Boolean)
        )].sort((a, b) => b - a);

        resolve({
          title: data.title || 'Unknown',
          uploader: data.uploader || data.channel || null,
          duration: data.duration || null,
          formats: heights.length > 0 ? heights.map((height) => `${height}p`) : ['unknown'],
        });
      } catch {
        reject(new Error('Failed to parse video info'));
      }
    });

    proc.once('error', reject);
  });
}

/**
 * Full pipeline: download, fix audio if needed, then compress if needed.
 * Returns { filePath, wasCompressed, finalSizeMB }
 */
async function fetchVideoPipeline(
  url,
  jobId,
  job,
  onProgress,
  audioMode = false,
  quality = null,
  clip = null
) {
  if (audioMode) {
    if (clip) {
      throw new Error('CLIP_AUDIO_UNSUPPORTED');
    }

    const audioPath = await downloadAudio(url, jobId, job, onProgress);

    if (job && job.cancelled) {
      cleanup(audioPath);
      throw new Error('CANCELLED');
    }

    const sizeMB = getFileSizeMB(audioPath);

    return {
      filePath: audioPath,
      wasCompressed: false,
      finalSizeMB: sizeMB,
    };
  }

  const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok');

  let originalPath = isTikTok
    ? await downloadTikTokViaAPI(url, jobId, job)
    : await downloadVideo(url, jobId, job, onProgress, quality);

  if (job && job.cancelled) {
    cleanup(originalPath);
    throw new Error('CANCELLED');
  }

  const audioOk = await hasAudioStream(originalPath, job);

  if (!audioOk) {
    if (onProgress) {
      onProgress('Fixing missing audio track...');
    }

    originalPath = await fixMissingAudio(originalPath, url, jobId, job);
  }

  if (clip) {
    const sourcePath = originalPath;

    try {
      const mediaDuration = await getMediaDuration(sourcePath, job);

      if (clip.end > mediaDuration + 0.5) {
        throw new Error(
          `CLIP_END_EXCEEDS_DURATION:${mediaDuration.toFixed(2)}`
        );
      }

      if (job && job.cancelled) {
        throw new Error('CANCELLED');
      }

      if (onProgress) {
        onProgress(
          `Creating clip ${clip.startLabel} → ${clip.endLabel}...`
        );
      }

      const clippedPath = await clipVideo(
        sourcePath,
        jobId,
        job,
        clip.start,
        clip.end
      );

      cleanup(sourcePath);
      originalPath = clippedPath;
    } catch (err) {
      cleanup(sourcePath);
      throw err;
    }
  }

  const originalSizeMB = getFileSizeMB(originalPath);

  if (originalSizeMB <= MAX_FILE_SIZE_MB) {
    return {
      filePath: originalPath,
      wasCompressed: false,
      finalSizeMB: originalSizeMB,
    };
  }

  if (onProgress) {
    onProgress('Video is large, compressing to fit Telegram limits...');
  }

  const compressedPath = await compressVideo(originalPath, jobId, job);
  const compressedSizeMB = getFileSizeMB(compressedPath);

  if (compressedSizeMB > MAX_FILE_SIZE_MB) {
    cleanup(compressedPath);
    cleanup(originalPath);

    throw new Error(
      "Unable to compress video below " + MAX_FILE_SIZE_MB + "MB limit."
    );
  }

  cleanup(originalPath);

  return {
    filePath: compressedPath,
    wasCompressed: true,
    finalSizeMB: compressedSizeMB,
  };
}

async function fetchVideo(
  url,
  jobId,
  job,
  onProgress,
  audioMode = false,
  quality = null,
  clip = null
) {
  try {
    return await fetchVideoPipeline(
      url,
      jobId,
      job,
      onProgress,
      audioMode,
      quality,
      clip
    );
  } catch (error) {
    cleanupJobFiles(jobId);
    throw error;
  }
}

function cleanupJobFiles(jobId) {
  try {
    const prefix = String(jobId);
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(
      (file) => file.startsWith(`${prefix}.`) || file.startsWith(`${prefix}_`)
    );

    for (const file of files) {
      cleanup(path.join(DOWNLOAD_DIR, file));
    }
  } catch (error) {
    // Preserve the original pipeline error if directory cleanup fails.
  }
}

function cleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // ignore cleanup errors
  }
}

module.exports = {
  fetchVideo,
  downloadAudio,
  getVideoInfo,
  getFileSizeMB,
  cleanup,
  MAX_FILE_SIZE_MB,
};
