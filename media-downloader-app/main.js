const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

// Get the server script path
function getServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'download-server-v2.js');
  }
  return path.join(__dirname, '..', 'download-server-v2.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Create a simple tray icon (16x16 for macOS menu bar)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADSSURBVDiNpdMxTsNAEAXQ94MdRUqJBHXKVNwgNVdIRQEH4Agp0uQUHIEb0FBQUCBRIIqU2RQL2Nmy2BXTZ2bm/5ndWUXEVMR2RDTWn2gJb8v4rp4cDLSGlyLu8TqM77COI6zFQ3Sxn8QHuMEWPvGEHVzgOCJmEbHwL+AU11jFM27xgHecoMJRRMzzF3CBL3z/9mAfm1jGPh5xh48khm0c4wDreMLSX/Ed3OAbC5Hi4p8LdvGOJZRYR5Uy/3tBiaOIaIaJpXSQo5oS10O8YDVNbCeSuP8DAU0vYvjvPOcAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => mainWindow.show()
    },
    { type: 'separator' },
    {
      label: 'Start Server',
      click: () => startServer(),
      id: 'start'
    },
    {
      label: 'Stop Server',
      click: () => stopServer(),
      id: 'stop'
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Media Downloader');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow.show();
  });
}

function startServer() {
  if (serverProcess) {
    console.log('Server already running');
    notifyRenderer('server-status', { running: true });
    return;
  }

  const serverPath = getServerPath();
  console.log('Starting server:', serverPath);

  // Check if file exists
  const fs = require('fs');
  if (!fs.existsSync(serverPath)) {
    console.error('Server file not found:', serverPath);
    notifyRenderer('server-status', { running: false, error: 'Server file not found: ' + serverPath });
    return;
  }

  // Find node executable
  const nodePath = process.execPath.includes('Electron')
    ? '/usr/local/bin/node'
    : process.execPath;

  // Try common node locations
  const nodePaths = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  let nodeExec = 'node';
  for (const np of nodePaths) {
    if (fs.existsSync(np)) {
      nodeExec = np;
      break;
    }
  }

  console.log('Using node:', nodeExec);

  serverProcess = spawn(nodeExec, [serverPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server error: ${data}`);
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
    serverProcess = null;
    notifyRenderer('server-status', { running: false, error: err.message });
  });

  serverProcess.on('close', (code) => {
    console.log(`Server exited with code ${code}`);
    serverProcess = null;
    notifyRenderer('server-status', { running: false });
  });

  // Give the server time to start, then check status
  setTimeout(() => checkServerStatus(), 1500);
}

function stopServer() {
  if (serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    notifyRenderer('server-status', { running: false });
  }
}

function checkServerStatus() {
  const req = http.get('http://127.0.0.1:9876/status', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const status = JSON.parse(data);
        notifyRenderer('server-status', { running: true, ...status });
      } catch (e) {
        notifyRenderer('server-status', { running: true });
      }
    });
  });

  req.on('error', () => {
    notifyRenderer('server-status', { running: false });
  });

  req.setTimeout(2000, () => {
    req.destroy();
    notifyRenderer('server-status', { running: false });
  });
}

function notifyRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// IPC Handlers
ipcMain.handle('start-server', async () => {
  startServer();
  return { success: true };
});

ipcMain.handle('stop-server', async () => {
  stopServer();
  return { success: true };
});

ipcMain.handle('get-server-status', async () => {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9876/status', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const status = JSON.parse(data);
          resolve({ running: true, ...status });
        } catch (e) {
          resolve({ running: true });
        }
      });
    });

    req.on('error', () => {
      resolve({ running: false });
    });

    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ running: false });
    });
  });
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();

  // Auto-start server on launch
  startServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, don't quit when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

app.on('will-quit', () => {
  stopServer();
});
