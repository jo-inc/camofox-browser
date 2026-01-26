const express = require('express');

let server = null;
let port = null;

function createTestApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  
  // Simple pages for navigation tests
  app.get('/pageA', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Page A</title></head>
      <body>
        <h1>Welcome to Page A</h1>
        <p>This is the first test page.</p>
        <a href="/pageB">Go to Page B</a>
      </body></html>
    `);
  });
  
  app.get('/pageB', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Page B</title></head>
      <body>
        <h1>Welcome to Page B</h1>
        <p>This is the second test page.</p>
        <a href="/pageA">Go to Page A</a>
      </body></html>
    `);
  });
  
  // Page with multiple links for links extraction test
  app.get('/links', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Links Page</title></head>
      <body>
        <h1>Links Collection</h1>
        <ul>
          <li><a href="https://example.com/link1">Example Link 1</a></li>
          <li><a href="https://example.com/link2">Example Link 2</a></li>
          <li><a href="https://example.com/link3">Example Link 3</a></li>
          <li><a href="https://example.com/link4">Example Link 4</a></li>
          <li><a href="https://example.com/link5">Example Link 5</a></li>
        </ul>
      </body></html>
    `);
  });
  
  // Page for typing tests with live preview
  app.get('/typing', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Typing Test</title></head>
      <body>
        <h1>Typing Test Page</h1>
        <input type="text" id="input" placeholder="Type here..." />
        <div id="preview"></div>
        <script>
          document.getElementById('input').addEventListener('input', (e) => {
            document.getElementById('preview').textContent = 'Preview: ' + e.target.value;
          });
        </script>
      </body></html>
    `);
  });
  
  // Page for Enter key test - redirects on Enter
  app.get('/enter', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Enter Test</title></head>
      <body>
        <h1>Press Enter Test</h1>
        <input type="text" id="searchInput" placeholder="Type and press Enter..." />
        <script>
          document.getElementById('searchInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              const value = e.target.value;
              window.location.href = '/entered?value=' + encodeURIComponent(value);
            }
          });
        </script>
      </body></html>
    `);
  });
  
  app.get('/entered', (req, res) => {
    const value = req.query.value || '';
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Entered</title></head>
      <body>
        <h1>Entry Received</h1>
        <p id="result">Entered: ${value}</p>
      </body></html>
    `);
  });
  
  // Form submission test
  app.get('/form', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Form Test</title></head>
      <body>
        <h1>Form Submission Test</h1>
        <form action="/submitted" method="POST">
          <label for="username">Username:</label>
          <input type="text" id="username" name="username" />
          <br/>
          <label for="email">Email:</label>
          <input type="email" id="email" name="email" />
          <br/>
          <button type="submit" id="submitBtn">Submit</button>
        </form>
      </body></html>
    `);
  });
  
  app.post('/submitted', (req, res) => {
    const { username, email } = req.body;
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Submitted</title></head>
      <body>
        <h1>Form Submitted Successfully</h1>
        <p id="username">Username: ${username || ''}</p>
        <p id="email">Email: ${email || ''}</p>
      </body></html>
    `);
  });
  
  // Page with refresh counter (to verify refresh actually works)
  let refreshCount = 0;
  app.get('/refresh-test', (req, res) => {
    refreshCount++;
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Refresh Test</title></head>
      <body>
        <h1>Refresh Counter</h1>
        <p id="count">Count: ${refreshCount}</p>
      </body></html>
    `);
  });
  
  // Reset refresh counter (for test isolation)
  app.post('/reset-refresh-count', (req, res) => {
    refreshCount = 0;
    res.json({ ok: true });
  });
  
  // Page with clickable button
  app.get('/click', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Click Test</title></head>
      <body>
        <h1>Click Test Page</h1>
        <button id="clickMe">Click Me</button>
        <div id="result"></div>
        <script>
          document.getElementById('clickMe').addEventListener('click', () => {
            document.getElementById('result').textContent = 'Button was clicked!';
          });
        </script>
      </body></html>
    `);
  });
  
  // Page with scrollable content
  app.get('/scroll', (req, res) => {
    const items = Array.from({ length: 100 }, (_, i) => `<p id="item${i}">Item ${i}</p>`).join('\n');
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Scroll Test</title></head>
      <body style="height: 5000px;">
        <h1>Scroll Test Page</h1>
        ${items}
        <div id="bottom">Bottom of page</div>
      </body></html>
    `);
  });
  
  return app;
}

async function startTestSite(preferredPort = 0) {
  const app = createTestApp();
  
  return new Promise((resolve, reject) => {
    server = app.listen(preferredPort, () => {
      port = server.address().port;
      console.log(`Test site running on port ${port}`);
      resolve(port);
    });
    server.on('error', reject);
  });
}

async function stopTestSite() {
  if (server) {
    return new Promise((resolve) => {
      server.close(() => {
        server = null;
        port = null;
        resolve();
      });
    });
  }
}

function getTestSiteUrl() {
  if (!port) throw new Error('Test site not started');
  return `http://localhost:${port}`;
}

module.exports = {
  startTestSite,
  stopTestSite,
  getTestSiteUrl
};
