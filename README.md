# Dupload

Dupload is a Telegram video downloader and media processing bot built with Node.js, yt-dlp, FFmpeg, and Telegraf.

It lets users send a supported media URL to a Telegram bot, downloads the media, processes it when necessary, and sends the resulting video or audio back to the user.

## Features

- Download videos up to 2GB using a self-hosted Telegram Bot API server
- Audio-only download mode (MP3 extraction)
- Quality resolution selection (`360p`, `480p`, `720p`, `1080p`)
- Real-time throttled download progress bar with visual indicator (`▓▓▓░░░░░░░ 50%`)
- Automatic platform detection and instant user feedback
- Video metadata preview command (`/info <url>`)
- Per-user hourly rate limiting
- Admin management commands (`/stats` and `/cleardownloads`)
- Automatic video compression for files exceeding the size limit
- FFmpeg-based media processing and missing audio repair for silent TikTok streams
- Upload retry handling for unreliable connections
- Temporary download cleanup
- Environment-based configuration
- Designed to run continuously on a VPS

## How it works

1. A user sends a supported media URL (with optional quality keyword like `720p` or `audio` flag) to the bot.
2. Dupload detects the platform and passes the request to yt-dlp.
3. The downloaded file is checked against `MAX_FILE_SIZE_MB`.
4. Large video files are processed with FFmpeg and scaled if needed.
5. The resulting video or audio is uploaded back to Telegram via the local Bot API server.
6. Temporary files are removed after processing.

## Project structure

- `index.js` - Telegram bot entrypoint, queue management, commands, rate limiting, and upload handling
- `downloader.js` - download and FFmpeg processing pipeline, audio extraction, progress formatting, and metadata lookup
- `.env.example` - configuration template
- `downloads/` - temporary media storage

## Requirements

- Node.js
- yt-dlp
- FFmpeg
- Self-hosted Telegram Bot API server (for 2GB support)
- Telegram bot token

## Configuration

Copy `.env.example` to `.env` and configure your parameters:

```env
# Required
BOT_TOKEN=your_telegram_bot_token_here
LOCAL_API_URL=http://127.0.0.1:8081

# File size limit — 2000 for local Bot API, 50 for public API
MAX_FILE_SIZE_MB=2000

# Directory for temporary downloads
DOWNLOAD_DIR=./downloads

# Telegram user ID of the bot admin (for /stats and /cleardownloads)
ADMIN_ID=

# Max downloads per user per hour (default: 10)
RATE_LIMIT_PER_HOUR=10
```

Install the Node.js dependencies:

```bash
npm install
```

Start the bot:

```bash
npm start
```

## Commands

- `/start` — Welcome message and instructions
- `/help` — Help and usage details
- `/stop` — Cancel active download and clear queue
- `/queue` — Check active and waiting download queue
- `/info <url>` — Preview video title, uploader, duration, and available resolutions
- `/stats` — Admin only: View active/queued jobs, disk usage, and rate limit status
- `/cleardownloads` — Admin only: Delete all temporary files in `downloads/`

## Deployment

Dupload is designed to run as a long-lived process on a Linux VPS. PM2 can be used to keep the bot running and restart it when necessary.

```bash
pm2 start index.js --name dupload
pm2 save
pm2 logs dupload
```

## Security

The repository excludes sensitive local data.

- `.env`
- Instagram cookies
- Downloaded media
- `node_modules`

Do not commit bot tokens, cookies, credentials, private URLs, or user data.

## Limitations

Download availability depends on what yt-dlp and the target platform currently support. Private, login-protected, region-restricted, DRM-protected, or otherwise inaccessible media may fail.

Large files up to 2GB can be delivered when integrated with a self-hosted Telegram Bot API server.

## Tech stack

- Node.js
- JavaScript
- Telegraf
- yt-dlp
- FFmpeg
- Telegram Bot API
- PM2

## License

No license has been added yet.
