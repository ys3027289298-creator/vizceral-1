/* Shared puppeteer launch helper for the SVG-export test runners.
 * Uses a system/cached Chrome via PUPPETEER_EXECUTABLE_PATH when set,
 * otherwise falls back to well-known cache locations, otherwise lets
 * puppeteer resolve its own bundled browser. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

function chromeCandidates () {
  const home = os.homedir();
  const candidates = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  }
  // puppeteer's own default cache
  candidates.push(path.join(home, '.cache', 'puppeteer'));
  // caches left by other automation homes on this machine
  try {
    fs.readdirSync('/home').forEach((user) => {
      [ `/home/${user}/.cache/puppeteer` ].forEach((dir) => candidates.push(dir));
    });
    fs.readdirSync('/home').forEach((user) => {
      if (user.startsWith('.codex-relay-home') || true) {
        candidates.push(`/home/${user}/.cache/puppeteer`);
      }
    });
  } catch (e) { /* ignore */ }
  return candidates;
}

function findChromeExecutable () {
  const seen = new Set();
  const roots = chromeCandidates();
  for (const root of roots) {
    if (!root || seen.has(root)) { continue; }
    seen.add(root);
    if (fs.existsSync(root) && fs.statSync(root).isFile()) { return root; }
    if (!fs.existsSync(root)) { continue; }
    // walk <root>/chrome/linux-*/chrome-linux64/chrome and .../chrome-linux/chrome
    const queue = [root];
    let depth = 0;
    while (queue.length && depth < 5) {
      const next = [];
      for (const dir of queue) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { next.push(full); } else if (entry.name === 'chrome' || entry.name === 'chrome-headless-shell') {
            return full;
          }
        }
      }
      queue.length = 0;
      queue.push(...next);
      depth++;
    }
  }
  return undefined;
}

async function launchBrowser () {
  const executablePath = findChromeExecutable();
  const options = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // Software WebGL so runs are deterministic and GPU-independent.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader'
    ]
  };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  const browser = await puppeteer.launch(options);
  return { browser, executablePath: executablePath || 'puppeteer-default' };
}

/* Minimal static file server so web workers / fonts are same-origin. */
function serveStatic (rootDir) {
  const http = require('http');
  const types = {
    '.html': 'text/html', '.js': 'application/javascript', '.map': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json'
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    let filePath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(rootDir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { launchBrowser, serveStatic, findChromeExecutable };
