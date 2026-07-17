const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const manifest = require('../manifest.json');
const { EXTENSION_ID, HOST_NAME, hostManifest } = require('../native-host/install');

function extensionIdFromKey(key) {
  const der = Buffer.from(key, 'base64');
  const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return Array.from(hash, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
}

test('manifest key and native host registration use the same stable extension ID', () => {
  assert.equal(extensionIdFromKey(manifest.key), EXTENSION_ID);
  assert.equal(EXTENSION_ID, 'pjegapeinfppenlhmokdigfjgcdpjidk');
  assert.equal(manifest.permissions.includes('nativeMessaging'), true);
});

test('native host manifest is restricted to this extension and executable', () => {
  const host = hostManifest();
  assert.equal(host.name, HOST_NAME);
  assert.deepEqual(host.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(path.isAbsolute(host.path), true);
  assert.equal(fs.existsSync(host.path), true);
  assert.notEqual(fs.statSync(host.path).mode & 0o111, 0);
});

test('native host speaks Chrome framing and recognizes a healthy server', async (t) => {
  const healthServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'running', service: 'video-downloader' }));
  });
  await new Promise((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => healthServer.close(resolve)));

  const port = healthServer.address().port;
  const child = spawn(process.execPath, [
    path.resolve(__dirname, '..', 'native-host', 'native-host.js'),
    `chrome-extension://${EXTENSION_ID}/`
  ], {
    env: { ...process.env, VIDEO_DOWNLOADER_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const message = Buffer.from(JSON.stringify({ command: 'ensureServer' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(message.length, 0);
  child.stdin.end(Buffer.concat([header, message]));

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', chunk => stdoutChunks.push(chunk));
  child.stderr.on('data', chunk => stderrChunks.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(exitCode, 0, Buffer.concat(stderrChunks).toString('utf8'));
  const output = Buffer.concat(stdoutChunks);
  const payloadLength = output.readUInt32LE(0);
  const response = JSON.parse(output.subarray(4, 4 + payloadLength).toString('utf8'));
  assert.equal(response.success, true);
  assert.equal(response.alreadyRunning, true);
  assert.equal(response.port, port);
});

test('native host starts the real server and its idle reaper stops it', async () => {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  const child = spawn(process.execPath, [
    path.resolve(__dirname, '..', 'native-host', 'native-host.js'),
    `chrome-extension://${EXTENSION_ID}/`
  ], {
    env: {
      ...process.env,
      VIDEO_DOWNLOADER_IDLE_TIMEOUT_MS: '1000',
      VIDEO_DOWNLOADER_PORT: String(port)
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const message = Buffer.from(JSON.stringify({ command: 'ensureServer' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(message.length, 0);
  child.stdin.end(Buffer.concat([header, message]));

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', chunk => stdoutChunks.push(chunk));
  child.stderr.on('data', chunk => stderrChunks.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, Buffer.concat(stderrChunks).toString('utf8'));

  const output = Buffer.concat(stdoutChunks);
  const payloadLength = output.readUInt32LE(0);
  const response = JSON.parse(output.subarray(4, 4 + payloadLength).toString('utf8'));
  assert.equal(response.success, true);
  assert.equal(response.started, true);
  assert.equal(response.port, port);

  const isHealthy = () => new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 200 }, result => {
      result.resume();
      resolve(result.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });

  assert.equal(await isHealthy(), true);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && await isHealthy()) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await isHealthy(), false, 'server should exit after the configured idle timeout');
});
