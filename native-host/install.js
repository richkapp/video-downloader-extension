#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST_NAME = 'com.videodownloader.bootstrap';
const EXTENSION_ID = 'pjegapeinfppenlhmokdigfjgcdpjidk';
const HOST_EXECUTABLE = path.resolve(__dirname, 'native-host');
const MANIFEST_FILENAME = `${HOST_NAME}.json`;

const browserLocations = [
  ['Google Chrome', path.join('Google', 'Chrome')],
  ['Google Chrome Beta', path.join('Google', 'Chrome Beta')],
  ['Google Chrome Canary', path.join('Google', 'Chrome Canary')],
  ['Brave', path.join('BraveSoftware', 'Brave-Browser')],
  ['Microsoft Edge', 'Microsoft Edge'],
  ['Chromium', 'Chromium'],
  ['Vivaldi', 'Vivaldi']
];

function hostManifest() {
  return {
    name: HOST_NAME,
    description: 'Starts the Video Downloader local server on demand',
    path: HOST_EXECUTABLE,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  };
}

function install() {
  fs.chmodSync(HOST_EXECUTABLE, 0o755);
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
  const installed = [];

  for (const [browserName, relativeBase] of browserLocations) {
    const browserBase = path.join(appSupport, relativeBase);
    if (!fs.existsSync(browserBase)) continue;

    const destinationDir = path.join(browserBase, 'NativeMessagingHosts');
    const destination = path.join(destinationDir, MANIFEST_FILENAME);
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(hostManifest(), null, 2) + '\n', { mode: 0o644 });
    installed.push({ browserName, destination });
  }

  if (installed.length === 0) {
    throw new Error('No supported Chromium browser profile was found');
  }

  console.log(`Native host installed for extension ${EXTENSION_ID}:`);
  for (const item of installed) console.log(`- ${item.browserName}: ${item.destination}`);
  console.log('\nReload the unpacked extension once. The server will then start automatically when its popup opens.');
}

function uninstall() {
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
  let removed = 0;
  for (const [, relativeBase] of browserLocations) {
    const destination = path.join(appSupport, relativeBase, 'NativeMessagingHosts', MANIFEST_FILENAME);
    if (fs.existsSync(destination)) {
      fs.rmSync(destination);
      removed++;
    }
  }
  console.log(`Removed ${removed} native host registration${removed === 1 ? '' : 's'}.`);
}

if (require.main === module) {
  if (process.platform !== 'darwin') {
    console.error('This installer currently supports macOS only.');
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

module.exports = { EXTENSION_ID, HOST_NAME, hostManifest, install, uninstall };
