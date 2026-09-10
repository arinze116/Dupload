# Social Download Bot

Telegram bot that downloads videos from X, Facebook, Instagram, Pinterest, TikTok, YouTube, and most other platforms supported by yt-dlp.

## How it works

1. User pastes a link in the chat
2. Bot runs `yt-dlp` to fetch the best available quality
3. If the file is over 50MB (Telegram's bot upload limit), it gets compressed with `ffmpeg` (scaled to 720p, re-encoded)
4. Bot sends the final video file back, retrying up to 3 times with backoff if the upload drops

## Project files

- `index.js` — bot entrypoint, handles Telegram messages, retry logic on upload
- `downloader.js` — wraps yt-dlp and ffmpeg, handles the download + compression pipeline
- `.env.example` — copy this to `.env` and fill in your bot token
- `downloads/` — temp storage during processing (auto-cleaned after each send)

## Setup on Windows (VS Code)

```powershell
# 1. Install dependencies
npm install

# 2. Create your .env file (PowerShell-safe way — do NOT use bash heredoc syntax here)
New-Item .env -ItemType File
notepad .env
# paste in:
# BOT_TOKEN=your_actual_token_here
# MAX_FILE_SIZE_MB=50
# DOWNLOAD_DIR=./downloads
# save and close notepad

# 3. Run it
node index.js
```

You should see `Bot is running.` in the terminal. Message your bot on Telegram with a video link to test.

## Moving to Termux later

When ready to move to Termux for 24/7 uptime:

```bash
pkg update && pkg upgrade -y
pkg install python ffmpeg nodejs git -y
pip install -U yt-dlp
termux-setup-storage
```

Transfer this project folder onto your phone (USB or otherwise), then on Termux:

```bash
cp -r ~/storage/downloads/social-dl-bot ~/social-dl-bot
cd ~/social-dl-bot
rm -rf node_modules package-lock.json   # Windows node_modules won't work on Termux's architecture
npm install
node index.js
```

If uploads fail with a "socket hang up" error on Termux specifically, that's a known flaky-connection issue — the retry logic in `index.js` already handles this automatically (3 attempts with backoff). If it still fails after all 3 attempts, try switching between WiFi and mobile data, or test raw upload reliability with:

```bash
curl -v -F "chat_id=YOUR_CHAT_ID" -F "video=@/path/to/some_video.mp4" "https://api.telegram.org/bot<YOUR_TOKEN>/sendVideo"
```

(Note the literal word `bot` directly before your token in the URL — a missing `bot` prefix causes a 404, not a connection error.)

## Running persistently with PM2 (on Termux)

```bash
npm install -g pm2
pm2 start index.js --name social-dl-bot
pm2 save
```

```bash
pm2 logs social-dl-bot
pm2 restart social-dl-bot
```

## Notes

- Private or region-locked content may fail — yt-dlp can only fetch what's publicly accessible without login.
- This bot intentionally does not support adult content sites or DRM-protected platforms like Spotify.