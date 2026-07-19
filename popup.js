const HLS_INFO_TIMEOUT_MS = 5000;
const HLS_INFO_CONCURRENCY = 6;
const MAX_HLS_INFO_PROBES = 12;
const MAX_FORWARDED_COOKIES = 200;
const DOWNLOAD_POLL_INTERVAL_MS = 800;
const SERVER_BASE_URL = 'http://127.0.0.1:9876';
const NATIVE_HOST_NAME = 'com.videodownloader.bootstrap';
let serverStartPromise = null;
let downloadPollTimer = null;
let downloadHistoryLimit = 3;
let currentSettings = {
  downloadDirectory: '',
  videoOutput: 'compatible-mp4',
  concurrentFragments: 8,
  historyLimit: 3
};

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

function compactFolderPath(value) {
  return String(value || '')
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}

function renderSettingsForm(payload) {
  currentSettings = {
    ...payload.settings,
    videoOutput: payload.settings.videoOutput || payload.settings.youtubeFormat || 'compatible-mp4'
  };
  downloadHistoryLimit = payload.settings.historyLimit;
  document.getElementById('downloadDirectory').value = payload.settings.downloadDirectory;
  const directoryDisplay = document.getElementById('downloadDirectoryDisplay');
  directoryDisplay.textContent = compactFolderPath(payload.settings.downloadDirectory);
  directoryDisplay.title = payload.settings.downloadDirectory;
  document.getElementById('videoOutput').value = currentSettings.videoOutput;
  document.getElementById('concurrentFragments').value = String(payload.settings.concurrentFragments);
  document.getElementById('historyLimit').value = String(payload.settings.historyLimit);
}

async function loadSettings() {
  const response = await fetch(`${SERVER_BASE_URL}/settings`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Settings returned ${response.status}`);
  const payload = await response.json();
  renderSettingsForm(payload);
  return payload.settings;
}

function setSettingsFeedback(message, kind = '') {
  const feedback = document.getElementById('settingsFeedback');
  feedback.textContent = message;
  feedback.className = `settings-feedback${kind ? ` ${kind}` : ''}`;
}

async function chooseDownloadDirectory() {
  const button = document.getElementById('chooseDownloadDirectoryBtn');
  button.disabled = true;
  button.textContent = 'Opening chooser…';
  setSettingsFeedback('Choose a folder in the macOS window.');

  try {
    const response = await fetch(`${SERVER_BASE_URL}/settings/select-folder`, { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Folder chooser returned ${response.status}`);
    if (payload.cancelled) {
      setSettingsFeedback('Folder selection cancelled.');
      return;
    }
    renderSettingsForm(payload);
    setSettingsFeedback('Download folder changed.', 'success');
  } catch (error) {
    setSettingsFeedback(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Choose folder…';
  }
}

async function saveSettings({ reset = false } = {}) {
  const saveButton = document.getElementById('saveSettingsBtn');
  const resetButton = document.getElementById('resetSettingsBtn');
  saveButton.disabled = true;
  resetButton.disabled = true;
  setSettingsFeedback(reset ? 'Restoring defaults…' : 'Saving settings…');

  const body = reset ? { reset: true } : {
    downloadDirectory: document.getElementById('downloadDirectory').value,
    videoOutput: document.getElementById('videoOutput').value,
    concurrentFragments: Number(document.getElementById('concurrentFragments').value),
    historyLimit: Number(document.getElementById('historyLimit').value)
  };

  try {
    const response = await fetch(`${SERVER_BASE_URL}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Settings returned ${response.status}`);
    renderSettingsForm(payload);
    setSettingsFeedback(reset ? 'Defaults restored.' : 'Settings saved.', 'success');
    if (Array.isArray(window.lastDetectedVideos)) {
      await displayVideos(window.lastDetectedVideos);
    }
    await refreshDownloadProgress();
  } catch (error) {
    setSettingsFeedback(error.message, 'error');
  } finally {
    saveButton.disabled = false;
    resetButton.disabled = false;
  }
}

function selectPopupTab(tabId, focus = false) {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  for (const tab of tabs) {
    const selected = tab.id === tabId;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
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

function formatResolution(resolution) {
  if (!resolution) return '';
  const value = String(resolution);
  const dimensions = value.match(/^(\d+)x(\d+)$/);
  return dimensions ? `${dimensions[2]}p` : value;
}

function formatBitrate(bitrate) {
  if (!bitrate) return '';
  if (bitrate >= 1000000) return `${(bitrate / 1000000).toFixed(1)} Mbps`;
  return `${Math.round(bitrate / 1000)} kbps`;
}

function cleanPageTitle(title) {
  const cleaned = String(title || 'Current tab')
    .replace(/\s+-\s+YouTube\s*$/i, '')
    .trim();
  if (cleaned.length <= 58) return cleaned;
  return `${cleaned.slice(0, 55)}…`;
}

function mediaTitle(media, resolution, bitrate) {
  const type = media.type || (media.mediaType === 'audio' ? 'Audio' : 'Video');
  if (resolution) return `${resolution} ${type}`;
  if (media.mediaType === 'audio' && bitrate) return `${bitrate} ${type}`;
  if (media.hlsInfo?.isPlaylist) return `Adaptive ${type} stream`;
  return `${type} ${media.mediaType === 'audio' ? 'audio' : 'video'} file`;
}

function downloadButtonLabel(media, resolution) {
  const streamKind = media.urlInfo?.streamKind;
  if (streamKind === 'Video only') {
    return `Download ${resolution || ''} video only`.replace(/\s+/g, ' ').trim();
  }
  if (media.mediaType === 'audio') return `Download ${media.type || 'audio'}`;
  return `Download ${resolution || media.type || 'this file'}`;
}

function youtubeDownloadPresentation() {
  if (currentSettings.videoOutput === 'best-quality') {
    return {
      status: 'Primary YouTube video recognized — best available quality ready',
      quality: 'Best available',
      kind: 'source format',
      qualityChip: 'Best quality',
      formatChip: 'Format may vary',
      button: 'Download best-quality video',
      downloading: 'Downloading best quality…',
      explanation: 'yt-dlp selects the highest available video and audio quality. The final container and codecs may be MP4, WebM, or another source-compatible format.'
    };
  }
  return {
    status: 'Primary YouTube video recognized — compatible MP4 ready',
    quality: 'Compatible MP4',
    kind: 'H.264 + AAC',
    qualityChip: 'Best compatible quality',
    formatChip: 'MP4',
    button: 'Download MP4 video',
    downloading: 'Downloading compatible MP4…',
    explanation: 'yt-dlp prefers H.264 video and AAC audio, then merges them into a macOS-compatible MP4 file. The final size appears in download progress.'
  };
}

function displayPrimaryYouTubeVideo(tab, pageUrl, elements) {
  const { statusEl, listEl, listSummaryEl } = elements;
  const title = cleanPageTitle(tab?.title);
  const presentation = youtubeDownloadPresentation();
  const primaryMedia = {
    downloadMethod: 'server',
    mediaType: 'video',
    pageTitle: title,
    type: 'YouTube',
    url: pageUrl,
    urlInfo: {
      sourceLabel: 'YouTube',
      streamKind: 'Video + audio'
    }
  };

  statusEl.className = 'status found';
  statusEl.textContent = presentation.status;
  listSummaryEl.hidden = true;
  listEl.innerHTML = `
    <article class="video-item primary-content">
      <div class="media-card-top">
        <div class="media-rank primary-marker" aria-label="Primary content">★</div>
        <div>
          <h2 class="media-title">${escapeHtml(title)}</h2>
          <div class="media-subtitle">Primary video from this YouTube page</div>
          <span class="largest-badge">Recommended download</span>
        </div>
        <div class="size-block">
          <div class="file-size primary-quality">${escapeHtml(presentation.quality)}</div>
          <div class="size-kind">${escapeHtml(presentation.kind)}</div>
        </div>
      </div>

      <div class="media-metadata">
        <span class="meta-chip quality">${escapeHtml(presentation.qualityChip)}</span>
        <span class="meta-chip">${escapeHtml(presentation.formatChip)}</span>
        <span class="meta-chip">Video + audio</span>
        <span class="meta-chip">Auto-merged</span>
      </div>

      <button class="download-btn" data-index="0">${escapeHtml(presentation.button)}</button>

      <details class="technical-details">
        <summary>How this download works</summary>
        <div class="technical-copy">
          <div>${escapeHtml(presentation.explanation)}</div>
          <div class="video-url" title="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</div>
        </div>
      </details>
    </article>
  `;

  window.currentVideos = [primaryMedia];
  listEl.querySelector('.download-btn').addEventListener('click', event => {
    downloadVideo(primaryMedia, event.currentTarget);
  });
}

// Display videos and audio in popup
async function displayVideos(videos) {
  window.lastDetectedVideos = videos;
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('videoList');
  const listSummaryEl = document.getElementById('listSummary');
  const sizeCoverageEl = document.getElementById('sizeCoverage');
  const pageContextEl = document.getElementById('pageContext');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageContextEl.textContent = cleanPageTitle(tab?.title);

  const youtubePageUrl = MediaUtils.getYouTubeVideoPage(tab?.url);
  if (youtubePageUrl) {
    displayPrimaryYouTubeVideo(tab, youtubePageUrl, { statusEl, listEl, listSummaryEl });
    return;
  }

  // Group repeated requests first so URL metadata can distinguish complete
  // files from small range responses before tiny fragments are filtered out.
  const preparedMedia = MediaUtils.dedupeMedia(videos);
  const uniqueMedia = preparedMedia.filter(media => {
    if (media.type === 'HLS' || media.type === 'DASH') return true;
    if (media.mediaType === 'audio') return true;
    const size = media.totalBytes || media.contentLength;
    return !size || size > 500000;
  });

  if (uniqueMedia.length === 0) {
    statusEl.className = 'status none';
    statusEl.textContent = 'No media found. Play the media briefly, then rescan the page.';
    listSummaryEl.hidden = true;
    listEl.innerHTML = '';
    return;
  }

  const videoCount = uniqueMedia.filter(media => media.mediaType !== 'audio').length;
  const audioCount = uniqueMedia.filter(media => media.mediaType === 'audio').length;
  const countParts = [];
  if (videoCount) countParts.push(`${videoCount} video option${videoCount === 1 ? '' : 's'}`);
  if (audioCount) countParts.push(`${audioCount} audio option${audioCount === 1 ? '' : 's'}`);

  statusEl.className = 'status found';
  statusEl.textContent = `Found ${countParts.join(' and ')} — checking sizes…`;
  listSummaryEl.hidden = false;
  sizeCoverageEl.textContent = 'Checking file sizes…';

  let hlsProbeCount = 0;
  const mediaWithInfo = await mapWithConcurrency(uniqueMedia, HLS_INFO_CONCURRENCY, async media => {
    if (media.type === 'HLS' || media.url.includes('.m3u8')) {
      if (hlsProbeCount++ >= MAX_HLS_INFO_PROBES) return media;
      const info = await getHLSDuration(media.url);
      return { ...media, type: info ? 'HLS' : media.type, hlsInfo: info };
    }
    return media;
  });

  const sortedMedia = MediaUtils.sortMediaLargestFirst(mediaWithInfo);
  const knownSizeCount = sortedMedia.filter(media => MediaUtils.getMediaSize(media)).length;
  const groupedRequestCount = sortedMedia.reduce(
    (total, media) => total + Math.max(0, (media.duplicateCount || 1) - 1),
    0
  );

  statusEl.textContent = `${sortedMedia.length} unique option${sortedMedia.length === 1 ? '' : 's'} — largest to smallest`;
  sizeCoverageEl.textContent = knownSizeCount === sortedMedia.length
    ? 'All sizes available'
    : `${knownSizeCount}/${sortedMedia.length} sizes available`;

  listEl.innerHTML = sortedMedia.map((media, index) => {
    const sizeBytes = MediaUtils.getMediaSize(media);
    const isEstimatedSize = Boolean(media.hlsInfo?.estimatedSize) && !media.totalBytes;
    const resolution = formatResolution(media.hlsInfo?.resolution || media.quality || media.urlInfo?.quality);
    const duration = media.hlsInfo?.duration || media.duration || media.urlInfo?.duration;
    const bitrateValue = media.hlsInfo?.bandwidth || media.urlInfo?.bitrate;
    const bitrate = formatBitrate(bitrateValue);
    const streamKind = media.urlInfo?.streamKind || (media.mediaType === 'audio' ? 'Audio' : 'Video');
    const sourceLabel = media.urlInfo?.sourceLabel || 'Detected media';
    const isLargest = index === 0 && Boolean(sizeBytes);
    const details = [];

    if (media.urlInfo?.itag) details.push(`Format ID ${media.urlInfo.itag}`);
    if (media.urlInfo?.codec) details.push(`Codec ${media.urlInfo.codec}`);
    if (media.duplicateCount > 1) details.push(`${media.duplicateCount} repeated requests grouped`);
    if (media.hlsInfo?.isPlaylist) details.push('Adaptive master playlist');
    if (media.hlsInfo?.segments) details.push(`${media.hlsInfo.segments} stream segments`);

    const metadata = [
      resolution ? `<span class="meta-chip quality">${escapeHtml(resolution)}</span>` : '',
      `<span class="meta-chip">${escapeHtml(media.type)}</span>`,
      duration ? `<span class="meta-chip">${escapeHtml(formatDuration(duration))}</span>` : '',
      bitrate ? `<span class="meta-chip">${escapeHtml(bitrate)}</span>` : '',
      `<span class="meta-chip ${streamKind === 'Video only' ? 'warning' : ''}">${escapeHtml(streamKind)}</span>`
    ].filter(Boolean).join('');

    return `
      <article class="video-item ${isLargest ? 'largest-file' : ''}">
        <div class="media-card-top">
          <div class="media-rank" aria-label="Rank ${index + 1}">${index + 1}</div>
          <div>
            <h2 class="media-title">${escapeHtml(mediaTitle(media, resolution, bitrate))}</h2>
            <div class="media-subtitle">${escapeHtml(sourceLabel)}</div>
            ${isLargest ? '<span class="largest-badge">Largest detected file</span>' : ''}
          </div>
          <div class="size-block">
            <div class="file-size ${sizeBytes ? '' : 'unknown'}">${sizeBytes ? escapeHtml(formatSize(sizeBytes)) : 'Unknown'}</div>
            <div class="size-kind">${sizeBytes ? (isEstimatedSize ? 'Estimated size' : 'File size') : 'Size unavailable'}</div>
          </div>
        </div>

        <div class="media-metadata">${metadata}</div>

        <button class="download-btn" data-index="${index}">
          ${escapeHtml(downloadButtonLabel(media, resolution))}
        </button>

        <details class="technical-details">
          <summary>Technical details</summary>
          <div class="technical-copy">
            ${details.length ? `<div>${escapeHtml(details.join(' · '))}</div>` : ''}
            <div class="video-url" title="${escapeHtml(media.url)}">${escapeHtml(media.url)}</div>
          </div>
        </details>
      </article>
    `;
  }).join('');

  if (groupedRequestCount > 0) {
    statusEl.textContent += ` · ${groupedRequestCount} repeat${groupedRequestCount === 1 ? '' : 's'} grouped`;
  }

  window.currentVideos = sortedMedia;

  listEl.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      downloadVideo(window.currentVideos[index], btn);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isActiveDownloadStatus(status) {
  return MediaUtils.isActiveDownloadStatus(status);
}

function downloadStatusLabel(status) {
  const labels = {
    starting: 'Preparing',
    downloading: 'Downloading',
    merging: 'Merging',
    finalizing: 'Finalizing',
    complete: 'Complete',
    error: 'Failed',
    stopped: 'Stopped'
  };
  return labels[status] || 'Unknown';
}

function downloadStatusClass(status) {
  if (isActiveDownloadStatus(status)) return 'active';
  if (status === 'complete') return 'complete';
  if (status === 'error') return 'error';
  if (status === 'stopped') return 'stopped';
  return '';
}

function syncPrimaryDownloadButton(downloads) {
  const primaryVideo = window.currentVideos?.find(video => video.downloadMethod === 'server');
  const primaryButton = document.querySelector('.primary-content .download-btn');
  if (!primaryVideo || !primaryButton) return;

  const activeDownload = downloads.find(download => (
    isActiveDownloadStatus(download.status) && download.url === primaryVideo.url
  ));

  if (activeDownload) {
    const percent = MediaUtils.normalizedDownloadPercent(activeDownload);
    primaryButton.disabled = true;
    primaryButton.classList.add('is-downloading');
    primaryButton.textContent = `${downloadStatusLabel(activeDownload.status)}${percent > 0 ? ` ${percent.toFixed(1)}%` : '…'}`;
    return;
  }

  if (primaryButton.classList.contains('is-downloading')) {
    primaryButton.disabled = false;
    primaryButton.classList.remove('is-downloading');
    primaryButton.textContent = youtubeDownloadPresentation().button;
  }
}

function renderDownloadProgress(downloads) {
  const panelEl = document.getElementById('downloadPanel');
  const itemsEl = document.getElementById('downloadItems');
  const summaryEl = document.getElementById('downloadPanelSummary');
  const modeEl = document.getElementById('downloadPanelMode');
  const clearHistoryButton = document.getElementById('clearHistoryBtn');
  const visibleDownloads = MediaUtils.sortDownloadsForDisplay(downloads, downloadHistoryLimit);

  syncPrimaryDownloadButton(downloads);

  if (visibleDownloads.length === 0) {
    panelEl.hidden = true;
    panelEl.dataset.hasData = '';
    document.body.classList.remove('downloads-visible');
    clearHistoryButton.hidden = true;
    return;
  }

  const activeCount = downloads.filter(download => isActiveDownloadStatus(download.status)).length;
  const recentCount = Math.max(0, downloads.length - activeCount);
  panelEl.hidden = false;
  panelEl.dataset.hasData = 'true';
  document.body.classList.add('downloads-visible');
  summaryEl.textContent = activeCount
    ? `${activeCount} active${recentCount ? ` · ${recentCount} recent` : ''}`
    : `${recentCount} recent download${recentCount === 1 ? '' : 's'}`;
  modeEl.lastChild.textContent = activeCount ? 'Live' : 'Recent';
  clearHistoryButton.hidden = recentCount === 0;

  itemsEl.innerHTML = visibleDownloads.map(download => {
    const percent = MediaUtils.normalizedDownloadPercent(download);
    const status = download.status || 'unknown';
    const statusClass = downloadStatusClass(status);
    const active = isActiveDownloadStatus(status);
    const stats = [];

    if (download.size && download.size !== '-') stats.push(`Size ${download.size}`);
    if (download.speed && download.speed !== '-') stats.push(`Speed ${download.speed}`);
    if (download.eta && download.eta !== '-') stats.push(`ETA ${download.eta}`);
    if (download.fragments && download.fragments !== '-') stats.push(`Fragments ${download.fragments}`);
    if (status === 'complete') {
      stats.push(`Saved to ${compactFolderPath(download.downloadDir || currentSettings.downloadDirectory || 'configured folder')}`);
    }

    const errorMessage = status === 'error'
      ? download.error || 'The download failed before the final file could be created.'
      : status === 'stopped'
        ? 'Download stopped.'
        : '';

    return `
      <article class="download-progress-item">
        <div class="download-progress-header">
          <div class="download-filename" title="${escapeHtml(download.filename || 'Detecting filename…')}">
            ${escapeHtml(download.filename || 'Detecting filename…')}
          </div>
          <div class="download-item-actions">
            <span class="download-status ${statusClass}">${escapeHtml(downloadStatusLabel(status))}</span>
            ${active ? '' : `
              <button
                class="remove-download-btn"
                type="button"
                data-download-id="${download.id}"
                aria-label="Remove ${escapeHtml(download.filename || 'download')} from progress history"
                title="Remove from progress history; the downloaded file stays in Downloads"
              >Clear</button>
            `}
          </div>
        </div>
        <div class="progress-row">
          <div
            class="progress-track"
            role="progressbar"
            aria-label="${escapeHtml(download.filename || 'Download progress')}"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="${percent.toFixed(1)}"
          >
            <div class="progress-fill ${statusClass}" style="width: ${percent.toFixed(1)}%"></div>
          </div>
          <span class="progress-percent">${status === 'starting' && percent === 0 ? 'Starting' : `${percent.toFixed(1)}%`}</span>
        </div>
        ${stats.length ? `<div class="download-stats">${stats.map(stat => `<span>${escapeHtml(stat)}</span>`).join('')}</div>` : ''}
        ${errorMessage ? `<div class="download-error">${escapeHtml(errorMessage)}</div>` : ''}
        ${active ? `<button class="stop-download-btn" data-download-id="${download.id}">Stop download</button>` : ''}
      </article>
    `;
  }).join('');

  itemsEl.querySelectorAll('.stop-download-btn').forEach(button => {
    button.addEventListener('click', () => stopDownload(Number(button.dataset.downloadId), button));
  });
  itemsEl.querySelectorAll('.remove-download-btn').forEach(button => {
    button.addEventListener('click', () => clearDownloadHistory(Number(button.dataset.downloadId), button));
  });
}

async function refreshDownloadProgress() {
  const panelEl = document.getElementById('downloadPanel');
  try {
    const response = await fetch(`${SERVER_BASE_URL}/downloads`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Download status returned ${response.status}`);
    const downloads = await response.json();
    renderDownloadProgress(Array.isArray(downloads) ? downloads : []);
    return downloads;
  } catch (error) {
    if (!panelEl.dataset.hasData) {
      panelEl.hidden = true;
      document.body.classList.remove('downloads-visible');
    }
    return [];
  }
}

function startDownloadPolling() {
  if (downloadPollTimer) clearInterval(downloadPollTimer);
  downloadPollTimer = setInterval(() => {
    void refreshDownloadProgress();
  }, DOWNLOAD_POLL_INTERVAL_MS);
}

async function stopDownload(id, button) {
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    const response = await fetch(`${SERVER_BASE_URL}/stop/${id}`, { method: 'POST' });
    if (!response.ok) throw new Error(`Stop request returned ${response.status}`);
    await refreshDownloadProgress();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Retry stop';
  }
}

async function clearDownloadHistory(id = null, button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Clearing…';
  }
  try {
    const suffix = id === null ? '' : `/${id}`;
    const response = await fetch(`${SERVER_BASE_URL}/downloads/clear${suffix}`, { method: 'POST' });
    if (!response.ok) throw new Error(`Clear request returned ${response.status}`);
    await refreshDownloadProgress();
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = id === null ? 'Retry clear' : 'Retry';
    }
  }
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
      requestHeaders: media.requestHeaders || null,
      mediaType: media.mediaType || 'video'
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
    await refreshDownloadProgress();

    statusEl.textContent = 'Downloading via yt-dlp — follow progress below';
    if (btn) {
      btn.textContent = 'Downloading...';
      btn.classList.add('is-downloading');
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
    if (media.downloadMethod === 'server') {
      try {
        await sendToDownloadServer(media);
        await refreshDownloadProgress();
        if (btn) {
          btn.textContent = youtubeDownloadPresentation().downloading;
          btn.classList.add('is-downloading');
        }
        showNotification('Primary video download started — follow progress below');
        return;
      } catch (error) {
        if (isServerAvailabilityError(error)) {
          showServerInstructions(media.url);
        } else {
          showNotification(`Download failed: ${error.message}`);
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = youtubeDownloadPresentation().button;
        }
        return;
      }
    }

    // Streaming manifests are downloaded by the local server.
    if (isHLS) {
      await downloadHLS(media, btn);
      return;
    }

    if (isDASH) {
      try {
        await sendToDownloadServer(media);
        await refreshDownloadProgress();
        if (btn) {
          btn.textContent = 'Downloading...';
          btn.classList.add('is-downloading');
        }
        showNotification('Download started — follow progress below');
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
          btn.classList.add('is-downloading');
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
  if (downloadPollTimer) {
    clearInterval(downloadPollTimer);
    downloadPollTimer = null;
  }
  statusEl.className = 'status scanning';
  statusEl.textContent = 'Starting server and scanning for videos...';

  const [startup, videos] = await Promise.all([
    ensureServerRunning(true),
    findAllVideos()
  ]);

  if (startup.success) {
    try {
      await loadSettings();
    } catch (error) {
      setSettingsFeedback('Settings are temporarily unavailable.', 'error');
    }
  } else {
    setSettingsFeedback('Start the download server before changing settings.', 'error');
  }
  await displayVideos(videos);

  if (startup.success) {
    await refreshDownloadProgress();
    startDownloadPolling();
  }
}

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', init);

// Clear button - clear detected videos and rescan
document.getElementById('clearBtn')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: 'clearVideos', tabId: tab.id });
  init();
});

document.getElementById('clearHistoryBtn')?.addEventListener('click', event => {
  clearDownloadHistory(null, event.currentTarget);
});

document.getElementById('chooseDownloadDirectoryBtn')?.addEventListener('click', () => {
  void chooseDownloadDirectory();
});

document.getElementById('settingsForm')?.addEventListener('submit', event => {
  event.preventDefault();
  void saveSettings();
});

document.getElementById('resetSettingsBtn')?.addEventListener('click', () => {
  void saveSettings({ reset: true });
});

document.querySelectorAll('[role="tab"]').forEach(tab => {
  tab.addEventListener('click', () => selectPopupTab(tab.id));
  tab.addEventListener('keydown', event => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const currentIndex = tabs.indexOf(event.currentTarget);
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      selectPopupTab(tabs[nextIndex].id, true);
    }
  });
});

// Start scanning
init();
