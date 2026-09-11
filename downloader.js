const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const MAX_FILE_SIZE_MB = parseFloat(process.env.MAX_FILE_SIZE_MB || '50');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function runCommand(command, args, job) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    if (job) job.proc = proc;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => (stderr += data.toString()));

    proc.on('close', (code) => {
      if (job && job.proc === proc) job.proc = null;
      if (job && job.cancelled) {
        reject(new Error('CANCELLED'));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (job && job.proc === proc) job.proc = null;
      reject(err);
    });
  });
}

/**
 * Checks whether a media file actually contains an audio stream.
 * Some TikTok CDN variants claim an audio codec in their metadata but
 * are silent in practice — this catches that.
 */
function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ]);
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.on('close', () => resolve(stdout.trim().length > 0));
    proc.on('error', () => resolve(true)); // fail open — don't block on probe errors
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
 */
async function downloadVideo(url, jobId, job, onProgress) {
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  // Format selector priority:
  // 1. h264 video + m4a audio (cleanest merge, works on Facebook, Instagram)
  // 2. h264 video + any audio
  // 3. best video + best audio (covers Reddit, TikTok, Twitter/X, YouTube, etc.)
  // 4. best single pre-muxed stream (last resort)
  // Note: on TikTok this sometimes grabs a variant with audio metadata but
  // no real audio track — handled downstream by hasAudioStream + fixMissingAudio.
  const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok');

  const args = [
    '-f', 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio/best',
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
    const proc = spawn('yt-dlp', args);

    // Store proc reference on the job so /stop can kill it directly
    if (job) job.proc = proc;

    let stderr = '';
    let progressTimer = null;

    // Send a periodic "still working" update every 15 seconds
    if (onProgress) {
      progressTimer = setInterval(() => {
        if (job && job.cancelled) return;
        onProgress('Still downloading, please wait...');
      }, 15000);
    }

    proc.stdout.on('data', (data) => {
      const line = data.toString();
      // Parse yt-dlp's --newline progress output for percentage
      const match = line.match(/(\d+\.\d+)%/);
      if (match && onProgress) {
        const pct = parseFloat(match[1]);
        // Only report at rough milestones to avoid spamming
        if (pct === 25 || pct === 50 || pct === 75) {
          onProgress(`Downloading... ${Math.floor(pct)}% complete`);
        }
      }
    });

    proc.stderr.on('data', (data) => (stderr += data.toString()));

    proc.on('close', (code) => {
      if (progressTimer) clearInterval(progressTimer);
      if (job) job.proc = null;

      if (job && job.cancelled) {
        return reject(new Error('CANCELLED'));
      }

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
  const response = await fetch(apiUrl);
  const json = await response.json();

  if (json.code !== 0 || !json.data?.play) {
    throw new Error(`TikTok API error: ${json.msg || 'No video found'}`);
  }

  const videoUrl = json.data.play; // no watermark
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

  await runCommand('wget', ['-O', outputPath, videoUrl], job);
  return outputPath;
}

/**
 * Full pipeline: download, fix audio if needed, then compress if needed.
 * Returns { filePath, wasCompressed, finalSizeMB }
 */
async function fetchVideo(url, jobId, job, onProgress) {
  const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok');
let originalPath = isTikTok
  ? await downloadTikTokViaAPI(url, jobId, job)
  : await downloadVideo(url, jobId, job, onProgress);

  if (job && job.cancelled) {
    cleanup(originalPath);
    throw new Error('CANCELLED');
  }

  const audioOk = await hasAudioStream(originalPath);
  if (!audioOk) {
    if (onProgress) onProgress('Fixing missing audio track...');
    originalPath = await fixMissingAudio(originalPath, url, jobId, job);
  }

  const originalSizeMB = getFileSizeMB(originalPath);

  if (originalSizeMB <= MAX_FILE_SIZE_MB) {
    return { filePath: originalPath, wasCompressed: false, finalSizeMB: originalSizeMB };
  }

  if (onProgress) onProgress('Video is large, compressing to fit Telegram limits...');

  const compressedPath = await compressVideo(originalPath, jobId, job);
  const compressedSizeMB = getFileSizeMB(compressedPath);

  if (compressedSizeMB > MAX_FILE_SIZE_MB) {
    cleanup(compressedPath);
    cleanup(originalPath);
    throw new Error("Unable to compress video below " + MAX_FILE_SIZE_MB + "MB limit.");
  }

  fs.unlinkSync(originalPath);

  return {
    filePath: compressedPath,
    wasCompressed: true,
    finalSizeMB: compressedSizeMB,
  };
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

module.exports = { fetchVideo, getFileSizeMB, cleanup, MAX_FILE_SIZE_MB };
