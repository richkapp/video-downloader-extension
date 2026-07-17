# Video Downloader Extension — Technical Notes

This project combines a Manifest V3 browser extension with a local Node.js download server. The extension detects media and the server handles HLS/DASH streams with yt-dlp.

## Active Architecture

```text
Browser tab
  ├─ background.js: observes media requests and keeps a bounded per-tab list
  └─ popup.js: scans the DOM, displays candidates, and starts downloads
       │
       ├─ direct MP4/audio → chrome.downloads
       ├─ popup open → native message → on-demand server bootstrap
       └─ HLS/DASH URL + request context → POST http://127.0.0.1:9876/download
                                                │
                                                └─ download-server-v2.js
                                                   ├─ yt-dlp native downloader
                                                   ├─ 8 concurrent fragments
                                                   ├─ ffmpeg merge/remux when needed
                                                   └─ SSE progress web UI
```

`download-server.js` is the legacy browser-segment receiver and is retained only for reference. The extension, native bootstrapper, desktop app, and macOS launcher use `download-server-v2.js`.

## Requirements

- Node.js
- yt-dlp
- ffmpeg
- Chrome, Brave, or Edge

On macOS with Homebrew:

```bash
brew install node yt-dlp ffmpeg
```

## Setup

1. Open the browser's extensions page.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this directory.
4. Double-click `Install Native Host.command` once, then reload the extension.

Opening the popup now starts the server automatically. For manual fallback:

```bash
node download-server-v2.js
```

The server UI is available at `http://127.0.0.1:9876`, and completed files go to `~/Downloads`.

## Download Paths

| Media | Path |
|---|---|
| MP4, WebM, MP3, M4A, and other direct files | Browser download manager |
| HLS (`.m3u8`) | yt-dlp native HLS downloader with concurrent fragments |
| DASH (`.mpd`) | yt-dlp native DASH downloader with concurrent fragments |

The popup passes the browser's matching cookies and captured media-request headers to the local server. Cookies are written to a permission-600 temporary jar for yt-dlp and deleted when the download exits.

## Performance Behavior

- HLS/DASH uses 8 concurrent fragments by default. Override it with `VIDEO_DOWNLOADER_CONCURRENCY`, from 1 through 16.
- yt-dlp's native downloader is used instead of forcing sequential ffmpeg input; existing user authentication configuration remains available.
- Retries use yt-dlp's normal limit of 10 rather than stalling for 30 attempts.
- Verbose per-fragment terminal logging is disabled; parsed progress is still sent to the web UI.
- Individual `.ts`, `.m4s`, and similarly named fragments are ignored by media detection.
- Per-tab detections are capped at 200 and cleared on navigation.
- Popup manifest probing is capped at 12 candidates, with a 5-second timeout and at most 6 concurrent requests.
- A one-shot native messaging host starts the server when the extension popup opens and then exits.
- The server exits after two hours without popup/download activity and never exits while a download process is active.
- Passive `/status`, `/events`, and progress-page traffic do not postpone idle shutdown.

Example with reduced concurrency for a rate-limited CDN:

```bash
VIDEO_DOWNLOADER_CONCURRENCY=4 node download-server-v2.js
```

## Server API

| Endpoint | Method | Purpose |
|---|---|---|
| `/download` | POST | Start a stream download |
| `/wake` | POST | Record explicit extension activity and extend the idle deadline |
| `/stop/{id}` | POST | Stop an active download |
| `/downloads` | GET | Return current download history |
| `/events` | GET | Stream progress with SSE |
| `/status` | GET | Health, active count, and concurrency |
| `/` | GET | Progress web UI |

The `/download` request accepts `{ url, filename?, referer?, origin?, userAgent? }`. Only HTTP(S) media URLs are accepted, filenames are confined to `~/Downloads`, duplicate active URLs are coalesced, and browser API access is restricted to extension/local origins.

## Automatic Server Lifecycle

The manifest contains a stable development key, giving this unpacked extension the ID `pjegapeinfppenlhmokdigfjgcdpjidk`. The native-host installer registers `com.videodownloader.bootstrap` only for that origin. On popup open, the extension checks `/status`, calls the host if necessary, and explicitly calls `/wake` when the server is already running.

The native host uses an atomic per-port startup lock, starts Node detached without opening Terminal, waits for `/status`, replies to Chrome, and exits. Server logs are stored at `~/Library/Logs/VideoDownloader/server.log`.

## Known Limits

- DRM-protected media is not supported.
- A CDN can still impose its own bandwidth or concurrency limits.
- Site-specific extractors can break when a website changes; keep yt-dlp current.
- Browser-only TLS fingerprint checks can still reject non-browser clients even when their cookies and headers match.
- Live HLS downloads continue until the stream ends or the user stops them.

## Verification

Run the automated server tests and JavaScript syntax checks:

```bash
node --test tests/download-server-v2.test.js
node --check background.js
node --check popup.js
node --check download-server-v2.js
```
