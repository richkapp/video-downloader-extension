#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const PORT = 9876;
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');

// Active segment download sessions
const sessions = new Map();

const server = http.createServer((req, res) => {
  // CORS headers for extension
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // --- Start a segment download session ---
  if (req.method === 'POST' && req.url === '/start-download') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { totalSegments } = JSON.parse(body);
        const sessionId = Date.now().toString();
        const outputFile = path.join(DOWNLOAD_DIR, `video_${sessionId}.ts`);
        const writeStream = fs.createWriteStream(outputFile);
        sessions.set(sessionId, { writeStream, outputFile, received: 0, totalSegments });
        console.log(`\n📥 Started HLS download → ${outputFile}`);
        console.log(`   Total segments: ${totalSegments}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId, outputFile }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Receive a segment ---
  if (req.method === 'POST' && req.url.startsWith('/segment/')) {
    const sessionId = req.url.split('/')[2];
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end('Session not found');
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      session.writeStream.write(data);
      session.received++;
      const pct = Math.round((session.received / session.totalSegments) * 100);
      process.stdout.write(`\r   Progress: ${session.received}/${session.totalSegments} segments (${pct}%)`);
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

  // --- Finish a download session ---
  if (req.method === 'POST' && req.url.startsWith('/finish/')) {
    const sessionId = req.url.split('/')[2];
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end('Session not found');
      return;
    }

    session.writeStream.end(() => {
      const tsFile = session.outputFile;
      const mp4File = tsFile.replace(/\.ts$/, '.mp4');
      console.log(`\n   Remuxing to MP4...`);

      const ffmpeg = spawn('ffmpeg', [
        '-i', tsFile,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        '-y',
        mp4File
      ]);

      ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg output

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          fs.unlink(tsFile, () => {});
          console.log(`✅ Download complete: ${mp4File}`);
        } else {
          console.log(`⚠️  Remux failed, raw file at: ${tsFile}`);
        }
      });
    });

    sessions.delete(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // --- Legacy: direct yt-dlp download for non-HLS ---
  if (req.method === 'POST' && req.url === '/download') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { url, filename, referer } = JSON.parse(body);

        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No URL provided' }));
          return;
        }

        console.log(`\n📥 Downloading: ${url.substring(0, 80)}...`);

        const outputTemplate = filename
          ? path.join(DOWNLOAD_DIR, filename)
          : path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s');

        const args = [
          '-o', outputTemplate,
          '--no-playlist',
          '--newline',
        ];

        if (referer) {
          args.push('--add-header', `Referer:${referer}`);
        }

        args.push(url);

        const child = spawn('yt-dlp', args);

        child.stdout.on('data', (data) => process.stdout.write(data.toString()));
        child.stderr.on('data', (data) => process.stderr.write(data.toString()));

        child.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Download complete!');
          } else {
            console.log(`❌ Download failed with code ${code}`);
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Download started', downloadDir: DOWNLOAD_DIR }));

      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running', downloadDir: DOWNLOAD_DIR }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
╔════════════════════════════════════════════╗
║     Video Download Server Running          ║
╠════════════════════════════════════════════╣
║  Port: ${PORT}                              ║
║  Downloads go to: ~/Downloads              ║
║                                            ║
║  Keep this terminal open while             ║
║  using the extension.                      ║
║                                            ║
║  Press Ctrl+C to stop.                     ║
╚════════════════════════════════════════════╝
`);
});
