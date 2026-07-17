// Store detected video URLs per tab
const videosByTab = new Map();
const requestContextByTab = new Map();
const MAX_MEDIA_PER_TAB = 200;
const MAX_REQUEST_CONTEXTS_PER_TAB = 300;
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'cookie',
  'origin',
  'referer',
  'user-agent'
]);

// Individual HLS/DASH fragments are not useful downloads. Recording them can
// add thousands of entries for a single video and eventually slow the service
// worker and popup to a crawl.
function isLikelyMediaSegment(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    return /\.(?:ts|m4s|m4f|cmfv|cmfa)$/i.test(path) ||
      /(?:^|[/_.-])(?:segment|seg|fragment|frag|chunk|part)[-_.]?\d+(?:[/_.-]|$)/i.test(path) ||
      /[?&](?:segment|seg|fragment|frag|chunk|part)=\d+(?:&|$)/i.test(parsed.search);
  } catch (error) {
    return false;
  }
}

function getTabMedia(tabId) {
  if (!videosByTab.has(tabId)) {
    videosByTab.set(tabId, new Map());
  }
  return videosByTab.get(tabId);
}

function makeRoomForMedia(media) {
  while (media.size >= MAX_MEDIA_PER_TAB) {
    media.delete(media.keys().next().value);
  }
}

function getRequestContexts(tabId) {
  if (!requestContextByTab.has(tabId)) {
    requestContextByTab.set(tabId, new Map());
  }
  return requestContextByTab.get(tabId);
}

function getRequestContext(tabId, url) {
  return requestContextByTab.get(tabId)?.get(url) || null;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || !['media', 'xmlhttprequest'].includes(details.type)) return;

    const requestHeaders = {};
    for (const header of details.requestHeaders || []) {
      const name = header.name.toLowerCase();
      if (FORWARDED_REQUEST_HEADERS.has(name) && typeof header.value === 'string') {
        requestHeaders[name] = header.value;
      }
    }
    if (Object.keys(requestHeaders).length === 0) return;

    const contexts = getRequestContexts(details.tabId);
    if (!contexts.has(details.url) && contexts.size >= MAX_REQUEST_CONTEXTS_PER_TAB) {
      contexts.delete(contexts.keys().next().value);
    }
    contexts.set(details.url, requestHeaders);

    const media = videosByTab.get(details.tabId)?.get(details.url);
    if (media) media.requestHeaders = requestHeaders;
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// Video file extensions and patterns
const VIDEO_PATTERNS = [
  /\.mp4(\?|$|#)/i,
  /\.webm(\?|$|#)/i,
  /\.m3u8(\?|$|#)/i,
  /\.mpd(\?|$|#)/i,
  /\.m4v(\?|$|#)/i,
  /\.mov(\?|$|#)/i,
  /\.avi(\?|$|#)/i,
  /\.mkv(\?|$|#)/i,
  /videoplayback/i,
  /video\/mp4/i,
  /video\/webm/i,
  /\/video\//i,
  /streaming/i,
  /manifest.*\.m3u8/i,
  /playlist.*\.m3u8/i,
  /chunklist/i,
  /\.f4v(\?|$|#)/i,
  /\.flv(\?|$|#)/i,
];

// Audio file extensions and patterns
const AUDIO_PATTERNS = [
  /\.mp3(\?|$|#)/i,
  /\.m4a(\?|$|#)/i,
  /\.aac(\?|$|#)/i,
  /\.ogg(\?|$|#)/i,
  /\.oga(\?|$|#)/i,
  /\.opus(\?|$|#)/i,
  /\.wav(\?|$|#)/i,
  /\.flac(\?|$|#)/i,
  /\.wma(\?|$|#)/i,
  /\.aiff(\?|$|#)/i,
  /\.alac(\?|$|#)/i,
  /audioplayback/i,
  /audio\/mpeg/i,
  /audio\/mp3/i,
  /audio\/mp4/i,
  /audio\/aac/i,
  /\/audio\//i,
  /\/podcast\//i,
  /\/podcasts\//i,
  /\.podcast(\?|$|#)/i,
];

// Patterns to EXCLUDE (images, fonts, etc.)
const EXCLUDE_PATTERNS = [
  /\.jpg(\?|$|#)/i,
  /\.jpeg(\?|$|#)/i,
  /\.png(\?|$|#)/i,
  /\.gif(\?|$|#)/i,
  /\.svg(\?|$|#)/i,
  /\.webp(\?|$|#)/i,
  /\.ico(\?|$|#)/i,
  /\.woff/i,
  /\.ttf/i,
  /\.css(\?|$|#)/i,
  /\.js(\?|$|#)/i,
  /google.*\.com.*\/js\//i,
  /analytics/i,
  /facebook/i,
  /twitter/i,
  /advertisement/i,
  /\/ads\//i,
];

function isVideoUrl(url) {
  // First check exclusions
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(url)) {
      return false;
    }
  }

  // Then check if it matches video patterns
  for (const pattern of VIDEO_PATTERNS) {
    if (pattern.test(url)) {
      return true;
    }
  }

  return false;
}

function isAudioUrl(url) {
  // First check exclusions
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(url)) {
      return false;
    }
  }

  // Then check if it matches audio patterns
  for (const pattern of AUDIO_PATTERNS) {
    if (pattern.test(url)) {
      return true;
    }
  }

  return false;
}

function getVideoType(url) {
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  if (/\.m4v/i.test(url)) return 'M4V';
  if (/\.mov/i.test(url)) return 'MOV';
  if (/\.mkv/i.test(url)) return 'MKV';
  if (/\.flv/i.test(url)) return 'FLV';
  return 'Video';
}

function getAudioType(url) {
  if (/\.mp3/i.test(url)) return 'MP3';
  if (/\.m4a/i.test(url)) return 'M4A';
  if (/\.aac/i.test(url)) return 'AAC';
  if (/\.ogg/i.test(url)) return 'OGG';
  if (/\.oga/i.test(url)) return 'OGG';
  if (/\.opus/i.test(url)) return 'OPUS';
  if (/\.wav/i.test(url)) return 'WAV';
  if (/\.flac/i.test(url)) return 'FLAC';
  if (/\.wma/i.test(url)) return 'WMA';
  if (/\.aiff/i.test(url)) return 'AIFF';
  if (/\.alac/i.test(url)) return 'ALAC';
  return 'Audio';
}

// Listen for web requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;

    if (tabId < 0) return; // Ignore requests not associated with a tab
    if (isLikelyMediaSegment(url)) return;

    // Check if this looks like a video
    if (isVideoUrl(url)) {
      const videos = getTabMedia(tabId);
      if (!videos.has(url)) {
        makeRoomForMedia(videos);
        videos.set(url, {
          url: url,
          type: getVideoType(url),
          mediaType: 'video',
          source: 'network',
          timestamp: Date.now(),
          contentLength: null,
          requestHeaders: getRequestContext(tabId, url)
        });
      }
    }

    // Check if this looks like audio
    if (isAudioUrl(url)) {
      const videos = getTabMedia(tabId);
      if (!videos.has(url)) {
        makeRoomForMedia(videos);
        videos.set(url, {
          url: url,
          type: getAudioType(url),
          mediaType: 'audio',
          source: 'network',
          timestamp: Date.now(),
          contentLength: null,
          requestHeaders: getRequestContext(tabId, url)
        });
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// Also check response headers for content-type
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;

    if (tabId < 0) return;
    if (isLikelyMediaSegment(url)) return;

    // Check Content-Type header
    const contentType = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-type'
    );

    if (contentType && contentType.value) {
      const type = contentType.value.toLowerCase();

      // Get content length if available
      const contentLength = details.responseHeaders?.find(
        h => h.name.toLowerCase() === 'content-length'
      );

      // Check for video content types
      if (type.includes('video/') ||
          type.includes('application/x-mpegurl') ||
          type.includes('application/vnd.apple.mpegurl') ||
          type.includes('application/dash+xml')) {

        const videos = getTabMedia(tabId);

        const videoType = type.includes('mp4') ? 'MP4' :
                         type.includes('webm') ? 'WebM' :
                         type.includes('mpegurl') ? 'HLS' :
                         type.includes('dash') ? 'DASH' : 'Video';

        if (!videos.has(url)) makeRoomForMedia(videos);
        videos.set(url, {
          url: url,
          type: videoType,
          mediaType: 'video',
          source: 'network (content-type)',
          timestamp: Date.now(),
          contentLength: contentLength ? parseInt(contentLength.value) : null,
          requestHeaders: getRequestContext(tabId, url)
        });
      }

      // Check for audio content types
      if (type.includes('audio/') ||
          type.includes('application/ogg') ||
          type.includes('application/x-ogg')) {

        const videos = getTabMedia(tabId);

        const audioType = type.includes('mpeg') || type.includes('mp3') ? 'MP3' :
                         type.includes('mp4') || type.includes('m4a') ? 'M4A' :
                         type.includes('aac') ? 'AAC' :
                         type.includes('ogg') ? 'OGG' :
                         type.includes('opus') ? 'OPUS' :
                         type.includes('wav') ? 'WAV' :
                         type.includes('flac') ? 'FLAC' :
                         type.includes('webm') ? 'WebM Audio' : 'Audio';

        if (!videos.has(url)) makeRoomForMedia(videos);
        videos.set(url, {
          url: url,
          type: audioType,
          mediaType: 'audio',
          source: 'network (content-type)',
          timestamp: Date.now(),
          contentLength: contentLength ? parseInt(contentLength.value) : null,
          requestHeaders: getRequestContext(tabId, url)
        });
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  videosByTab.delete(tabId);
  requestContextByTab.delete(tabId);
});

// A reused tab should not show media detected on the previous page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    videosByTab.delete(tabId);
    requestContextByTab.delete(tabId);
  }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getVideos') {
    const tabId = message.tabId;
    const videos = videosByTab.get(tabId);
    if (videos) {
      // Convert Map to array and sort by timestamp (newest first)
      const videoList = Array.from(videos.values())
        .sort((a, b) => b.timestamp - a.timestamp);
      sendResponse({ videos: videoList });
    } else {
      sendResponse({ videos: [] });
    }
  } else if (message.type === 'clearVideos') {
    const tabId = message.tabId;
    videosByTab.delete(tabId);
    requestContextByTab.delete(tabId);
    sendResponse({ success: true });
  }
  return false;
});
