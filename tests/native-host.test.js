const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const manifest = require('../manifest.json');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { EXTENSION_ID, HOST_NAME, browserTargets, hostManifest, install, uninstall } = require('../native-host/install');
const { serverLogDir } = require('../native-host/native-host.js');

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'video-downloader-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

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

test('targets Linux browser profiles under XDG_CONFIG_HOME', () => {
  const targets = browserTargets('linux', '/home/example', { XDG_CONFIG_HOME: '/home/example/.cfg' });
  const brave = targets.find(target => target.browserName === 'Brave');
  assert.equal(brave.destination, `/home/example/.cfg/BraveSoftware/Brave-Browser/NativeMessagingHosts/${HOST_NAME}.json`);
  assert.equal(browserTargets('linux', '/home/example', {}).every(target => target.browserBase.startsWith('/home/example/.config/')), true);
  assert.equal(browserTargets('darwin', '/Users/example', {}).every(target => target.browserBase.startsWith('/Users/example/Library/Application Support/')), true);
});

test('installs and uninstalls the host only for browsers that exist', (t) => {
  const home = temporaryHome(t);
  fs.mkdirSync(path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'), { recursive: true });

  const installed = install({ platform: 'linux', home, env: {}, quiet: true });
  assert.deepEqual(installed.map(item => item.browserName), ['Brave']);
  assert.deepEqual(JSON.parse(fs.readFileSync(installed[0].destination, 'utf8')), hostManifest());
  assert.equal(fs.existsSync(path.join(home, '.config', 'chromium')), false);

  assert.equal(uninstall({ platform: 'linux', home, env: {}, quiet: true }), 1);
  assert.equal(fs.existsSync(installed[0].destination), false);
});

test('logs the server under the platform log location', () => {
  assert.equal(serverLogDir('darwin', '/Users/example', {}), '/Users/example/Library/Logs/VideoDownloader');
  assert.equal(serverLogDir('linux', '/home/example', {}), '/home/example/.local/state/video-downloader');
  assert.equal(serverLogDir('linux', '/home/example', { XDG_STATE_HOME: '/s' }), '/s/video-downloader');
});

test('install.sh adds the extension to browser flags without dropping others and removes it cleanly', { skip: process.platform !== 'linux' }, (t) => {
  const home = temporaryHome(t);
  const projectDir = path.resolve(__dirname, '..');
  const config = path.join(home, '.config');
  fs.mkdirSync(path.join(config, 'BraveSoftware', 'Brave-Browser'), { recursive: true });
  const braveFlags = path.join(config, 'brave-flags.conf');
  const chromiumFlags = path.join(config, 'chromium-flags.conf');
  fs.writeFileSync(braveFlags, '--ozone-platform=wayland\n--load-extension=/opt/other\n');
  fs.writeFileSync(chromiumFlags, '--ozone-platform=wayland\n');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config };
  const script = path.join(projectDir, 'install.sh');

  execFileSync(script, { env, stdio: 'pipe' });
  execFileSync(script, { env, stdio: 'pipe' });
  assert.match(fs.readFileSync(braveFlags, 'utf8'), new RegExp(`^--load-extension=/opt/other,${projectDir}$`, 'm'));
  assert.equal(fs.readFileSync(chromiumFlags, 'utf8'), `--ozone-platform=wayland\n--load-extension=${projectDir}\n`);
  assert.equal(fs.existsSync(path.join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', `${HOST_NAME}.json`)), true);

  execFileSync(script, ['--uninstall'], { env, stdio: 'pipe' });
  assert.equal(fs.readFileSync(braveFlags, 'utf8'), '--ozone-platform=wayland\n--load-extension=/opt/other\n');
  assert.equal(fs.readFileSync(chromiumFlags, 'utf8'), '--ozone-platform=wayland\n');
  assert.equal(fs.existsSync(path.join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', `${HOST_NAME}.json`)), false);
});
