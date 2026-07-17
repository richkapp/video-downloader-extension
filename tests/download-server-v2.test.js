const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  buildYtDlpArgs,
  createCookieJar,
  cookiesFromRequestHeader,
  isAllowedOrigin,
  isHttpUrl,
  parseProgress,
  removeCookieJar,
  safeFilename,
  shouldExitForInactivity
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

test('only permits extension and local UI origins', () => {
  assert.equal(isAllowedOrigin('chrome-extension://abc123'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9876'), true);
  assert.equal(isAllowedOrigin('https://malicious.example'), false);
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
