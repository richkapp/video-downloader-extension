# Video Downloader Extension

[![CI](https://github.com/richkapp/video-downloader-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/richkapp/video-downloader-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Chrome/Brave/Edge extension that detects and downloads videos and audio from web pages, including HLS streaming videos.

## Features

- **Auto-detects media** by monitoring network requests and scanning the page DOM
- **Recognizes primary YouTube content** from watch, Shorts, and live pages instead of offering broken `videoplayback` transport requests
- **Downloads HLS/DASH streams in parallel** with yt-dlp's native fragment downloader (8 fragments by default)
- **Smart stream labeling** - shows resolution, format, duration, exact or estimated size, and whether a stream includes audio
- **Largest-first results** - groups repeated stream requests, decodes useful YouTube metadata, and puts known file sizes ahead of unknown sizes
- **Persistent in-popup progress** with percentage, speed, ETA, errors, stop controls, and removable history; close and reopen the extension without losing the active download state
- **Compatible MP4 output** prefers H.264 video with AAC audio for native playback on macOS and other devices
- **Persistent settings tab** uses a native folder chooser and controls video output, parallel download connections, and visible progress history
- **Automatic server lifecycle** - clicking the extension starts the local server; two idle hours stops it
- **Audio support** - MP3, M4A, AAC, OGG, OPUS, WAV, FLAC, and more
- **Desktop app** (Electron) with system tray for easy server management
- **Free and open source** with an optional Buy the Creator a Coffee link in Settings

## How It Works

1. **Browser Extension** - Recognizes primary YouTube pages and monitors other sites for downloadable video/audio URLs
2. **Download Server** - Local Node.js server receives URLs and uses yt-dlp + ffmpeg to download
3. **yt-dlp + ffmpeg** - Downloads fragments concurrently, then remuxes when the container needs it

The extension can't download HLS streams directly (browsers can't merge video fragments), so it sends the m3u8 URL to the local server which handles the download.

## Requirements

- **Node.js** 18 or newer
- **yt-dlp**
- **ffmpeg**
- **Chrome, Brave, Edge, Chromium, or Vivaldi** browser on macOS or Linux

On macOS: `brew install node yt-dlp ffmpeg`. On Arch and Omarchy: `sudo pacman -S nodejs yt-dlp ffmpeg`. On Debian and Ubuntu: `sudo apt install nodejs yt-dlp ffmpeg`.

## Installation on Linux (including Omarchy)

```bash
git clone https://github.com/richkapp/video-downloader-extension.git ~/.local/share/video-downloader-extension
~/.local/share/video-downloader-extension/install.sh
```

Then restart your browser. The installer:

- registers the native host that starts the download server on demand, for every Chromium-based browser profile it finds under `~/.config`
- adds the extension to `--load-extension` in any `~/.config/<browser>-flags.conf` it finds (the files Arch packages and Omarchy use), keeping the extensions already listed there

If your browser has no flags file, load it once by hand: open `brave://extensions` (or `chrome://extensions`), turn on **Developer mode**, click **Load unpacked** and choose the cloned folder.

To update, `git pull` in the cloned folder and restart the browser. To remove everything, run `./install.sh --uninstall`.

The **Choose folder** button in Settings uses zenity, kdialog, or Omarchy's desktop portal chooser, whichever is installed. Server logs go to `~/.local/state/video-downloader/server.log`.

## Installation on macOS

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
3. Optionally open **Settings** to choose the save folder, video output, connection count, and visible history
4. On YouTube, use the single **Primary video** card; yt-dlp selects and merges video and audio using your chosen output mode
5. On other sites, detected options are sorted from largest to smallest with quality, duration, and size information when available
6. Monitor progress inside the extension popup; close and reopen it at any time to restore the current server-backed state. The detailed server page remains available at **http://127.0.0.1:9876**
7. Find your video in the folder selected under **Settings** when complete
8. If the extension saves you time, Settings includes an optional **Buy the creator a coffee** link

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
| YouTube watch, Shorts, and live pages | Canonical page URL -> yt-dlp selects video + audio using the configured output mode -> selected folder |
| Direct files (MP4, MP3, etc.) | Browser's native download dialog |
| HLS streams (.m3u8) | Sent to local server -> yt-dlp + ffmpeg -> selected folder |
| DASH streams (.mpd) | Sent to local server -> yt-dlp -> selected folder |

## Project Structure

```
video-downloader-extension/
├── manifest.json              # Chrome extension config (Manifest V3)
├── popup.html / popup.js      # Extension popup - detects and displays media
├── background.js              # Service worker - monitors network requests
├── download-server-v2.js      # Download server with web UI + yt-dlp
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
                            │  - Configured output │
                            │  - Saves to configured folder
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
- Update yt-dlp: `brew upgrade yt-dlp` on macOS, or your package manager on Linux
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
