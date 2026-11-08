#!/usr/bin/env node

const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { version: PACKAGE_VERSION } = require('./package.json');

const SERVER_VERSION = PACKAGE_VERSION.replace(/(?:\.0)+$/, '');

const requestedPort = Number.parseInt(process.env.VIDEO_DOWNLOADER_PORT, 10);
const PORT = Number.isFinite(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? requestedPort
  : 9876;
const HOME_DIR = os.homedir();
const DEFAULT_DOWNLOAD_DIR = path.join(HOME_DIR, 'Downloads');
const MAX_DOWNLOAD_HISTORY = 100;
const ACTIVE_STATUSES = new Set(['starting', 'downloading', 'merging', 'finalizing']);
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const requestedIdleTimeout = Number.parseInt(process.env.VIDEO_DOWNLOADER_IDLE_TIMEOUT_MS, 10);
const IDLE_TIMEOUT_MS = Number.isFinite(requestedIdleTimeout) && requestedIdleTimeout >= 100
  ? requestedIdleTimeout
  : DEFAULT_IDLE_TIMEOUT_MS;
const REAPER_INTERVAL_MS = Math.min(60_000, Math.max(100, Math.floor(IDLE_TIMEOUT_MS / 4)));
const requestedConcurrency = Number.parseInt(process.env.VIDEO_DOWNLOADER_CONCURRENCY, 10);
const DEFAULT_CONCURRENT_FRAGMENTS = Number.isFinite(requestedConcurrency)
  ? Math.min(Math.max(requestedConcurrency, 1), 16)
  : 8;
const SETTINGS_FILE = process.env.VIDEO_DOWNLOADER_SETTINGS_FILE
  ? path.resolve(process.env.VIDEO_DOWNLOADER_SETTINGS_FILE)
  : path.join(
      HOME_DIR,
      process.platform === 'darwin' ? 'Library/Application Support/Media Downloader' : '.config/media-downloader',
      'settings.json'
    );
const VIDEO_OUTPUTS = new Set(['compatible-mp4', 'best-quality']);
const CONCURRENCY_OPTIONS = new Set([2, 4, 8, 12, 16]);
const HISTORY_LIMIT_OPTIONS = new Set([1, 3, 5, 10]);
const DEFAULT_SETTINGS = Object.freeze({
  downloadDirectory: DEFAULT_DOWNLOAD_DIR,
  videoOutput: 'compatible-mp4',
  concurrentFragments: DEFAULT_CONCURRENT_FRAGMENTS,
  historyLimit: 3
});

// Track active downloads
const downloads = new Map();
const processes = new Map(); // Track yt-dlp processes for stopping
let downloadId = 0;
let lastActivityAt = Date.now();
let reaperTimer = null;
let shutdownStarted = false;
let serverSettings = loadSettings();

// SSE clients for live updates
const clients = new Set();

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function expandHomePath(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === '~') return HOME_DIR;
  if (trimmed.startsWith('~/')) return path.join(HOME_DIR, trimmed.slice(2));
  return trimmed;
}

function validateSettings(input, { base = DEFAULT_SETTINGS, checkFilesystem = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Settings must be a JSON object' };
  }

  const downloadDirectory = expandHomePath(input.downloadDirectory ?? base.downloadDirectory);
  // youtubeFormat is accepted as a one-time migration from settings written by
  // version 1.3 before the output option applied to other server-downloaded video.
  const videoOutput = input.videoOutput ?? input.youtubeFormat ?? base.videoOutput ?? base.youtubeFormat;
  const concurrentFragments = Number(input.concurrentFragments ?? base.concurrentFragments);
  const historyLimit = Number(input.historyLimit ?? base.historyLimit);

  if (!path.isAbsolute(downloadDirectory)) {
    return { error: 'Download folder must be an absolute path or begin with ~/' };
  }
  if (!VIDEO_OUTPUTS.has(videoOutput)) {
    return { error: 'Unknown video output format' };
  }
  if (!CONCURRENCY_OPTIONS.has(concurrentFragments)) {
    return { error: 'Concurrent fragments must be 2, 4, 8, 12, or 16' };
  }
  if (!HISTORY_LIMIT_OPTIONS.has(historyLimit)) {
    return { error: 'History limit must be 1, 3, 5, or 10' };
  }

  if (checkFilesystem) {
    try {
      const stats = fs.statSync(downloadDirectory);
      if (!stats.isDirectory()) return { error: 'Download folder is not a directory' };
      fs.accessSync(downloadDirectory, fs.constants.W_OK);
    } catch (error) {
      return { error: 'Download folder must already exist and be writable' };
    }
  }

  return {
    settings: {
      downloadDirectory: path.normalize(downloadDirectory),
      videoOutput,
      concurrentFragments,
      historyLimit
    }
  };
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return validateSettings(parsed).settings || { ...DEFAULT_SETTINGS };
  } catch (error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  const directory = path.dirname(SETTINGS_FILE);
  const temporaryFile = `${SETTINGS_FILE}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, SETTINGS_FILE);
}

function settingsPayload() {
  return {
    settings: { ...serverSettings },
    defaults: { ...DEFAULT_SETTINGS }
  };
}

function macFolderPickerArgs(initialDirectory) {
  return [
    '-l', 'JavaScript',
    '-e', 'function run(argv) { if (argv[1] === "__SYNTAX_CHECK__") return "__READY__"; const app = Application.currentApplication(); app.includeStandardAdditions = true; try { const folder = app.chooseFolder({withPrompt: "Choose where Media Downloader saves videos", defaultLocation: Path(argv[0])}); return folder.toString(); } catch (error) { if (error.errorNumber === -128) return "__CANCELLED__"; throw error; } }',
    '--',
    initialDirectory
  ];
}

// Linux folder choosers in preference order. Each exits 1 when the user cancels.
// omarchy-file-select drives the XDG desktop portal on Omarchy.
function linuxFolderPickerCommands(initialDirectory) {
  const title = 'Choose where Media Downloader saves videos';
  const startPath = initialDirectory.endsWith(path.sep) ? initialDirectory : `${initialDirectory}${path.sep}`;
  return [
    ['zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${startPath}`]],
    ['kdialog', ['--getexistingdirectory', initialDirectory, '--title', title]],
    ['omarchy-file-select', ['--directory', '--title', title]]
  ];
}

function runFolderPicker(command, args, { exitOneMeansCancel = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (error, stdout) => {
      if (error?.code === 'ENOENT') resolve({ missing: true });
      else if (exitOneMeansCancel && error?.code === 1 && !error.killed) resolve({ cancelled: true });
      else if (error) reject(new Error(error.killed ? 'Folder selection timed out' : 'Could not open the folder chooser'));
      else resolve({ output: stdout });
    });
  });
}

async function pickFolder(initialDirectory, platform = process.platform) {
  if (platform === 'darwin') {
    // The AppleScript reports a cancel as __CANCELLED__; a non-zero exit is a real failure.
    const result = await runFolderPicker('/usr/bin/osascript', macFolderPickerArgs(initialDirectory), { exitOneMeansCancel: false });
    if (result.missing) throw new Error('Could not open the folder chooser');
    return result;
  }
  if (platform === 'linux') {
    for (const [command, args] of linuxFolderPickerCommands(initialDirectory)) {
      const result = await runFolderPicker(command, args);
      if (!result.missing) return result;
    }
    throw new Error('No folder chooser found. Install zenity or kdialog');
  }
  throw new Error('Native folder selection is available on macOS and Linux');
}

function selectDownloadDirectory(initialDirectory = serverSettings.downloadDirectory) {
  return pickFolder(initialDirectory).then(result => {
    const selectedPath = result.cancelled ? '' : result.output.trim().split('\n')[0];
    if (!selectedPath || selectedPath === '__CANCELLED__') {
      return { cancelled: true };
    }
    const validation = validateSettings(
      { ...serverSettings, downloadDirectory: selectedPath },
      { base: serverSettings, checkFilesystem: true }
    );
    if (validation.error) throw new Error(validation.error);
    return { path: validation.settings.downloadDirectory };
  });
}

function cleanHeaderValue(value, maxLength = 2048) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\r\n]/g, '').trim().slice(0, maxLength);
  return clean || null;
}

function normalizeRequestHeaders(requestHeaders) {
  if (!requestHeaders || typeof requestHeaders !== 'object' || Array.isArray(requestHeaders)) return {};
  const allowed = new Set(['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'referer', 'user-agent']);
  const normalized = {};
  for (const [rawName, rawValue] of Object.entries(requestHeaders)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) continue;
    const value = cleanHeaderValue(rawValue, name === 'cookie' ? 16_384 : 4096);
    if (value) normalized[name] = value;
  }
  return normalized;
}

function safeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) return null;
  return path.basename(filename).replace(/[\0\r\n]/g, '').slice(0, 240) || null;
}

function cleanCookieField(value, maxLength) {
  return String(value ?? '').replace(/[\0\t\r\n]/g, '').slice(0, maxLength);
}

function serializeNetscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated temporarily by Video Downloader', ''];
  if (!Array.isArray(cookies)) return lines.join('\n') + '\n';

  for (const cookie of cookies.slice(0, 200)) {
    const rawDomain = cleanCookieField(cookie.domain, 253).toLowerCase();
    const name = cleanCookieField(cookie.name, 256);
    const value = cleanCookieField(cookie.value, 4096);
    if (!rawDomain || !name || !/^(?:\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\d{1,3}(?:\.\d{1,3}){3})$/i.test(rawDomain)) {
      continue;
    }

    const domain = cookie.httpOnly ? `#HttpOnly_${rawDomain}` : rawDomain;
    const includeSubdomains = cookie.hostOnly ? 'FALSE' : 'TRUE';
    const cookiePath = cleanCookieField(cookie.path || '/', 1024) || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = Number.isFinite(cookie.expirationDate)
      ? String(Math.max(0, Math.floor(cookie.expirationDate)))
      : '0';
    lines.push([domain, includeSubdomains, cookiePath, secure, expires, name, value].join('\t'));
  }

  return lines.join('\n') + '\n';
}

function createCookieJar(cookies, id) {
  const contents = serializeNetscapeCookies(cookies);
  if (contents.split('\n').length <= 4) return null;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `video-downloader-${process.pid}-${id}-`));
  const file = path.join(directory, 'cookies.txt');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return { directory, file };
}

function removeCookieJar(cookieJar) {
  if (!cookieJar) return;
  try {
    fs.rmSync(cookieJar.directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove temporary cookie jar: ${error.message}`);
  }
}

function cookiesFromRequestHeader(requestHeaders, url) {
  const cookieHeader = normalizeRequestHeaders(requestHeaders).cookie;
  if (!cookieHeader || !isHttpUrl(url)) return [];

  const parsedUrl = new URL(url);
  const cookies = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    cookies.push({
      domain: parsedUrl.hostname,
      hostOnly: true,
      httpOnly: false,
      name,
      path: '/',
      secure: parsedUrl.protocol === 'https:',
      value
    });
  }
  return cookies;
}

function buildYtDlpArgs({
  url,
  filename,
  referer,
  origin,
  userAgent,
  cookieFile,
  requestHeaders,
  downloadDirectory = DEFAULT_SETTINGS.downloadDirectory,
  videoOutput = DEFAULT_SETTINGS.videoOutput,
  mediaType = 'video',
  concurrentFragments = DEFAULT_SETTINGS.concurrentFragments
}) {
  const cleanFilename = safeFilename(filename);
  const outputTemplate = cleanFilename
    ? path.join(downloadDirectory, cleanFilename)
    : path.join(downloadDirectory, '%(title)s.%(ext)s');

  const args = [
    '-o', outputTemplate,
    '--no-playlist',
    '--newline',
    '--progress',
    '--progress-delta', '0.5',
    '--concurrent-fragments', String(concurrentFragments),
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '20'
  ];

  // Prefer H.264 video + AAC audio in an MP4 container for native playback on
  // macOS, Windows, mobile devices, and browsers. yt-dlp's mp4 preset retains
  // its own fallback selection when a source lacks the preferred codecs.
  if (mediaType !== 'audio' && videoOutput === 'compatible-mp4') {
    args.push('-t', 'mp4');
  }

  const capturedHeaders = normalizeRequestHeaders(requestHeaders);
  const effectiveReferer = capturedHeaders.referer || referer;
  const effectiveOrigin = capturedHeaders.origin || origin;
  const effectiveUserAgent = capturedHeaders['user-agent'] || userAgent;

  if (isHttpUrl(effectiveReferer)) {
    args.push('--referer', cleanHeaderValue(effectiveReferer));
  }
  if (isHttpUrl(effectiveOrigin)) {
    args.push('--add-headers', `Origin:${new URL(effectiveOrigin).origin}`);
  }

  const cleanUserAgent = cleanHeaderValue(effectiveUserAgent, 512);
  if (cleanUserAgent) {
    args.push('--user-agent', cleanUserAgent);
  }
  for (const name of ['accept', 'accept-language', 'authorization']) {
    if (capturedHeaders[name]) {
      args.push('--add-headers', `${name}:${capturedHeaders[name]}`);
    }
  }
  if (cookieFile) {
    args.push('--cookies', cookieFile);
  }

  // End option parsing so a URL can never be read as a yt-dlp flag.
  args.push('--', url);
  return args;
}

function isActiveDownload(download) {
  return ACTIVE_STATUSES.has(download.status);
}

function markActivity(now = Date.now()) {
  lastActivityAt = now;
}

function shouldExitForInactivity({ now, lastActivity, activeDownloads, idleTimeoutMs }) {
  return activeDownloads === 0 && now - lastActivity >= idleTimeoutMs;
}

function stopIdleReaper() {
  if (!reaperTimer) return;
  clearInterval(reaperTimer);
  reaperTimer = null;
}

function shutdownForInactivity() {
  if (shutdownStarted || processes.size > 0) return;
  shutdownStarted = true;
  stopIdleReaper();
  console.log(`\n🛌 No download activity for ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes. Stopping server.`);
  for (const client of clients) client.end();
  clients.clear();

  server.close(() => process.exit(0));
  const forcedExit = setTimeout(() => process.exit(0), 5000);
  forcedExit.unref();
}

function startIdleReaper() {
  if (reaperTimer) return reaperTimer;
  reaperTimer = setInterval(() => {
    if (shouldExitForInactivity({
      now: Date.now(),
      lastActivity: lastActivityAt,
      activeDownloads: processes.size,
      idleTimeoutMs: IDLE_TIMEOUT_MS
    })) {
      shutdownForInactivity();
    }
  }, REAPER_INTERVAL_MS);
  reaperTimer.unref();
  return reaperTimer;
}

function trimDownloadHistory() {
  if (downloads.size < MAX_DOWNLOAD_HISTORY) return;
  for (const [id, download] of downloads) {
    if (!isActiveDownload(download)) {
      downloads.delete(id);
      if (downloads.size < MAX_DOWNLOAD_HISTORY) return;
    }
  }
}

function clearDownloadHistory(downloadMap, requestedId = null) {
  if (requestedId !== null) {
    const download = downloadMap.get(requestedId);
    if (!download) return { clearedIds: [], reason: 'not_found' };
    if (isActiveDownload(download)) return { clearedIds: [], reason: 'active' };
    downloadMap.delete(requestedId);
    return { clearedIds: [requestedId] };
  }

  const clearedIds = [];
  for (const [id, download] of downloadMap) {
    if (isActiveDownload(download)) continue;
    downloadMap.delete(id);
    clearedIds.push(id);
  }
  return { clearedIds };
}

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? Math.round(value) : value.toFixed(2)}${units[unitIndex]}`;
}

function refreshCompletedFileMetadata(download) {
  const filename = safeFilename(download.filename);
  if (!filename) return;
  try {
    const stats = fs.statSync(path.join(download.downloadDir || DEFAULT_DOWNLOAD_DIR, filename));
    if (stats.isFile()) download.size = formatByteSize(stats.size);
  } catch (error) {
    // The process result remains authoritative if a destination was moved.
  }
}

// Only this extension may drive the server. Accepting any chrome-extension://
// origin would let every other installed extension change the download folder
// and start downloads. Self-hosted builds with a different ID can override this
// with a comma-separated VIDEO_DOWNLOADER_EXTENSION_IDS.
const DEFAULT_EXTENSION_ID = 'pjegapeinfppenlhmokdigfjgcdpjidk';
const ALLOWED_EXTENSION_IDS = new Set(
  (process.env.VIDEO_DOWNLOADER_EXTENSION_IDS || DEFAULT_EXTENSION_ID)
    .split(',')
    .map(id => id.trim())
    .filter(id => /^[a-p]{32}$/.test(id))
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`) return true;
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin);
  return Boolean(match && ALLOWED_EXTENSION_IDS.has(match[1]));
}

// Blocks DNS rebinding: a hostile page that rebinds its own hostname to
// 127.0.0.1 sends its own Host header and would otherwise read local state.
function isAllowedHost(host) {
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => client.write(message));
}

function parseProgress(line, download) {
  const errorMatch = line.match(/ERROR:\s*(.+)$/);
  if (errorMatch) {
    return {
      status: 'error',
      error: errorMatch[1].trim().slice(0, 500)
    };
  }

  // aria2c progress: [DL:10MiB][#hash ...](+11)
  const aria2Match = line.match(/\[DL:([\d.]+\w+)\]/);
  if (aria2Match && download.totalFragments) {
    // Track completed fragments by counting aria2c download lines
    if (!download._aria2Lines) download._aria2Lines = 0;
    download._aria2Lines++;
    // Each line is ~1 second, estimate fragments from speed
    const speed = aria2Match[1];
    return {
      speed,
      status: 'downloading'
    };
  }

  // aria2c fragment completion tracking via yt-dlp
  const fragDoneMatch = line.match(/\(frag\s+(\d+)\/(\d+)\)/);
  if (fragDoneMatch && !line.includes('% of')) {
    const current = parseInt(fragDoneMatch[1]);
    const total = parseInt(fragDoneMatch[2]);
    download.totalFragments = total;
    return {
      percent: (current / total) * 100,
      fragments: `${current}/${total}`,
      eta: `${total - current} fragments left`
    };
  }

  // Track total fragments from hlsnative line
  const totalFragMatch = line.match(/Total fragments:\s*(\d+)/);
  if (totalFragMatch) {
    download.totalFragments = parseInt(totalFragMatch[1]);
    return null;
  }

  // yt-dlp HLS progress: [download]   5.6% of ~ 369.03MiB at    1.03MiB/s ETA 08:20 (frag 61/1111)
  // Also handles: [download]  45.2% of 125.36MiB at 2.35MiB/s ETA 00:32
  const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+([\d:]+|Unknown)(?:\s+\(frag\s+(\d+)\/(\d+)\))?/);
  if (progressMatch) {
    const result = {
      percent: parseFloat(progressMatch[1]),
      size: progressMatch[2].replace(/\s+/g, ''),
      speed: progressMatch[3].replace(/\s+/g, ''),
      eta: progressMatch[4]
    };
    if (progressMatch[5] && progressMatch[6]) {
      result.fragments = `${progressMatch[5]}/${progressMatch[6]}`;
    }
    return result;
  }

  // Parse total duration from ffmpeg input info: Duration: 02:29:40.57
  const durationMatch = line.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
  if (durationMatch) {
    download.totalDuration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
    return null;
  }

  // ffmpeg progress for HLS: size=   12345kB time=00:01:23.45 bitrate=1234.5kbits/s speed=2.5x
  const ffmpegMatch = line.match(/size=\s*([\d.]+\w+)\s+time=([\d:.]+)\s+bitrate=([\d.]+\w+\/s)\s+speed=([\d.]+x)/);
  if (ffmpegMatch) {
    const timeParts = ffmpegMatch[2].split(':');
    const currentSecs = parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseFloat(timeParts[2]);
    const totalDur = download.totalDuration || 1;
    const percent = Math.min((currentSecs / totalDur) * 100, 99.9);

    // Calculate ETA from speed multiplier
    const speedMultiplier = parseFloat(ffmpegMatch[4]);
    const remainingSecs = (totalDur - currentSecs) / (speedMultiplier || 1);
    const etaMins = Math.floor(remainingSecs / 60);
    const etaSecs = Math.floor(remainingSecs % 60);
    const eta = `${etaMins}m ${etaSecs}s`;

    return {
      percent,
      size: ffmpegMatch[1],
      time: ffmpegMatch[2],
      speed: ffmpegMatch[4],
      eta
    };
  }

  // Fragment downloading: [download] Downloading fragment 45 of 120
  const fragMatch = line.match(/Downloading (?:video )?(?:fragment|item) (\d+) of (\d+)/);
  if (fragMatch) {
    const current = parseInt(fragMatch[1]);
    const total = parseInt(fragMatch[2]);
    return {
      percent: (current / total) * 100,
      fragments: `${current}/${total}`,
      eta: `${total - current} fragments left`
    };
  }

  // Check for destination/filename
  const destMatch = line.match(/(?:\[download\] Destination:|Merging formats into "|\[Merger\] Merging formats into ")(.+?)(?:"|$)/);
  if (destMatch) {
    return { filename: path.basename(destMatch[1].replace('"', '')) };
  }

  // Check for completion indicators
  if (line.includes('[Merger]') || line.includes('Merging formats')) {
    return { status: 'merging', percent: 95 };
  }
  if (line.includes('Deleting original file')) {
    return { status: 'finalizing', percent: 99 };
  }
  if (line.includes('has already been downloaded')) {
    return { status: 'complete', percent: 100 };
  }

  return null;
}

const server = http.createServer((req, res) => {
  // Only extensions and this server's own UI may call the localhost API.
  const requestOrigin = req.headers.origin;
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(requestOrigin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }
  if (requestOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve the UI
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ui')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getUIHTML());
    return;
  }

  // SSE endpoint for live updates
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    clients.add(res);

    // Send current state
    res.write(`data: ${JSON.stringify({ type: 'init', downloads: Array.from(downloads.values()) })}\n\n`);

    req.on('close', () => clients.delete(res));
    return;
  }

  // Get all downloads
  if (req.method === 'GET' && req.url === '/downloads') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.from(downloads.values())));
    return;
  }

  if (req.method === 'GET' && req.url === '/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settingsPayload()));
    return;
  }

  if (req.method === 'POST' && req.url === '/settings') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const candidate = input.reset === true ? { ...DEFAULT_SETTINGS } : input;
        const validation = validateSettings(candidate, {
          base: input.reset === true ? DEFAULT_SETTINGS : serverSettings,
          checkFilesystem: true
        });
        if (validation.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: validation.error }));
          return;
        }

        saveSettings(validation.settings);
        serverSettings = validation.settings;
        markActivity();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(settingsPayload()));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Could not save settings' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/settings/select-folder') {
    markActivity();
    selectDownloadDirectory()
      .then(result => {
        if (result.path) {
          serverSettings = { ...serverSettings, downloadDirectory: result.path };
          saveSettings(serverSettings);
          result = { ...settingsPayload(), selected: true };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(error => {
        res.writeHead(['darwin', 'linux'].includes(process.platform) ? 500 : 501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });
    return;
  }

  const clearDownloadMatch = req.method === 'POST'
    ? req.url.match(/^\/downloads\/clear(?:\/(\d+))?$/)
    : null;
  if (clearDownloadMatch) {
    const requestedId = clearDownloadMatch[1] ? Number(clearDownloadMatch[1]) : null;
    const result = clearDownloadHistory(downloads, requestedId);

    if (result.reason === 'not_found') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Download history item not found' }));
      return;
    }
    if (result.reason === 'active') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Active downloads cannot be cleared' }));
      return;
    }

    markActivity();
    broadcast({ type: 'history-cleared', ids: result.clearedIds });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, clearedIds: result.clearedIds }));
    return;
  }

  // Explicit extension activity resets the idle deadline. Passive health and
  // progress-page polling intentionally do not.
  if (req.method === 'POST' && req.url === '/wake') {
    markActivity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, idleDeadline: lastActivityAt + IDLE_TIMEOUT_MS }));
    return;
  }

  // Start download
  if (req.method === 'POST' && req.url === '/download') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { url, filename, referer, origin, userAgent, cookies, requestHeaders, mediaType } = JSON.parse(body);

        if (!isHttpUrl(url)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A valid HTTP(S) URL is required' }));
          return;
        }

        markActivity();

        const existingDownload = Array.from(downloads.values()).find(
          download => download.fullUrl === url && isActiveDownload(download)
        );
        if (existingDownload) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            id: existingDownload.id,
            alreadyRunning: true,
            message: 'Download already running',
            downloadDir: existingDownload.downloadDir || serverSettings.downloadDirectory
          }));
          return;
        }

        trimDownloadHistory();

        const id = ++downloadId;
        const downloadSettings = { ...serverSettings };
        const cleanFilename = safeFilename(filename);
        const download = {
          id,
          url: url.substring(0, 80) + (url.length > 80 ? '...' : ''),
          status: 'starting',
          percent: 0,
          speed: '-',
          eta: '-',
          size: '-',
          fragments: '-',
          filename: cleanFilename || 'Detecting...',
          downloadDir: downloadSettings.downloadDirectory,
          startTime: Date.now()
        };
        // Keep the signed source URL server-side without retransmitting it on
        // every progress event.
        Object.defineProperty(download, 'fullUrl', { value: url });

        downloads.set(id, download);
        broadcast({ type: 'new', download });

        console.log(`\n📥 [${id}] Starting download...`);

        let cookieJar = null;
        try {
          const capturedCookies = cookiesFromRequestHeader(requestHeaders, url);
          cookieJar = createCookieJar([...(Array.isArray(cookies) ? cookies : []), ...capturedCookies], id);
        } catch (error) {
          console.warn(`⚠️  [${id}] Could not prepare browser cookies: ${error.message}`);
        }

        const args = buildYtDlpArgs({
          url,
          filename: cleanFilename,
          referer,
          origin,
          userAgent,
          cookieFile: cookieJar?.file,
          requestHeaders,
          downloadDirectory: downloadSettings.downloadDirectory,
          videoOutput: downloadSettings.videoOutput,
          mediaType: mediaType === 'audio' ? 'audio' : 'video',
          concurrentFragments: downloadSettings.concurrentFragments
        });
        const ytdlp = spawn('yt-dlp', args, {
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          detached: true // Allow killing entire process group
        });

        // Store process reference for stopping
        processes.set(id, ytdlp);

        const processOutput = (data, isStderr) => {
          const text = data.toString();
          const lines = text.split('\n');

          lines.forEach(line => {
            if (!line.trim()) return;

            // Keep terminal I/O small; the web UI receives parsed progress.
            if (isStderr && /(?:ERROR|WARNING):/.test(line)) {
              console.error(`[${id}] ${line}`);
            }

            // Parse progress info
            const progress = parseProgress(line, download);
            if (progress) {
              if (progress.percent !== undefined) {
                download.percent = progress.percent;
                download.status = 'downloading';
              }
              if (progress.speed) download.speed = progress.speed;
              if (progress.eta) download.eta = progress.eta;
              if (progress.size) download.size = progress.size;
              if (progress.fragments) download.fragments = progress.fragments;
              if (progress.filename) download.filename = progress.filename;
              if (progress.error) download.error = progress.error;
              if (progress.status) download.status = progress.status;
              if (progress.time) download.time = progress.time;

              broadcast({ type: 'progress', id, download });
            }
          });
        };

        ytdlp.stdout.on('data', (data) => processOutput(data, false));
        ytdlp.stderr.on('data', (data) => processOutput(data, true));

        ytdlp.on('error', (error) => {
          processes.delete(id);
          removeCookieJar(cookieJar);
          download.status = 'error';
          download.error = error.code === 'ENOENT'
            ? 'yt-dlp was not found. Install it and restart the server.'
            : error.message;
          console.error(`❌ [${id}] ${download.error}`);
          markActivity();
          broadcast({ type: 'complete', id, download });
        });

        ytdlp.on('close', (code) => {
          processes.delete(id); // Clean up process reference
          removeCookieJar(cookieJar);

          if (download.status === 'stopped') {
            // Already marked as stopped, don't change status
            console.log(`🛑 [${id}] Download stopped by user`);
          } else if (download.status === 'error') {
            // The process error handler already provided the useful message.
          } else if (code === 0) {
            download.status = 'complete';
            download.percent = 100;
            download.eta = '-';
            refreshCompletedFileMetadata(download);
            console.log(`✅ [${id}] Download complete!`);
          } else {
            download.status = 'error';
            download.error = download.error || `yt-dlp exited with code ${code}`;
            console.log(`❌ [${id}] Download failed with code ${code}`);
          }
          markActivity();
          broadcast({ type: 'complete', id, download });
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          id,
          message: 'Download started',
          downloadDir: download.downloadDir
        }));

      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Stop download endpoint
  if (req.method === 'POST' && req.url.startsWith('/stop/')) {
    const id = parseInt(req.url.split('/')[2]);
    const download = downloads.get(id);
    const proc = processes.get(id);

    if (proc && download) {
      markActivity();
      download.status = 'stopped';
      // Kill entire process tree (yt-dlp + ffmpeg children)
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch (e) {
        proc.kill('SIGKILL');
      }
      processes.delete(id);
      broadcast({ type: 'complete', id, download });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Download stopped' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Download not found or already finished' }));
    }
    return;
  }

  // Status endpoint
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      service: 'video-downloader',
      version: SERVER_VERSION,
      downloadDir: serverSettings.downloadDirectory,
      activeDownloads: Array.from(downloads.values()).filter(isActiveDownload).length,
      concurrentFragments: serverSettings.concurrentFragments,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      idleDeadline: processes.size === 0 ? lastActivityAt + IDLE_TIMEOUT_MS : null
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function getUIHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Video Downloads</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
      padding: 40px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 {
      font-size: 28px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    h1::before { content: "▶"; color: #00d4ff; }
    .subtitle { color: #888; margin-bottom: 32px; }
    .downloads { display: flex; flex-direction: column; gap: 16px; }
    .download-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .download-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
      gap: 12px;
    }
    .filename {
      font-weight: 600;
      font-size: 16px;
      word-break: break-all;
      flex: 1;
    }
    .status {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .status.downloading { background: #3b82f6; }
    .status.complete { background: #22c55e; }
    .status.error { background: #ef4444; }
    .status.starting { background: #f59e0b; }
    .status.merging { background: #8b5cf6; }
    .status.finalizing { background: #8b5cf6; }
    .status.stopped { background: #6b7280; }
    .stop-btn {
      background: #ef4444;
      color: #fff;
      border: none;
      padding: 6px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      margin-left: 8px;
    }
    .stop-btn:hover { background: #dc2626; }
    .stop-btn:disabled { background: #666; cursor: not-allowed; }
    .progress-container {
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      height: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #00d4ff, #00ff88);
      border-radius: 8px;
      transition: width 0.3s ease;
    }
    .progress-bar.indeterminate {
      width: 30% !important;
      animation: indeterminate 1.5s infinite ease-in-out;
    }
    @keyframes indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      color: #aaa;
      font-size: 13px;
    }
    .stat { display: flex; align-items: center; gap: 6px; }
    .stat-value { color: #fff; font-weight: 500; }
    .empty {
      text-align: center;
      padding: 60px;
      color: #666;
    }
    .empty-icon { font-size: 48px; margin-bottom: 16px; }
    .time-elapsed { color: #888; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Video Downloads</h1>
    <p class="subtitle">Downloads save to the folder configured in the extension</p>
    <div id="downloads" class="downloads">
      <div class="empty">
        <div class="empty-icon">📭</div>
        <p>No downloads yet. Use the browser extension to start downloading.</p>
      </div>
    </div>
  </div>
  <script>
    const downloadsEl = document.getElementById('downloads');
    const downloads = new Map();

    function formatDuration(ms) {
      const seconds = Math.floor(ms / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return mins > 0 ? \`\${mins}m \${secs}s\` : \`\${secs}s\`;
    }

    function renderDownloads() {
      if (downloads.size === 0) {
        downloadsEl.innerHTML = \`
          <div class="empty">
            <div class="empty-icon">📭</div>
            <p>No downloads yet. Use the browser extension to start downloading.</p>
          </div>\`;
        return;
      }

      const now = Date.now();

      downloadsEl.innerHTML = Array.from(downloads.values())
        .sort((a, b) => b.id - a.id)
        .map(d => {
          const isActive = d.status === 'downloading' || d.status === 'starting' || d.status === 'merging';
          const elapsed = formatDuration(now - d.startTime);
          const showIndeterminate = isActive && d.percent === 0;

          return \`
          <div class="download-card">
            <div class="download-header">
              <div class="filename">\${escapeHtml(d.filename)}</div>
              <div>
                <span class="status \${d.status}">\${d.status}</span>
                \${isActive ? \`<button class="stop-btn" onclick="stopDownload(\${d.id})">Stop</button>\` : ''}
              </div>
            </div>
            <div class="progress-container">
              <div class="progress-bar \${showIndeterminate ? 'indeterminate' : ''}" style="width: \${d.percent}%"></div>
            </div>
            <div class="stats">
              <div class="stat">Progress: <span class="stat-value">\${d.percent.toFixed(1)}%</span></div>
              \${d.fragments && d.fragments !== '-' ? \`<div class="stat">Fragments: <span class="stat-value">\${d.fragments}</span></div>\` : ''}
              <div class="stat">Size: <span class="stat-value">\${d.size}</span></div>
              <div class="stat">Speed: <span class="stat-value">\${d.speed}</span></div>
              <div class="stat">ETA: <span class="stat-value">\${d.eta}</span></div>
            </div>
            <div class="time-elapsed">Elapsed: \${elapsed}</div>
          </div>
        \`}).join('');
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Connect to SSE
    const events = new EventSource('/events');

    events.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.type === 'init') {
        data.downloads.forEach(d => downloads.set(d.id, d));
      } else if (data.type === 'new' || data.type === 'progress' || data.type === 'complete') {
        downloads.set(data.download.id, data.download);
      } else if (data.type === 'history-cleared') {
        data.ids.forEach(id => downloads.delete(id));
      }

      renderDownloads();
    };

    events.onerror = () => {
      console.log('Connection lost, reconnecting...');
    };

    // Update elapsed time every second
    setInterval(renderDownloads, 1000);

    // Stop download function - must be global for onclick
    window.stopDownload = async function(id) {
      console.log('Stopping download', id);
      try {
        const response = await fetch('/stop/' + id, { method: 'POST' });
        const data = await response.json();
        console.log('Stop response:', data);
      } catch (e) {
        console.error('Failed to stop download:', e);
      }
    };
  </script>
</body>
</html>`;
}

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    startIdleReaper();
    console.log(`
╔════════════════════════════════════════════╗
║     Video Download Server v2               ║
╠════════════════════════════════════════════╣
║  Server:  http://127.0.0.1:${PORT}            ║
║  Web UI:  http://127.0.0.1:${PORT}            ║
║  Downloads: configured in extension        ║
║  Idle stop: ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes                       ║
║                                            ║
║  Press Ctrl+C to stop.                     ║
╚════════════════════════════════════════════╝
`);
  });
}

module.exports = {
  DEFAULT_SETTINGS,
  buildYtDlpArgs,
  clearDownloadHistory,
  createCookieJar,
  cookiesFromRequestHeader,
  formatByteSize,
  isAllowedHost,
  isAllowedOrigin,
  isHttpUrl,
  loadSettings,
  linuxFolderPickerCommands,
  macFolderPickerArgs,
  parseProgress,
  pickFolder,
  removeCookieJar,
  safeFilename,
  serializeNetscapeCookies,
  selectDownloadDirectory,
  shouldExitForInactivity,
  startIdleReaper,
  stopIdleReaper,
  validateSettings,
  server
};
