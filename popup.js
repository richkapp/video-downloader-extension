const HLS_INFO_TIMEOUT_MS = 5000;
const HLS_INFO_CONCURRENCY = 6;
const MAX_HLS_INFO_PROBES = 12;
const MAX_FORWARDED_COOKIES = 200;
const SERVER_BASE_URL = 'http://127.0.0.1:9876';
const NATIVE_HOST_NAME = 'com.videodownloader.bootstrap';
let serverStartPromise = null;

async function getServerStatus(timeoutMs = 800) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVER_BASE_URL}/status`, { signal: controller.signal });
    if (!response.ok) return null;
    const status = await response.json();
    return status.status === 'running' ? status : null;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function wakeServer() {
  try {
    await fetch(`${SERVER_BASE_URL}/wake`, { method: 'POST' });
  } catch (error) {}
}

function callNativeHost(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || { success: false, error: 'Native host returned no response' });
    });
  });
}

async function startServerIfNeeded(showStatus = false) {
  const currentStatus = await getServerStatus();
  if (currentStatus) {
    await wakeServer();
    return { success: true, alreadyRunning: true, status: currentStatus };
  }

  if (showStatus) {
    const statusEl = document.getElementById('status');
    statusEl.className = 'status scanning';
    statusEl.textContent = 'Starting download server...';
  }

  try {
    const result = await callNativeHost({ command: 'ensureServer' });
    if (!result.success) throw new Error(result.error || 'Native host could not start the server');
    const status = await getServerStatus(1500);
    if (!status) throw new Error('Server started but did not answer its health check');
    window.serverStartupError = null;
    return { ...result, status };
  } catch (error) {
    window.serverStartupError = error.message;
    return { success: false, error: error.message };
  }
}

function ensureServerRunning(showStatus = false) {
  if (!serverStartPromise) {
    serverStartPromise = startServerIfNeeded(showStatus)
      .finally(() => { serverStartPromise = null; });
  }
  return serverStartPromise;
}

function isServerAvailabilityError(error) {
  return error.message.includes('Failed to fetch') ||
    error.message.includes('Automatic server startup failed') ||
    error.message.includes('Native host');
}

async function queryCookies(details) {
  try {
    return await chrome.cookies.getAll(details);
  } catch (error) {
    console.warn('Unable to read cookies for stream request:', error);
    return [];
  }
}

async function collectStreamCookies(mediaUrl, pageUrl) {
  const urls = [mediaUrl, pageUrl].filter(url => /^https?:/i.test(url));
  const queries = urls.map(url => queryCookies({ url }));

  // CHIPS/partitioned cookies are not returned by the default query. Query the
  // top-level site's partition as well when the browser supports it.
  try {
    const topLevelSite = new URL(pageUrl).origin;
    for (const url of urls) {
      queries.push(queryCookies({ url, partitionKey: { topLevelSite } }));
    }
  } catch (error) {}

  const cookies = (await Promise.all(queries)).flat();
  const unique = new Map();
  for (const cookie of cookies) {
    const partition = cookie.partitionKey?.topLevelSite || '';
    const key = `${cookie.storeId}|${partition}|${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (!unique.has(key)) unique.set(key, cookie);
    if (unique.size >= MAX_FORWARDED_COOKIES) break;
  }

  return Array.from(unique.values()).map(cookie => ({
    domain: cookie.domain,
    expirationDate: cookie.expirationDate,
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    secure: cookie.secure,
    value: cookie.value
  }));
}

// Get videos from background script (network monitoring)
async function getNetworkVideos(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getVideos', tabId }, (response) => {
      resolve(response?.videos || []);
    });
  });
}

// Find videos in page DOM
async function findPageVideos() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForVideos,
    });

    return results[0]?.result || [];
  } catch (error) {
    console.error('Error scanning page:', error);
    return [];
  }
}

// This function runs in the page context
function scanPageForVideos() {
  const media = new Map();

  // Strict video extensions only
  const VIDEO_EXTENSIONS = /\.(mp4|webm|m3u8|mpd|m4v|mov|mkv|avi|flv)(\?|$|#)/i;

  // Audio extensions
  const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma|aiff)(\?|$|#)/i;

  // Patterns to exclude
  const EXCLUDE = /\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|woff|ttf|eot)(\?|$|#)/i;

  function addMedia(url, type, source, mediaType = 'video') {
    if (!url) return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    if (EXCLUDE.test(url)) return;

    try {
      const parsed = new URL(url, window.location.href);
      const fullUrl = parsed.href;
      if (/\.(?:ts|m4s|m4f|cmfv|cmfa)$/i.test(parsed.pathname) ||
          /(?:^|[/_.-])(?:segment|seg|fragment|frag|chunk|part)[-_.]?\d+(?:[/_.-]|$)/i.test(parsed.pathname)) {
        return;
      }

      if (/\.m3u8(?:[?#]|$)/i.test(fullUrl)) type = 'HLS';
      if (/\.mpd(?:[?#]|$)/i.test(fullUrl)) type = 'DASH';

      // Check if it looks like a video
      if (VIDEO_EXTENSIONS.test(fullUrl) ||
          fullUrl.includes('videoplayback') ||
          fullUrl.includes('/video/') ||
          fullUrl.includes('streaming')) {
        if (!media.has(fullUrl)) {
          media.set(fullUrl, { url: fullUrl, type, source, mediaType: 'video' });
        }
      }

      // Check if it looks like audio
      if (AUDIO_EXTENSIONS.test(fullUrl) ||
          fullUrl.includes('audioplayback') ||
          fullUrl.includes('/audio/') ||
          fullUrl.includes('/podcast')) {
        if (!media.has(fullUrl)) {
          media.set(fullUrl, { url: fullUrl, type, source, mediaType: 'audio' });
        }
      }
    } catch (e) {}
  }

  function getAudioType(url) {
    if (/\.mp3/i.test(url)) return 'MP3';
    if (/\.m4a/i.test(url)) return 'M4A';
    if (/\.aac/i.test(url)) return 'AAC';
    if (/\.ogg/i.test(url) || /\.oga/i.test(url)) return 'OGG';
    if (/\.opus/i.test(url)) return 'OPUS';
    if (/\.wav/i.test(url)) return 'WAV';
    if (/\.flac/i.test(url)) return 'FLAC';
    if (/\.wma/i.test(url)) return 'WMA';
    if (/\.aiff/i.test(url)) return 'AIFF';
    return 'Audio';
  }

  // 1. Find <video> elements with src
  document.querySelectorAll('video').forEach(video => {
    const src = video.src || video.currentSrc;
    if (src && !src.startsWith('blob:')) {
      addMedia(src, 'video', 'video element', 'video');
    }
  });

  // 2. Find <source> elements inside <video>
  document.querySelectorAll('video source[src]').forEach(source => {
    addMedia(source.src, source.type || 'video', 'source element', 'video');
  });

  // 3. Find <audio> elements with src
  document.querySelectorAll('audio').forEach(audio => {
    const src = audio.src || audio.currentSrc;
    if (src && !src.startsWith('blob:')) {
      addMedia(src, getAudioType(src), 'audio element', 'audio');
    }
  });

  // 4. Find <source> elements inside <audio>
  document.querySelectorAll('audio source[src]').forEach(source => {
    const type = source.type ? source.type.replace('audio/', '').toUpperCase() : getAudioType(source.src);
    addMedia(source.src, type, 'source element', 'audio');
  });

  // 5. Check iframes (same origin only)
  document.querySelectorAll('iframe').forEach(iframe => {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (iframeDoc) {
        iframeDoc.querySelectorAll('video').forEach(video => {
          const src = video.src || video.currentSrc;
          if (src && !src.startsWith('blob:')) {
            addMedia(src, 'video', 'iframe', 'video');
          }
        });
        iframeDoc.querySelectorAll('audio').forEach(audio => {
          const src = audio.src || audio.currentSrc;
          if (src && !src.startsWith('blob:')) {
            addMedia(src, getAudioType(src), 'iframe', 'audio');
          }
        });
      }
    } catch (e) {}
  });

  // 6. Look for media URLs in inline scripts. Cap scanned text so a large
  // application bundle cannot freeze the popup.
  const MAX_INLINE_SCRIPT_CHARS = 2_000_000;
  const videoUrlPattern = /"(https?:\/\/[^"]+\.(mp4|webm|m3u8|mpd|m4v)[^"]*)"/gi;
  const audioUrlPattern = /"(https?:\/\/[^"]+\.(mp3|m4a|aac|ogg|opus|wav|flac)[^"]*)"/gi;
  let scannedChars = 0;

  for (const script of document.querySelectorAll('script:not([src])')) {
    if (scannedChars >= MAX_INLINE_SCRIPT_CHARS) break;
    const scriptContent = (script.textContent || '').slice(0, MAX_INLINE_SCRIPT_CHARS - scannedChars);
    scannedChars += scriptContent.length;

    videoUrlPattern.lastIndex = 0;
    let match;
    while ((match = videoUrlPattern.exec(scriptContent)) !== null) {
      const ext = match[2].toLowerCase();
      const type = ext === 'm3u8' ? 'HLS' : ext === 'mpd' ? 'DASH' : ext.toUpperCase();
      addMedia(match[1], type, 'script', 'video');
    }

    audioUrlPattern.lastIndex = 0;
    while ((match = audioUrlPattern.exec(scriptContent)) !== null) {
      addMedia(match[1], match[2].toUpperCase(), 'script', 'audio');
    }
  }

  // 7. Check data attributes for video
  document.querySelectorAll('[data-video-url], [data-video-src], [data-video], [data-stream-url], [data-hls], [data-dash]').forEach(el => {
    for (const [key, value] of Object.entries(el.dataset)) {
      if (value && (key.includes('video') || key.includes('stream') || key.includes('hls') || key.includes('dash'))) {
        addMedia(value, 'video', 'data attribute', 'video');
      }
    }
  });

  // 8. Check data attributes for audio
  document.querySelectorAll('[data-audio-url], [data-audio-src], [data-audio], [data-podcast], [data-mp3]').forEach(el => {
    for (const [key, value] of Object.entries(el.dataset)) {
      if (value && (key.includes('audio') || key.includes('podcast') || key.includes('mp3'))) {
        addMedia(value, getAudioType(value), 'data attribute', 'audio');
      }
    }
  });

  return Array.from(media.values());
}

// Combine and deduplicate videos from all sources
async function findAllVideos() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Get videos from both sources
  const [networkVideos, pageVideos] = await Promise.all([
    getNetworkVideos(tab.id),
    findPageVideos()
  ]);

  // Combine and deduplicate
  const allVideos = new Map();

  // Network videos are usually more reliable
  for (const video of networkVideos) {
    allVideos.set(video.url, video);
  }

  // Add page videos if not already present
  for (const video of pageVideos) {
    if (!allVideos.has(video.url)) {
      allVideos.set(video.url, video);
    }
  }

  return Array.from(allVideos.values());
}

// Format file size
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Fetch HLS duration and quality info by checking the manifest
async function getHLSDuration(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLS_INFO_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: 'include',
      signal: controller.signal
    });
    if (!response.ok) return null;
    const text = await response.text();

    // Parse m3u8 for duration info
    const extinfMatches = text.matchAll(/#EXTINF:([\d.]+)/g);
    let totalDuration = 0;
    let segmentCount = 0;

    for (const match of extinfMatches) {
      totalDuration += parseFloat(match[1]);
      segmentCount++;
    }

    // Try to get bandwidth from EXT-X-STREAM-INF if present
    let bandwidth = null;
    const bandwidthMatch = text.match(/BANDWIDTH=(\d+)/);
    if (bandwidthMatch) {
      bandwidth = parseInt(bandwidthMatch[1]);
    }

    // Try to extract resolution from URL or manifest
    let resolution = null;
    const resFromUrl = url.match(/\/(\d{3,4})\//);
    if (resFromUrl) {
      resolution = resFromUrl[1] + 'p';
    }
    const resFromManifest = text.match(/RESOLUTION=(\d+x\d+)/);
    if (resFromManifest) {
      resolution = resFromManifest[1];
    }

    if (totalDuration > 0) {
      const estimatedBitrate = bandwidth || 2000000;
      const estimatedBytes = (totalDuration * estimatedBitrate) / 8;

      return {
        duration: totalDuration,
        segments: segmentCount,
        bandwidth: bandwidth,
        resolution: resolution,
        estimatedSize: estimatedBytes,
        isMediaPlaylist: true
      };
    }

    // If it's a master playlist, parse all variants
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variants = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const bw = lines[i].match(/BANDWIDTH=(\d+)/);
          const res = lines[i].match(/RESOLUTION=(\d+x\d+)/);
          if (bw) {
            variants.push({
              bandwidth: parseInt(bw[1]),
              resolution: res ? res[1] : null
            });
          }
        }
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const best = variants[0] || {};
      return {
        bandwidth: best.bandwidth,
        resolution: best.resolution,
        isPlaylist: true,
        variants: variants.map(v => {
          const h = v.resolution ? v.resolution.split('x')[1] : null;
          const mbps = (v.bandwidth / 1000000).toFixed(1);
          return h ? `${h}p (${mbps} Mbps)` : `${mbps} Mbps`;
        })
      };
    }

    // Try resolution from URL even without other info
    if (resolution) {
      return { resolution };
    }

    return null;
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Error fetching HLS info:', e);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  } else if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

// Display videos and audio in popup
async function displayVideos(videos) {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('videoList');

  // Filter out tiny segments (likely HLS/DASH segments we don't want individually)
  const filteredMedia = videos.filter(v => {
    // Keep if no size info, or if larger than 500KB, or if it's a manifest
    if (!v.contentLength) return true;
    if (v.contentLength > 500000) return true;
    if (v.type === 'HLS' || v.type === 'DASH') return true;
    // Keep all audio files (they can be small)
    if (v.mediaType === 'audio') return true;
    return false;
  });

  // Count videos and audio separately
  const videoCount = filteredMedia.filter(m => m.mediaType !== 'audio').length;
  const audioCount = filteredMedia.filter(m => m.mediaType === 'audio').length;

  if (filteredMedia.length === 0) {
    statusEl.className = 'status none';
    statusEl.textContent = 'No media found. Try playing the video/audio first, then click Rescan.';
    listEl.innerHTML = '';
    return;
  }

  statusEl.className = 'status found';

  // Build status message
  let statusParts = [];
  if (videoCount > 0) statusParts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
  if (audioCount > 0) statusParts.push(`${audioCount} audio${audioCount > 1 ? ' files' : ''}`);
  statusEl.textContent = `Found ${statusParts.join(' and ')} - fetching info...`;

  // Fetch duration info for HLS and m3u8 videos
  let hlsProbeCount = 0;
  const mediaWithInfo = await mapWithConcurrency(filteredMedia, HLS_INFO_CONCURRENCY, async (media) => {
    if (media.type === 'HLS' || media.url.includes('.m3u8')) {
      if (hlsProbeCount++ >= MAX_HLS_INFO_PROBES) return media;
      const info = await getHLSDuration(media.url);
      if (info) media.type = 'HLS'; // Correct the type
      return { ...media, hlsInfo: info };
    }
    return media;
  });

  // Sort: master playlists first, then by duration (longest first), then by resolution
  mediaWithInfo.sort((a, b) => {
    // Master playlists (best option) first
    if (a.hlsInfo?.isPlaylist && !b.hlsInfo?.isPlaylist) return -1;
    if (!a.hlsInfo?.isPlaylist && b.hlsInfo?.isPlaylist) return 1;
    // Then media playlists with duration
    if (a.hlsInfo?.duration && !b.hlsInfo?.duration) return -1;
    if (!a.hlsInfo?.duration && b.hlsInfo?.duration) return 1;
    // Then by bandwidth (higher = better quality)
    const aBw = a.hlsInfo?.bandwidth || 0;
    const bBw = b.hlsInfo?.bandwidth || 0;
    return bBw - aBw;
  });

  statusEl.textContent = `Found ${statusParts.join(' and ')}!`;

  listEl.innerHTML = mediaWithInfo.map((media, index) => {
    let sizeStr = media.contentLength ? formatSize(media.contentLength) : '';
    const isAudio = media.mediaType === 'audio';

    // Build info badges for HLS
    let hlsInfoStr = '';
    let labelStr = '';
    if (media.hlsInfo) {
      // Resolution badge
      if (media.hlsInfo.resolution) {
        const h = media.hlsInfo.resolution.includes('x')
          ? media.hlsInfo.resolution.split('x')[1] + 'p'
          : media.hlsInfo.resolution;
        hlsInfoStr += `<span class="video-quality">${h}</span>`;
      }

      if (media.hlsInfo.isPlaylist) {
        labelStr = 'Master Playlist';
        if (media.hlsInfo.variants && media.hlsInfo.variants.length > 0) {
          hlsInfoStr += `<span class="video-segments">${media.hlsInfo.variants.join(', ')}</span>`;
        }
      } else if (media.hlsInfo.isMediaPlaylist) {
        labelStr = 'Direct Stream';
      }

      if (media.hlsInfo.duration) {
        hlsInfoStr += `<span class="video-duration">${formatDuration(media.hlsInfo.duration)}</span>`;
        if (media.hlsInfo.estimatedSize) {
          sizeStr = `~${formatSize(media.hlsInfo.estimatedSize)}`;
        }
      } else if (media.hlsInfo.bandwidth && !media.hlsInfo.resolution) {
        const mbps = (media.hlsInfo.bandwidth / 1000000).toFixed(1);
        hlsInfoStr += `<span class="video-quality">${mbps} Mbps</span>`;
      }
    }

    // Different styling for audio vs video type badge
    const typeClass = isAudio ? 'audio-type' : 'video-type';
    const isRecommended = index === 0 && media.hlsInfo;

    return `
    <div class="video-item ${isAudio ? 'audio-item' : ''} ${isRecommended ? 'recommended' : ''}">
      ${isRecommended ? '<div class="recommend-badge">RECOMMENDED</div>' : ''}
      ${labelStr ? `<div class="stream-label">${labelStr}</div>` : ''}
      <div class="video-url" title="${escapeHtml(media.url)}">${escapeHtml(truncateUrl(media.url))}</div>
      <div class="video-info">
        <span class="${typeClass}">${escapeHtml(media.type)}</span>
        ${hlsInfoStr}
        ${sizeStr ? `<span class="video-est-size">${sizeStr}</span>` : ''}
      </div>
      <button class="download-btn" data-index="${index}">
        Download${isRecommended ? ' (Best)' : ''}
      </button>
    </div>
  `}).join('');

  // Store media for download handler
  window.currentVideos = mediaWithInfo;

  // Add click handlers
  listEl.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      downloadVideo(window.currentVideos[index], btn);
    });
  });
}

function truncateUrl(url) {
  if (url.length <= 60) return url;
  return url.substring(0, 30) + '...' + url.substring(url.length - 27);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function sendToDownloadServer(media) {
  const startup = await ensureServerRunning(false);
  if (!startup.success) {
    throw new Error(`Automatic server startup failed: ${startup.error}`);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin;

  try {
    const parsedTabUrl = new URL(tab.url);
    if (parsedTabUrl.protocol === 'http:' || parsedTabUrl.protocol === 'https:') {
      origin = parsedTabUrl.origin;
    }
  } catch (error) {}

  const cookies = await collectStreamCookies(media.url, tab.url);

  const response = await fetch(`${SERVER_BASE_URL}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: media.url,
      referer: tab.url,
      origin,
      userAgent: navigator.userAgent,
      cookies,
      requestHeaders: media.requestHeaders || null
    })
  });

  let result = {};
  try {
    result = await response.json();
  } catch (error) {}

  if (!response.ok) {
    throw new Error(result.error || `Download server returned ${response.status}`);
  }
  return result;
}

// Download HLS by sending the manifest to the local server.
async function downloadHLS(media, btn) {
  const statusEl = document.getElementById('status');

  try {
    statusEl.textContent = 'Sending to download server...';
    await sendToDownloadServer(media);

    statusEl.textContent = `Downloading via yt-dlp... Check server UI at ${SERVER_BASE_URL}`;
    if (btn) {
      btn.textContent = 'Downloading...';
      btn.style.background = '#22c55e';
    }

  } catch (e) {
    console.error('Streaming download error:', e);
    if (isServerAvailabilityError(e)) {
      showServerInstructions(media.url);
    } else {
      statusEl.textContent = `Error: ${e.message}`;
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }
}

// Download video or audio
async function downloadVideo(media, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting...';
  }

  const isAudio = media.mediaType === 'audio';
  const isHLS = media.type === 'HLS' || /\.m3u8(?:[?#]|$)/i.test(media.url);
  const isDASH = media.type === 'DASH' || /\.mpd(?:[?#]|$)/i.test(media.url);

  try {
    // Streaming manifests are downloaded by the local server.
    if (isHLS) {
      await downloadHLS(media, btn);
      return;
    }

    if (isDASH) {
      try {
        await sendToDownloadServer(media);
        if (btn) {
          btn.textContent = 'Downloading...';
          btn.style.background = '#22c55e';
        }
        showNotification('Download started! Check ~/Downloads');
        return;
      } catch (e) {
        if (isServerAvailabilityError(e)) {
          showServerInstructions(media.url);
        } else {
          showNotification(`Download failed: ${e.message}`);
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Download';
        }
        return;
      }
    }

    // For direct video/audio files, use browser download
    const filename = getFilename(media.url, media.type, isAudio);

    chrome.downloads.download({
      url: media.url,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Download';
        }
      } else {
        if (btn) {
          btn.textContent = 'Started!';
          btn.style.background = '#22c55e';
        }
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Download';
    }
  }
}

function showNotification(message) {
  const statusEl = document.getElementById('status');
  statusEl.className = 'status found';
  statusEl.textContent = message;
}

function showServerInstructions(url) {
  // Copy URL to clipboard
  navigator.clipboard.writeText(url);

  const listEl = document.getElementById('videoList');
  listEl.innerHTML = `
    <div class="server-instructions">
      <p><strong>Automatic server startup is unavailable.</strong></p>
      <p>Double-click this file once, then reload the extension:</p>
      <code>Install Native Host.command</code>
      <p style="margin-top: 12px; color: #888;">${escapeHtml(window.serverStartupError || 'The native host is not installed.')}</p>
      <p style="margin-top: 8px; color: #4ade80;">URL copied to clipboard as backup.</p>
    </div>
  `;
}

function getFilename(url, type, isAudio = false) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const segments = pathname.split('/').filter(Boolean);
    let filename = segments[segments.length - 1] || (isAudio ? 'audio' : 'video');

    // Remove query params from filename
    filename = filename.split('?')[0];

    // Add extension if missing
    const videoExts = /\.(mp4|webm|m4v|mov|mkv|avi|flv)$/i;
    const audioExts = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma|aiff)$/i;

    if (isAudio) {
      if (!audioExts.test(filename)) {
        // Map type to extension
        const extMap = {
          'MP3': '.mp3',
          'M4A': '.m4a',
          'AAC': '.aac',
          'OGG': '.ogg',
          'OPUS': '.opus',
          'WAV': '.wav',
          'FLAC': '.flac',
          'WMA': '.wma',
          'AIFF': '.aiff',
          'WebM Audio': '.webm'
        };
        filename += extMap[type] || '.mp3';
      }
    } else {
      if (!videoExts.test(filename)) {
        const ext = type === 'WebM' ? '.webm' : '.mp4';
        filename += ext;
      }
    }

    // Sanitize filename
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    return filename;
  } catch (e) {
    return isAudio ? 'audio.mp3' : 'video.mp4';
  }
}

// Initialize
async function init() {
  const statusEl = document.getElementById('status');
  statusEl.className = 'status scanning';
  statusEl.textContent = 'Starting server and scanning for videos...';

  const [, videos] = await Promise.all([
    ensureServerRunning(true),
    findAllVideos()
  ]);
  displayVideos(videos);
}

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', init);

// Clear button - clear detected videos and rescan
document.getElementById('clearBtn')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: 'clearVideos', tabId: tab.id });
  init();
});

// Start scanning
init();
