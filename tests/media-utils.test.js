const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  dedupeMedia,
  getMediaSize,
  getResponseSizeInfo,
  getResponseTotalBytes,
  getUrlMetadata,
  getYouTubeVideoPage,
  isActiveDownloadStatus,
  normalizedDownloadPercent,
  sortDownloadsForDisplay,
  sortMediaLargestFirst
} = require('../media-utils');

function youtubeUrl(params) {
  return `https://rr2---sn-example.googlevideo.com/videoplayback?${new URLSearchParams(params)}`;
}

test('parses useful metadata from a YouTube video stream URL', () => {
  const metadata = getUrlMetadata(youtubeUrl({
    id: 'video-123',
    itag: '137',
    mime: 'video/mp4; codecs="avc1.640028"',
    clen: '157286400',
    dur: '125.5'
  }));

  assert.equal(metadata.sourceLabel, 'YouTube');
  assert.equal(metadata.format, 'MP4');
  assert.equal(metadata.quality, '1080p');
  assert.equal(metadata.streamKind, 'Video only');
  assert.equal(metadata.contentLength, 157286400);
  assert.equal(metadata.duration, 125.5);
  assert.equal(metadata.codec, 'avc1.640028');
});

test('recognizes YouTube audio-only formats', () => {
  const metadata = getUrlMetadata(youtubeUrl({
    id: 'video-123',
    itag: '140',
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    clen: '5242880',
    dur: '125.5',
    bitrate: '128000'
  }));

  assert.equal(metadata.mediaType, 'audio');
  assert.equal(metadata.format, 'M4A');
  assert.equal(metadata.streamKind, 'Audio only');
  assert.equal(metadata.bitrate, 128000);
});

test('canonicalizes YouTube video pages and rejects non-video pages', () => {
  assert.equal(
    getYouTubeVideoPage('https://www.youtube.com/watch?v=erg7Vvgg2y3E&list=queue&t=15'),
    'https://www.youtube.com/watch?v=erg7Vvgg2y3E'
  );
  assert.equal(
    getYouTubeVideoPage('https://youtu.be/erg7Vvgg2y3E?si=tracking'),
    'https://www.youtube.com/watch?v=erg7Vvgg2y3E'
  );
  assert.equal(
    getYouTubeVideoPage('https://www.youtube.com/shorts/erg7Vvgg2y3E'),
    'https://www.youtube.com/watch?v=erg7Vvgg2y3E'
  );
  assert.equal(getYouTubeVideoPage('https://www.youtube.com/'), null);
  assert.equal(getYouTubeVideoPage('https://example.com/watch?v=erg7Vvgg2y3E'), null);
});

test('groups repeated YouTube range requests for the same stream', () => {
  const base = {
    id: 'video-123',
    itag: '137',
    mime: 'video/mp4',
    clen: '157286400',
    dur: '125.5'
  };
  const media = dedupeMedia([
    {
      url: youtubeUrl({ ...base, range: '0-1048575', rn: '1' }),
      type: 'Video',
      mediaType: 'video',
      timestamp: 1
    },
    {
      url: youtubeUrl({ ...base, range: '1048576-2097151', rn: '2' }),
      type: 'Video',
      mediaType: 'video',
      timestamp: 2
    },
    {
      url: youtubeUrl(base),
      type: 'Video',
      mediaType: 'video',
      timestamp: 3,
      requestHeaders: { referer: 'https://www.youtube.com/' }
    }
  ]);

  assert.equal(media.length, 1);
  assert.equal(media[0].duplicateCount, 3);
  assert.equal(new URL(media[0].url).searchParams.has('range'), false);
  assert.equal(media[0].totalBytes, 157286400);
});

test('sorts known sizes largest first and unknown sizes last', () => {
  const sorted = sortMediaLargestFirst([
    { url: 'https://example.com/unknown.mp4', quality: '2160p' },
    { url: 'https://example.com/small.mp4', totalBytes: 10_000_000, quality: '720p' },
    { url: 'https://example.com/hls.m3u8', hlsInfo: { estimatedSize: 50_000_000, resolution: '1920x1080' } },
    { url: 'https://example.com/large.mp4', totalBytes: 100_000_000, quality: '1080p' }
  ]);

  assert.deepEqual(sorted.map(media => media.url), [
    'https://example.com/large.mp4',
    'https://example.com/hls.m3u8',
    'https://example.com/small.mp4',
    'https://example.com/unknown.mp4'
  ]);
  assert.equal(getMediaSize(sorted[1]), 50_000_000);
});

test('prefers full response size headers over ranged chunk length', () => {
  assert.equal(getResponseTotalBytes([
    { name: 'Content-Length', value: '1048576' },
    { name: 'Content-Range', value: 'bytes 0-1048575/157286400' }
  ]), 157286400);

  assert.equal(getResponseTotalBytes([
    { name: 'Content-Length', value: '1048576' },
    { name: 'X-Goog-Stored-Content-Length', value: '209715200' }
  ]), 209715200);

  assert.deepEqual(getResponseSizeInfo([
    { name: 'Content-Length', value: '1048576' }
  ], 206), { bytes: 1048576, isTotal: false });

  assert.deepEqual(getResponseSizeInfo([
    { name: 'Content-Length', value: '157286400' }
  ], 200), { bytes: 157286400, isTotal: true });
});

test('does not present a YouTube response chunk as the full file size', () => {
  const [media] = dedupeMedia([{
    url: youtubeUrl({ id: 'video-123', itag: '137', mime: 'video/mp4', range: '0-1048575' }),
    type: 'Video',
    mediaType: 'video',
    contentLength: 1_048_576
  }]);

  assert.equal(getMediaSize(media), null);
});

test('uses a verified total response size for YouTube when URL metadata omits it', () => {
  const [media] = dedupeMedia([{
    url: youtubeUrl({ id: 'video-123', itag: '137', mime: 'video/mp4', range: '0-1048575' }),
    type: 'Video',
    mediaType: 'video',
    contentLength: 157_286_400,
    contentLengthIsTotal: true
  }]);

  assert.equal(getMediaSize(media), 157_286_400);
});

test('keeps distinct non-YouTube files separate', () => {
  const media = dedupeMedia([
    { url: 'https://cdn.example.com/video-720.mp4', contentLength: 10_000_000 },
    { url: 'https://cdn.example.com/video-1080.mp4', contentLength: 20_000_000 }
  ]);

  assert.equal(media.length, 2);
});

test('loads the shared metadata helper before both extension consumers', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const popup = readFileSync(path.join(projectRoot, 'popup.html'), 'utf8');
  const background = readFileSync(path.join(projectRoot, 'background.js'), 'utf8');

  assert.ok(popup.indexOf('src="media-utils.js"') < popup.indexOf('src="popup.js"'));
  assert.match(background, /^importScripts\('media-utils\.js'\);/);
});

test('wires accessible settings tabs to the persistent server API', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const popup = readFileSync(path.join(projectRoot, 'popup.html'), 'utf8');
  const popupScript = readFileSync(path.join(projectRoot, 'popup.js'), 'utf8');

  assert.match(popup, /role="tablist"/);
  assert.match(popup, /id="settingsView"[^>]+role="tabpanel"/);
  assert.match(popup, /id="settingsForm"/);
  assert.match(popupScript, /fetch\(`\$\{SERVER_BASE_URL\}\/settings`/);
  assert.match(popupScript, /function selectPopupTab/);
});

test('orders active downloads first and clamps persisted progress values', () => {
  const sorted = sortDownloadsForDisplay([
    { id: 3, status: 'complete', percent: 100 },
    { id: 2, status: 'downloading', percent: 47.25 },
    { id: 4, status: 'error', percent: 98.1 },
    { id: 1, status: 'merging', percent: 105 }
  ], 3);

  assert.deepEqual(sorted.map(download => download.id), [2, 1, 4]);
  assert.equal(isActiveDownloadStatus('merging'), true);
  assert.equal(isActiveDownloadStatus('complete'), false);
  assert.equal(normalizedDownloadPercent(sorted[0]), 47.25);
  assert.equal(normalizedDownloadPercent(sorted[1]), 100);
  assert.equal(normalizedDownloadPercent({ percent: -5 }), 0);
});
