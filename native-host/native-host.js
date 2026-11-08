#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EXPECTED_ORIGIN = 'chrome-extension://pjegapeinfppenlhmokdigfjgcdpjidk/';
const requestedPort = Number.parseInt(process.env.VIDEO_DOWNLOADER_PORT, 10);
const SERVER_PORT = Number.isFinite(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? requestedPort
  : 9876;
const SERVER_HOST = '127.0.0.1';
const SERVER_PATH = process.env.VIDEO_DOWNLOADER_SERVER_PATH
  ? path.resolve(process.env.VIDEO_DOWNLOADER_SERVER_PATH)
  : path.resolve(__dirname, '..', 'download-server-v2.js');
const PROJECT_DIR = path.dirname(SERVER_PATH);
const LOCK_DIR = path.join(os.tmpdir(), `video-downloader-server-start-${SERVER_PORT}.lock`);
const LOCK_STALE_MS = 15_000;
const START_TIMEOUT_MS = 8_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

function log(message) {
  process.stderr.write(`[video-downloader-host] ${message}\n`);
}

function sendNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return new Promise((resolve, reject) => {
    process.stdout.write(Buffer.concat([header, payload]), error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readNativeMessage() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    process.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;

      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        reject(new Error('Native message is too large'));
        return;
      }
      if (buffer.length < length + 4) return;

      try {
        resolve(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
      } catch (error) {
        reject(new Error(`Invalid native message: ${error.message}`));
      }
    });

    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      if (buffer.length < 4) reject(new Error('Native message ended unexpectedly'));
    });
  });
}

function checkServer(timeoutMs = 600) {
  return new Promise(resolve => {
    const request = http.get({
      host: SERVER_HOST,
      port: SERVER_PORT,
      path: '/status',
      timeout: timeoutMs
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        try {
          const status = JSON.parse(body);
          resolve(response.statusCode === 200 && status.status === 'running');
        } catch (error) {
          resolve(false);
        }
      });
    });

    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForServer(timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkServer()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function acquireStartLock() {
  try {
    fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  try {
    const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
    if (age > LOCK_STALE_MS) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
      return true;
    }
  } catch (error) {
    return false;
  }
  return false;
}

function releaseStartLock() {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    log(`Could not release startup lock: ${error.message}`);
  }
}

function serverLogDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Logs', 'VideoDownloader');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'video-downloader');
}

function startServerProcess() {
  if (!fs.existsSync(SERVER_PATH)) {
    throw new Error(`Download server not found at ${SERVER_PATH}`);
  }

  const logDir = serverLogDir();
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, 'server.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);
  const pathValue = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
  ].join(':');

  try {
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: PROJECT_DIR,
      detached: true,
      env: { ...process.env, PATH: pathValue },
      stdio: ['ignore', logFd, logFd]
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  return logPath;
}

async function ensureServer() {
  if (await checkServer()) {
    return { success: true, alreadyRunning: true, port: SERVER_PORT };
  }

  const ownsLock = acquireStartLock();
  if (!ownsLock) {
    const running = await waitForServer();
    return running
      ? { success: true, alreadyRunning: true, port: SERVER_PORT }
      : { success: false, error: 'Another startup attempt did not produce a healthy server' };
  }

  try {
    if (await checkServer()) {
      return { success: true, alreadyRunning: true, port: SERVER_PORT };
    }

    const logPath = startServerProcess();
    if (!await waitForServer()) {
      return { success: false, error: `Server did not become ready. Check ${logPath}` };
    }
    return { success: true, started: true, port: SERVER_PORT, logPath };
  } finally {
    releaseStartLock();
  }
}

async function main() {
  try {
    const callerOrigin = process.argv[2];
    if (callerOrigin && callerOrigin !== EXPECTED_ORIGIN) {
      throw new Error('Native host was called by an unexpected extension');
    }

    const message = await readNativeMessage();
    if (message?.command !== 'ensureServer') {
      throw new Error('Unsupported native host command');
    }
    await sendNativeMessage(await ensureServer());
    process.exit(0);
  } catch (error) {
    log(error.stack || error.message);
    await sendNativeMessage({ success: false, error: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  acquireStartLock,
  checkServer,
  ensureServer,
  readNativeMessage,
  releaseStartLock,
  sendNativeMessage,
  serverLogDir,
  waitForServer
};
