(function exposeMediaUtils(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.MediaUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMediaUtils() {
  const YOUTUBE_QUALITY_BY_ITAG = Object.freeze({
    5: '240p',
    6: '270p',
    17: '144p',
    18: '360p',
    22: '720p',
    34: '360p',
    35: '480p',
    36: '240p',
    37: '1080p',
    38: '3072p',
    43: '360p',
    44: '480p',
    45: '720p',
    46: '1080p',
    59: '480p',
    78: '480p',
    82: '360p',
    83: '480p',
    84: '720p',
    85: '1080p',
    91: '144p',
    92: '240p',
    93: '360p',
    94: '480p',
    95: '720p',
    96: '1080p',
    132: '240p',
    133: '240p',
    134: '360p',
    135: '480p',
    136: '720p',
    137: '1080p',
    138: '2160p',
    160: '144p',
    167: '360p',
    168: '480p',
    169: '720p',
    170: '1080p',
    212: '480p',
    218: '480p',
    219: '480p',
    242: '240p',
    243: '360p',
    244: '480p',
    245: '480p',
    246: '480p',
    247: '720p',
    248: '1080p',
    264: '1440p',
    266: '2160p',
    271: '1440p',
    272: '2160p',
    278: '144p',
    298: '720p60',
    299: '1080p60',
    302: '720p60',
    303: '1080p60',
    308: '1440p60',
    313: '2160p',
    315: '2160p60',
    330: '144p HDR',
    331: '240p HDR',
    332: '360p HDR',
    333: '480p HDR',
    334: '720p HDR',
    335: '1080p HDR',
    336: '1440p HDR',
    337: '2160p HDR'
  });

  const YOUTUBE_AUDIO_ONLY_ITAGS = new Set([
    139, 140, 141, 249, 250, 251, 256, 258, 325, 328
  ]);

  const YOUTUBE_COMBINED_ITAGS = new Set([
    5, 6, 17, 18, 22, 34, 35, 36, 37, 38, 43, 44, 45, 46, 59, 78,
    82, 83, 84, 85, 91, 92, 93, 94, 95, 96, 132, 151
  ]);
  const ACTIVE_DOWNLOAD_STATUSES = new Set(['starting', 'downloading', 'merging', 'finalizing']);

  function positiveNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function isActiveDownloadStatus(status) {
    return ACTIVE_DOWNLOAD_STATUSES.has(status);
  }

  function normalizedDownloadPercent(download) {
    const percent = Number(download?.percent);
    if (!Number.isFinite(percent)) return 0;
    return Math.max(0, Math.min(100, percent));
  }

  function sortDownloadsForDisplay(downloads, limit = 3) {
    return [...downloads]
      .sort((a, b) => {
        const activeDifference = Number(isActiveDownloadStatus(b.status)) -
          Number(isActiveDownloadStatus(a.status));
        return activeDifference || (b.id || 0) - (a.id || 0);
      })
      .slice(0, limit);
  }

  function isYouTubeHost(hostname) {
    return /(^|\.)(?:youtube\.com|googlevideo\.com|youtu\.be)$/i.test(hostname);
  }

  function getYouTubeVideoPage(url) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      let videoId = null;

      if (hostname === 'youtu.be') {
        videoId = parsed.pathname.split('/').filter(Boolean)[0] || null;
      } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
        if (parsed.pathname === '/watch') {
          videoId = parsed.searchParams.get('v');
        } else {
          const match = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
          videoId = match ? match[1] : null;
        }
      }

      if (!videoId || !/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) return null;
      return `https://www.youtube.com/watch?v=${videoId}`;
    } catch (error) {
      return null;
    }
  }

  function formatFromMime(mime, mediaType) {
    const normalized = (mime || '').toLowerCase();
    if (normalized.includes('mpegurl')) return 'HLS';
    if (normalized.includes('dash+xml')) return 'DASH';
    if (normalized === 'audio/mp4') return 'M4A';
    if (normalized === 'video/mp4') return 'MP4';
    if (normalized === 'audio/webm') return 'WebM Audio';
    if (normalized === 'video/webm') return 'WebM';
    if (normalized === 'audio/mpeg') return 'MP3';
    if (normalized === 'audio/aac') return 'AAC';
    if (normalized === 'audio/ogg') return 'OGG';

    const subtype = normalized.split('/')[1];
    if (!subtype) return null;
    if (mediaType === 'audio' && subtype === 'mp4') return 'M4A';
    return subtype.replace(/^x-/, '').toUpperCase();
  }

  function qualityFromParams(params, itag) {
    const explicit = params.get('quality_label') || params.get('qualityLabel');
    if (explicit) return explicit;

    const height = positiveNumber(params.get('height'));
    if (height) {
      const fps = positiveNumber(params.get('fps'));
      return `${Math.round(height)}p${fps && fps > 30 ? Math.round(fps) : ''}`;
    }

    const size = params.get('size');
    const sizeMatch = size && size.match(/^(\d+)x(\d+)$/);
    if (sizeMatch) return `${sizeMatch[2]}p`;

    return itag ? YOUTUBE_QUALITY_BY_ITAG[itag] || null : null;
  }

  function getUrlMetadata(url) {
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams;
      const hostname = parsed.hostname.toLowerCase();
      const isYouTube = isYouTubeHost(hostname);
      const itag = positiveNumber(params.get('itag'));
      const mimeValue = params.get('mime') || '';
      const mime = mimeValue.split(';')[0].trim().toLowerCase();
      const codecMatch = mimeValue.match(/codecs?=["']?([^"';]+)/i);
      const codec = codecMatch ? codecMatch[1].trim() : null;
      const inferredType = mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('video/')
          ? 'video'
          : null;
      const mediaType = itag && YOUTUBE_AUDIO_ONLY_ITAGS.has(itag)
        ? 'audio'
        : inferredType;
      const contentLength = positiveNumber(
        params.get('clen') || params.get('content_length') || params.get('contentLength')
      );
      const duration = positiveNumber(params.get('dur') || params.get('duration'));
      const bitrate = positiveNumber(params.get('bitrate') || params.get('br'));
      const quality = qualityFromParams(params, itag);
      const format = formatFromMime(mime, mediaType);

      let streamKind = mediaType === 'audio' ? 'Audio only' : mediaType === 'video' ? 'Video' : null;
      if (isYouTube && itag) {
        if (YOUTUBE_AUDIO_ONLY_ITAGS.has(itag)) streamKind = 'Audio only';
        else if (YOUTUBE_COMBINED_ITAGS.has(itag)) streamKind = 'Video + audio';
        else if (mediaType === 'video') streamKind = 'Video only';
      }

      return {
        bitrate,
        codec,
        contentLength,
        duration,
        format,
        hostname,
        isYouTube,
        itag,
        mediaType,
        mime,
        quality,
        sourceLabel: isYouTube ? 'YouTube' : hostname.replace(/^www\./, ''),
        streamKind
      };
    } catch (error) {
      return {
        bitrate: null,
        codec: null,
        contentLength: null,
        duration: null,
        format: null,
        hostname: '',
        isYouTube: false,
        itag: null,
        mediaType: null,
        mime: '',
        quality: null,
        sourceLabel: 'Unknown source',
        streamKind: null
      };
    }
  }

  function getResponseSizeInfo(headers, statusCode = 200) {
    const values = new Map();
    for (const header of headers || []) {
      if (!header?.name || header.value === undefined) continue;
      values.set(header.name.toLowerCase(), String(header.value));
    }

    const storedLength = positiveNumber(
      values.get('x-goog-stored-content-length') || values.get('x-file-size')
    );
    if (storedLength) return { bytes: storedLength, isTotal: true };

    const contentRange = values.get('content-range') || '';
    const rangeTotal = contentRange.match(/\/(\d+)\s*$/);
    if (rangeTotal) return { bytes: positiveNumber(rangeTotal[1]), isTotal: true };

    const contentLength = positiveNumber(values.get('content-length'));
    return {
      bytes: contentLength,
      isTotal: Boolean(contentLength) && statusCode !== 206
    };
  }

  function getResponseTotalBytes(headers, statusCode = 200) {
    return getResponseSizeInfo(headers, statusCode).bytes;
  }

  function normalizeMedia(media) {
    const urlInfo = getUrlMetadata(media.url);
    const mediaType = urlInfo.mediaType || media.mediaType || 'video';
    const type = urlInfo.format || media.type || (mediaType === 'audio' ? 'Audio' : 'Video');
    const isManifest = type === 'HLS' || type === 'DASH' || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(media.url);
    const totalBytes = isManifest
      ? urlInfo.contentLength
      : urlInfo.contentLength ||
        (urlInfo.isYouTube && !media.contentLengthIsTotal ? null : positiveNumber(media.contentLength));

    return {
      ...media,
      duplicateCount: media.duplicateCount || 1,
      duration: urlInfo.duration || positiveNumber(media.duration),
      mediaType,
      quality: urlInfo.quality || media.quality || null,
      totalBytes,
      type,
      urlInfo
    };
  }

  function mediaIdentity(media) {
    const normalized = media.urlInfo ? media : normalizeMedia(media);
    const info = normalized.urlInfo;

    if (info.isYouTube) {
      try {
        const parsed = new URL(normalized.url);
        const mediaId = parsed.searchParams.get('id') || parsed.searchParams.get('v') || 'current-video';
        const streamId = info.itag || `${info.mime || normalized.type}|${info.contentLength || ''}`;
        return `youtube|${mediaId}|${streamId}`;
      } catch (error) {}
    }

    return normalized.url;
  }

  function mediaSelectionScore(media) {
    let score = 0;
    try {
      const params = new URL(media.url).searchParams;
      if (!params.has('range') && !params.has('rn') && !params.has('rbuf')) score += 20;
      const range = params.get('range');
      if (range && /^0-/.test(range)) score += 4;
    } catch (error) {}
    if (media.urlInfo?.contentLength) score += 10;
    if (media.requestHeaders && Object.keys(media.requestHeaders).length > 0) score += 3;
    if ((media.source || '').includes('content-type')) score += 2;
    return score;
  }

  function mergeDuplicate(existing, candidate) {
    const preferred = mediaSelectionScore(candidate) > mediaSelectionScore(existing)
      ? candidate
      : existing;
    const other = preferred === existing ? candidate : existing;

    return {
      ...other,
      ...preferred,
      contentLength: Math.max(
        positiveNumber(existing.contentLength) || 0,
        positiveNumber(candidate.contentLength) || 0
      ) || null,
      duplicateCount: (existing.duplicateCount || 1) + (candidate.duplicateCount || 1),
      requestHeaders: preferred.requestHeaders || other.requestHeaders || null,
      timestamp: Math.max(existing.timestamp || 0, candidate.timestamp || 0),
      totalBytes: preferred.totalBytes || other.totalBytes || null
    };
  }

  function dedupeMedia(items) {
    const unique = new Map();

    for (const item of items) {
      const normalized = normalizeMedia(item);
      const identity = mediaIdentity(normalized);
      const existing = unique.get(identity);
      unique.set(identity, existing ? mergeDuplicate(existing, normalized) : normalized);
    }

    return Array.from(unique.values());
  }

  function getMediaSize(media) {
    const estimatedSize = positiveNumber(media.hlsInfo?.estimatedSize) ||
      positiveNumber(media.estimatedSize);
    if (estimatedSize) return estimatedSize;

    const isManifest = media.type === 'HLS' || media.type === 'DASH' ||
      /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(media.url || '');
    if (isManifest || media.urlInfo?.isYouTube) return positiveNumber(media.totalBytes);

    return positiveNumber(media.totalBytes) || positiveNumber(media.contentLength);
  }

  function qualityHeight(media) {
    const resolution = media.hlsInfo?.resolution || media.quality || media.urlInfo?.quality || '';
    const matches = String(resolution).match(/(?:x|^)(\d{3,4})p?/i);
    return matches ? Number(matches[1]) : 0;
  }

  function sortMediaLargestFirst(items) {
    return [...items].sort((a, b) => {
      const aSize = getMediaSize(a);
      const bSize = getMediaSize(b);

      if (aSize && bSize && aSize !== bSize) return bSize - aSize;
      if (aSize && !bSize) return -1;
      if (!aSize && bSize) return 1;

      const heightDifference = qualityHeight(b) - qualityHeight(a);
      if (heightDifference) return heightDifference;

      const durationDifference = (b.hlsInfo?.duration || b.duration || 0) -
        (a.hlsInfo?.duration || a.duration || 0);
      if (durationDifference) return durationDifference;

      return (b.timestamp || 0) - (a.timestamp || 0);
    });
  }

  return {
    dedupeMedia,
    getMediaSize,
    getResponseSizeInfo,
    getResponseTotalBytes,
    getYouTubeVideoPage,
    getUrlMetadata,
    isActiveDownloadStatus,
    mediaIdentity,
    normalizeMedia,
    normalizedDownloadPercent,
    sortDownloadsForDisplay,
    sortMediaLargestFirst
  };
});
