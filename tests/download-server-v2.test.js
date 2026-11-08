const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  DEFAULT_SETTINGS,
  buildYtDlpArgs,
  clearDownloadHistory,
  createCookieJar,
  cookiesFromRequestHeader,
  formatByteSize,
  isAllowedHost,
  isAllowedOrigin,
  isHttpUrl,
  linuxFolderPickerCommands,
  macFolderPickerArgs,
  parseProgress,
  removeCookieJar,
  safeFilename,
  shouldExitForInactivity,
  validateSettings
} = require('../download-server-v2');

test('uses the native concurrent fragment downloader without verbose output', () => {
  const args = buildYtDlpArgs({ url: 'https://cdn.example/video/master.m3u8' });
  const concurrencyIndex = args.indexOf('--concurrent-fragments');

  assert.notEqual(concurrencyIndex, -1);
  assert.equal(args[concurrencyIndex + 1], '8');
  assert.equal(args.includes('--downloader'), false);
  assert.equal(args.includes('--verbose'), false);
  assert.equal(args.at(-1), 'https://cdn.example/video/master.m3u8');
});

test('passes a YouTube watch page to yt-dlp as one title-based download', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const args = buildYtDlpArgs({ url });
  const outputIndex = args.indexOf('-o');

  assert.equal(args.includes('--no-playlist'), true);
  assert.deepEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', 'mp4']);
  assert.match(args[outputIndex + 1], /%\(title\)s\.%\(ext\)s$/);
  assert.equal(args.at(-1), url);
});

test('applies compatible MP4 output to generic video streams', () => {
  const args = buildYtDlpArgs({ url: 'https://cdn.example/video/master.m3u8' });
  assert.deepEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', 'mp4']);
});

test('keeps audio streams out of the MP4 video preset', () => {
  const args = buildYtDlpArgs({
    url: 'https://cdn.example/audio/master.m3u8',
    mediaType: 'audio'
  });
  assert.equal(args.includes('-t'), false);
});

test('applies configurable output folder, format, and fragment concurrency', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const args = buildYtDlpArgs({
    url,
    downloadDirectory: '/tmp/media-downloader-test',
    videoOutput: 'best-quality',
    concurrentFragments: 12
  });
  const outputIndex = args.indexOf('-o');
  const concurrencyIndex = args.indexOf('--concurrent-fragments');

  assert.match(args[outputIndex + 1], /^\/tmp\/media-downloader-test\//);
  assert.equal(args[concurrencyIndex + 1], '12');
  assert.equal(args.includes('-t'), false);
});

test('validates persisted settings and rejects unsafe folder values', () => {
  const valid = validateSettings({
    ...DEFAULT_SETTINGS,
    downloadDirectory: '/tmp',
    concurrentFragments: 4,
    historyLimit: 5
  });
  assert.deepEqual(valid.settings, {
    ...DEFAULT_SETTINGS,
    downloadDirectory: '/tmp',
    concurrentFragments: 4,
    historyLimit: 5
  });

  assert.match(
    validateSettings({ ...DEFAULT_SETTINGS, downloadDirectory: '../relative' }).error,
    /absolute path/
  );
  assert.match(
    validateSettings({ ...DEFAULT_SETTINGS, historyLimit: 7 }).error,
    /History limit/
  );
});

test('migrates the former YouTube-only output setting', () => {
  const legacy = { ...DEFAULT_SETTINGS };
  delete legacy.videoOutput;
  legacy.youtubeFormat = 'best-quality';

  assert.equal(validateSettings(legacy).settings.videoOutput, 'best-quality');
});

test('builds a native macOS folder chooser without interpolating the path into AppleScript', () => {
  const folder = '/Users/example/My Videos';
  const args = macFolderPickerArgs(folder);

  assert.equal(args.at(-1), folder);
  assert.match(args.join(' '), /chooseFolder/);
  assert.equal(args.slice(0, -1).some(arg => arg.includes(folder)), false);
});

test('offers Linux folder choosers in preference order with the path as a discrete argument', () => {
  const folder = '/home/example/My Videos';
  const commands = linuxFolderPickerCommands(folder);

  assert.deepEqual(commands.map(([command]) => command), ['zenity', 'kdialog', 'omarchy-file-select']);
  for (const [, args] of commands) {
    assert.equal(args.some(arg => arg.startsWith('--directory') || arg === '--getexistingdirectory'), true);
  }
  assert.equal(commands[0][1].includes(`--filename=${folder}/`), true);
  assert.equal(commands[1][1].includes(folder), true);
});

test('clears completed history without removing active downloads', () => {
  const downloads = new Map([
    [1, { id: 1, status: 'complete' }],
    [2, { id: 2, status: 'downloading' }],
    [3, { id: 3, status: 'error' }]
  ]);

  assert.deepEqual(clearDownloadHistory(downloads, 1), { clearedIds: [1] });
  assert.deepEqual(clearDownloadHistory(downloads, 2), { clearedIds: [], reason: 'active' });
  assert.deepEqual(clearDownloadHistory(downloads), { clearedIds: [3] });
  assert.deepEqual([...downloads.keys()], [2]);
});

test('formats final on-disk sizes for the progress UI', () => {
  assert.equal(formatByteSize(10_941_384), '10.43MiB');
  assert.equal(formatByteSize(1024), '1.00KiB');
});

test('forwards safe browser request context and strips header injection', () => {
  const args = buildYtDlpArgs({
    url: 'https://cdn.example/video/master.m3u8',
    referer: 'https://example.com/watch/1',
    origin: 'https://example.com/path',
    userAgent: 'Browser\r\nInjected: true'
  });

  assert.deepEqual(args.slice(args.indexOf('--referer'), args.indexOf('--referer') + 2), [
    '--referer',
    'https://example.com/watch/1'
  ]);
  assert.ok(args.includes('Origin:https://example.com'));
  assert.ok(args.includes('BrowserInjected: true'));
});

test('prefers captured media headers and converts its cookie header', () => {
  const requestHeaders = {
    authorization: 'Bearer stream-token',
    cookie: 'session=abc123; signed=value=with=equals',
    origin: 'https://player.example',
    referer: 'https://player.example/embed/1',
    'user-agent': 'Captured Browser'
  };
  const args = buildYtDlpArgs({
    url: 'https://cdn.example/opaque-stream',
    referer: 'https://wrong.example',
    requestHeaders
  });

  assert.ok(args.includes('https://player.example/embed/1'));
  assert.ok(args.includes('Origin:https://player.example'));
  assert.ok(args.includes('authorization:Bearer stream-token'));
  assert.ok(args.includes('Captured Browser'));

  const cookies = cookiesFromRequestHeader(requestHeaders, 'https://cdn.example/opaque-stream');
  assert.deepEqual(cookies.map(cookie => [cookie.domain, cookie.name, cookie.value]), [
    ['cdn.example', 'session', 'abc123'],
    ['cdn.example', 'signed', 'value=with=equals']
  ]);
});

test('creates a private temporary cookie jar and passes it to yt-dlp', (t) => {
  const cookieJar = createCookieJar([{
    domain: '.example.com',
    expirationDate: 2_000_000_000,
    hostOnly: false,
    httpOnly: true,
    name: 'session',
    path: '/',
    secure: true,
    value: 'secret\r\nvalue'
  }], 'test');
  t.after(() => removeCookieJar(cookieJar));

  assert.ok(cookieJar);
  assert.equal(fs.statSync(cookieJar.file).mode & 0o777, 0o600);
  const contents = fs.readFileSync(cookieJar.file, 'utf8');
  assert.match(contents, /^# Netscape HTTP Cookie File/);
  assert.match(contents, /#HttpOnly_\.example\.com\tTRUE\t\/\tTRUE\t2000000000\tsession\tsecretvalue/);

  const args = buildYtDlpArgs({
    url: 'https://cdn.example/video.m3u8',
    cookieFile: cookieJar.file
  });
  assert.deepEqual(args.slice(args.indexOf('--cookies'), args.indexOf('--cookies') + 2), [
    '--cookies',
    cookieJar.file
  ]);
});

test('rejects unsafe URL schemes and keeps output filenames inside Downloads', () => {
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('https://example.com/video'), true);
  assert.equal(safeFilename('../../outside.mp4'), 'outside.mp4');
});

test('only permits this extension and local UI origins', () => {
  assert.equal(isAllowedOrigin('chrome-extension://pjegapeinfppenlhmokdigfjgcdpjidk'), true);
  assert.equal(isAllowedOrigin('chrome-extension://pjegapeinfppenlhmokdigfjgcdpjidk/'), true);
  assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), false);
  assert.equal(isAllowedOrigin('chrome-extension://abc123'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9876'), true);
  assert.equal(isAllowedOrigin('https://malicious.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
});

test('rejects foreign Host headers to block DNS rebinding', () => {
  assert.equal(isAllowedHost('127.0.0.1:9876'), true);
  assert.equal(isAllowedHost('localhost:9876'), true);
  assert.equal(isAllowedHost('evil.example:9876'), false);
  assert.equal(isAllowedHost(undefined), false);
});

test('ends option parsing before the URL', () => {
  const args = buildYtDlpArgs({ url: 'https://cdn.example/a.m3u8' });
  assert.equal(args.at(-2), '--');
});

test('parses yt-dlp fragment progress', () => {
  const progress = parseProgress(
    '[download]  45.2% of 125.36MiB at 2.35MiB/s ETA 00:32 (frag 54/120)',
    {}
  );

  assert.equal(progress.percent, 45.2);
  assert.equal(progress.size, '125.36MiB');
  assert.equal(progress.speed, '2.35MiB/s');
  assert.equal(progress.eta, '00:32');
  assert.equal(progress.fragments, '54/120');
});

test('captures yt-dlp terminal errors for the extension progress UI', () => {
  const progress = parseProgress(
    'ERROR: Unable to rename file: source part file was not found',
    {}
  );

  assert.deepEqual(progress, {
    status: 'error',
    error: 'Unable to rename file: source part file was not found'
  });
});

test('idle reaper never stops active downloads and reaps inactive servers', () => {
  const base = {
    now: 10_000,
    lastActivity: 1_000,
    idleTimeoutMs: 5_000
  };
  assert.equal(shouldExitForInactivity({ ...base, activeDownloads: 1 }), false);
  assert.equal(shouldExitForInactivity({ ...base, activeDownloads: 0 }), true);
  assert.equal(shouldExitForInactivity({ ...base, lastActivity: 8_000, activeDownloads: 0 }), false);
});
