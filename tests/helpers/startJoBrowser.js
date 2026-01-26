const { spawn } = require('child_process');
const path = require('path');

let serverProcess = null;
let serverPort = null;

async function waitForServer(port, maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

async function startJoBrowser(port = 0) {
  // Use a random available port if not specified
  const usePort = port || Math.floor(3100 + Math.random() * 900);
  
  const serverPath = path.join(__dirname, '../../server-camoufox.js');
  
  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: usePort.toString(), DEBUG_RESPONSES: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  
  serverProcess.stdout.on('data', (data) => {
    if (process.env.DEBUG_SERVER) {
      console.log(`[server] ${data.toString().trim()}`);
    }
  });
  
  serverProcess.stderr.on('data', (data) => {
    if (process.env.DEBUG_SERVER) {
      console.error(`[server:err] ${data.toString().trim()}`);
    }
  });
  
  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });
  
  serverPort = usePort;
  
  // Wait for server to be ready
  await waitForServer(usePort);
  
  console.log(`jo-browser server started on port ${usePort}`);
  return usePort;
}

async function stopJoBrowser() {
  if (serverProcess) {
    return new Promise((resolve) => {
      serverProcess.on('close', () => {
        serverProcess = null;
        serverPort = null;
        resolve();
      });
      
      // Send SIGTERM for graceful shutdown
      serverProcess.kill('SIGTERM');
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (serverProcess) {
          serverProcess.kill('SIGKILL');
        }
      }, 5000);
    });
  }
}

function getServerUrl() {
  if (!serverPort) throw new Error('Server not started');
  return `http://localhost:${serverPort}`;
}

function getServerPort() {
  return serverPort;
}

module.exports = {
  startJoBrowser,
  stopJoBrowser,
  getServerUrl,
  getServerPort
};
