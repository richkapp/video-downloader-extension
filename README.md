# Video Downloader Extension

[![CI](https://github.com/richkapp/video-downloader-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/richkapp/video-downloader-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Chrome/Brave/Edge extension that detects and downloads videos and audio from web pages, including HLS streaming videos.

## Features

- **Auto-detects media** by monitoring network requests and scanning the page DOM
- **Downloads HLS/DASH streams in parallel** with yt-dlp's native fragment downloader (8 fragments by default)
- **Smart stream labeling** - shows resolution (720p, 1080p), duration, estimated size, and recommends the best option
- **Real-time progress UI** at `http://127.0.0.1:9876` with speed, ETA, and stop controls
- **Automatic server lifecycle** - clicking the extension starts the local server; two idle hours stops it
- **Audio support** - MP3, M4A, AAC, OGG, OPUS, WAV, FLAC, and more
- **Desktop app** (Electron) with system tray for easy server management

## How It Works

1. **Browser Extension** - Monitors network traffic to detect video/audio URLs when you play media
2. **Download Server** - Local Node.js server receives URLs and uses yt-dlp + ffmpeg to download
3. **yt-dlp + ffmpeg** - Downloads fragments concurrently, then remuxes when the container needs it

The extension can't download HLS streams directly (browsers can't merge video fragments), so it sends the m3u8 URL to the local server which handles the download.

## Requirements

- **Node.js** (`brew install node`)
- **yt-dlp** (`brew install yt-dlp`)
- **ffmpeg** (`brew install ffmpeg`)
- **Chrome, Brave, or Edge** browser

## Installation

### 1. Install the Browser Extension

1. Clone the repository:

   ```bash
   git clone https://github.com/richkapp/video-downloader-extension.git
   cd video-downloader-extension
   ```

2. Open `chrome://extensions/` (or `brave://extensions/`)
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the cloned `video-downloader-extension` folder

### 2. Install Automatic Server Startup

Double-click **`Install Native Host.command`** once. It registers the included native bootstrapper for installed Chrome, Brave, Edge, Chromium, and Vivaldi profiles.

Then reload the unpacked extension once at `chrome://extensions`. Opening the extension popup now starts the server automatically. It shuts down after two hours without extension or download activity, but never while a download is active.

**Manual fallback**

```bash
node download-server-v2.js
```

The server runs on `http://127.0.0.1:9876`.

**Option B: Use the Desktop App**

1. Build: `cd media-downloader-app && npm install && npm run dist`
2. Install from `dist/mac-arm64/Media Downloader.app`
3. Launch - server starts automatically with system tray controls

## Usage

1. **Navigate to a page** with video content and play the video briefly
2. **Click the extension icon**; the local server starts automatically
3. Detected media appears with quality info, duration, and size estimates
4. The **recommended** stream is highlighted in green - click **Download (Best)**
5. Monitor progress at **http://127.0.0.1:9876**
6. Find your video in `~/Downloads` when complete

### Tips

- You don't need to watch the whole video - just press play, then pause
- If no videos appear, click **Rescan Page**
- Use **Clear & Rescan** if you're seeing old/stale media from previous pages
- Master playlists auto-select the highest quality stream
- HLS/DASH fragments download concurrently; ffmpeg is used only when merging or remuxing is needed

## Supported Formats

| Type | Formats |
|------|---------|
| Video | MP4, WebM, M4V, MOV, MKV, AVI, FLV |
| Streaming | HLS (.m3u8), DASH (.mpd) |
| Audio | MP3, M4A, AAC, OGG, OPUS, WAV, FLAC, WMA, AIFF |

## How Downloads Work

| Media Type | Download Method |
|------------|----------------|
| Direct files (MP4, MP3, etc.) | Browser's native download dialog |
| HLS streams (.m3u8) | Sent to local server -> yt-dlp + ffmpeg -> ~/Downloads |
| DASH streams (.mpd) | Sent to local server -> yt-dlp -> ~/Downloads |

## Project Structure

```
video-downloader-extension/
├── manifest.json              # Chrome extension config (Manifest V3)
├── popup.html / popup.js      # Extension popup - detects and displays media
├── background.js              # Service worker - monitors network requests
├── download-server-v2.js      # Download server with web UI + yt-dlp
├── download-server.js         # Legacy server (segment-based HLS)
├── Install Native Host.command # One-time automatic-start installer
├── native-host/                # Chrome native messaging bootstrapper
├── icon.png                   # Extension icon
│
└── media-downloader-app/      # Electron desktop app
    ├── main.js                # Main process - spawns server
    ├── preload.js             # IPC security bridge
    └── renderer/              # App UI
```

## Architecture

```
┌─────────────────────┐     ┌─────────────────────────────────────┐
│  Browser Extension  │     │       Download Server               │
│                     │     │       (localhost:9876)               │
│  - Monitors network │     │                                     │
│  - Detects .m3u8    │────▶│  - Receives m3u8/video URLs         │
│  - Shows quality    │POST │  - Runs yt-dlp native downloads     │
│  - Shows duration   │     │  - Streams progress via SSE         │
│  - Shows est. size  │     │  - Web UI for monitoring            │
└─────────────────────┘     └──────────┬──────────────────────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │   yt-dlp + ffmpeg    │
                            │                      │
                            │  - Parallel HLS/DASH │
                            │  - Retries on error  │
                            │  - Outputs MP4       │
                            │  - Saves to ~/Downloads
                            └──────────────────────┘
```

## Troubleshooting

### No videos found
- Play the video first, even just for a second
- Click **Rescan Page** in the extension popup
- Some sites load videos lazily - scroll to the video player

### "Download server not running"
- Double-click `Install Native Host.command`, reload the extension, and click it again
- For manual fallback, run `node download-server-v2.js`

### Download stuck or slow
- HLS/DASH uses 8 concurrent fragments by default instead of sequential ffmpeg downloading
- The server forwards matching browser cookies and captured media-request headers for CDNs that validate requests
- Check server logs in the terminal for errors

To tune concurrency, start the server with `VIDEO_DOWNLOADER_CONCURRENCY=4 node download-server-v2.js`. Valid values are 1-16; lowering it can help CDNs that rate-limit parallel requests.

### Download fails
- Update yt-dlp: `brew upgrade yt-dlp`
- Some sites have DRM protection that prevents downloading
- Check terminal output for specific error messages

### Stop a stuck download
- Use the **Stop** button in the web UI at `http://127.0.0.1:9876`
- If the UI is unavailable, stop the server and start it again from the extension popup

## Privacy

- All downloads happen locally on your machine
- No data is sent to any external servers
- The extension only monitors network requests on the active tab
- Video URLs are only sent to localhost (127.0.0.1)

## Development

Run the syntax checks and automated server/native-host tests with:

```bash
npm run check
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## Responsible Use

Only download media you own or have permission to download. You are responsible for complying with applicable laws and website terms. DRM-protected media is not supported.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 richkapp.
