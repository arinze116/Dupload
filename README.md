# Dupload

Dupload is a Telegram video downloader and media processing bot built with Node.js, yt-dlp, FFmpeg, and Telegraf.

It lets users send a supported media URL to a Telegram bot, downloads the media, processes it when necessary, and sends the resulting video back to the user.

## Features

- Download videos from platforms supported by yt-dlp
- Telegram-based URL processing
- Automatic video compression for large files
- FFmpeg-based media processing
- Upload retry handling for unreliable connections
- Temporary download cleanup
- Environment-based configuration
- Designed to run continuously on a VPS

## How it works

1. A user sends a supported media URL to the bot.
2. Dupload passes the URL to yt-dlp.
3. The downloaded file is checked against the configured size limit.
4. Large files are processed with FFmpeg and scaled to 720p.
5. The resulting video is uploaded back to Telegram.
6. Temporary files are removed after processing.

## Project structure

- `index.js` - Telegram bot entrypoint and upload handling
- `downloader.js` - download and FFmpeg processing pipeline
- `.env.example` - configuration template
- `downloads/` - temporary media storage

## Requirements

- Node.js
- yt-dlp
- FFmpeg
- Telegram bot token

## Configuration

Copy `.env.example` to `.env` and set your bot token:

```env
BOT_TOKEN=your_telegram_bot_token_here
MAX_FILE_SIZE_MB=50
DOWNLOAD_DIR=./downloads
```

Install the Node.js dependencies:

```bash
npm install
```

Start the bot:

```bash
npm start
```

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

Large files may need to be compressed before delivery through Telegram.

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
