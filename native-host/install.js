#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST_NAME = 'com.videodownloader.bootstrap';
const EXTENSION_ID = 'pjegapeinfppenlhmokdigfjgcdpjidk';
const HOST_EXECUTABLE = path.resolve(__dirname, 'native-host');
const MANIFEST_FILENAME = `${HOST_NAME}.json`;
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

// Browser profile roots that hold a NativeMessagingHosts directory. macOS roots
// sit under ~/Library/Application Support, Linux roots under $XDG_CONFIG_HOME.
const browserLocations = {
  darwin: [
    ['Google Chrome', path.join('Google', 'Chrome')],
    ['Google Chrome Beta', path.join('Google', 'Chrome Beta')],
    ['Google Chrome Canary', path.join('Google', 'Chrome Canary')],
    ['Brave', path.join('BraveSoftware', 'Brave-Browser')],
    ['Brave Beta', path.join('BraveSoftware', 'Brave-Browser-Beta')],
    ['Brave Nightly', path.join('BraveSoftware', 'Brave-Browser-Nightly')],
    ['Microsoft Edge', 'Microsoft Edge'],
    ['Chromium', 'Chromium'],
    ['Vivaldi', 'Vivaldi']
  ],
  linux: [
    ['Google Chrome', 'google-chrome'],
    ['Google Chrome Beta', 'google-chrome-beta'],
    ['Google Chrome Dev', 'google-chrome-unstable'],
    ['Brave', path.join('BraveSoftware', 'Brave-Browser')],
    ['Brave Beta', path.join('BraveSoftware', 'Brave-Browser-Beta')],
    ['Brave Nightly', path.join('BraveSoftware', 'Brave-Browser-Nightly')],
    ['Brave Origin', path.join('BraveSoftware', 'Brave-Origin')],
    ['Brave Origin Beta', path.join('BraveSoftware', 'Brave-Origin-Beta')],
    ['Brave Origin Nightly', path.join('BraveSoftware', 'Brave-Origin-Nightly')],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Microsoft Edge Dev', 'microsoft-edge-dev'],
    ['Chromium', 'chromium'],
    ['Vivaldi', 'vivaldi']
  ]
};

function configRoot(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'linux') return env.XDG_CONFIG_HOME || path.join(home, '.config');
  throw new Error(`Unsupported platform: ${platform}`);
}

function browserTargets(platform = process.platform, home = os.homedir(), env = process.env) {
  const root = configRoot(platform, home, env);
  return (browserLocations[platform] || []).map(([browserName, relativeBase]) => {
    const browserBase = path.join(root, relativeBase);
    return {
      browserName,
      browserBase,
      destination: path.join(browserBase, 'NativeMessagingHosts', MANIFEST_FILENAME)
    };
  });
}

function hostManifest() {
  return {
    name: HOST_NAME,
    description: 'Starts the Video Downloader local server on demand',
    path: HOST_EXECUTABLE,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  };
}

function install({ platform = process.platform, home = os.homedir(), env = process.env, quiet = false } = {}) {
  fs.chmodSync(HOST_EXECUTABLE, 0o755);
  const installed = [];

  for (const target of browserTargets(platform, home, env)) {
    if (!fs.existsSync(target.browserBase)) continue;
    fs.mkdirSync(path.dirname(target.destination), { recursive: true });
    fs.writeFileSync(target.destination, JSON.stringify(hostManifest(), null, 2) + '\n', { mode: 0o644 });
    installed.push(target);
  }

  if (installed.length === 0) {
    throw new Error('No supported Chromium browser profile was found. Open your browser once, then run the installer again');
  }

  if (!quiet) {
    console.log(`Native host installed for extension ${EXTENSION_ID}:`);
    for (const item of installed) console.log(`- ${item.browserName}: ${item.destination}`);
    console.log('\nReload the unpacked extension once. The server will then start automatically when its popup opens.');
  }
  return installed;
}

function uninstall({ platform = process.platform, home = os.homedir(), env = process.env, quiet = false } = {}) {
  let removed = 0;
  for (const { destination } of browserTargets(platform, home, env)) {
    if (fs.existsSync(destination)) {
      fs.rmSync(destination);
      removed++;
    }
  }
  if (!quiet) console.log(`Removed ${removed} native host registration${removed === 1 ? '' : 's'}.`);
  return removed;
}

if (require.main === module) {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    console.error('This installer supports macOS and Linux.');
    process.exit(1);
  }

  try {
    if (process.argv.includes('--uninstall')) uninstall();
    else install();
  } catch (error) {
    console.error(`Installation failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { EXTENSION_ID, HOST_NAME, browserTargets, configRoot, hostManifest, install, uninstall };
