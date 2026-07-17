const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadsFrame = document.getElementById('downloadsFrame');
const offlineMessage = document.getElementById('offlineMessage');
const activeCount = document.getElementById('activeCount');

let isRunning = false;

function updateUI(status) {
  isRunning = status.running;

  if (isRunning) {
    statusDot.classList.add('running');
    statusText.textContent = 'Server running on port 9876';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    offlineMessage.classList.add('hidden');

    // Load the server UI if not already loaded
    if (downloadsFrame.src === 'about:blank' || !downloadsFrame.src.includes('127.0.0.1:9876')) {
      downloadsFrame.src = 'http://127.0.0.1:9876/';
    }

    // Show active downloads count
    if (status.activeDownloads !== undefined) {
      activeCount.textContent = status.activeDownloads > 0
        ? `(${status.activeDownloads} active)`
        : '';
    }
  } else {
    statusDot.classList.remove('running');
    statusText.textContent = 'Server stopped';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    offlineMessage.classList.remove('hidden');
    downloadsFrame.src = 'about:blank';
    activeCount.textContent = '';
  }
}

// Button handlers
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  statusText.textContent = 'Starting server...';
  await window.api.startServer();
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  statusText.textContent = 'Stopping server...';
  await window.api.stopServer();
});

// Listen for server status updates from main process
window.api.onServerStatus((status) => {
  updateUI(status);
});

// Check status on load
async function checkStatus() {
  const status = await window.api.getServerStatus();
  updateUI(status);
}

// Initial status check
checkStatus();

// Periodic status check (backup for any missed events)
setInterval(checkStatus, 5000);
