const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const TEST_DIR = __dirname;
const mime = { '.js': 'application/javascript', '.html': 'text/html', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const filePath = path.join(TEST_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGEERROR', err.message));
  await page.setViewport({ width: 1366, height: 820 });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.addScriptTag({ url: './build/vizceral-current.js' });
  await page.waitForFunction('window.Vizceral !== undefined');
  const info = await page.evaluate(async () => {
    const out = {};
    out.hasVizceral = typeof window.Vizceral === 'function' || typeof window.Vizceral.default === 'function';
    out.hasMediaRecorder = typeof window.MediaRecorder === 'function';
    out.mimeVP9 = window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9');
    out.mimeVP8 = window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp8');
    window.driver.installDeterministicRandom();
    const viz = window.driver.createLive(640, 360);
    window.driver.feed(viz, 0);
    window.driver.warmup(viz, 30);
    const px = window.driver.snapshotPixels(viz, 640, 360);
    out.pixelHash = window.driver.hashBytes(px);
    out.nonZeroPixels = px.some(v => v !== 0);
    out.gl = window.driver.glAccount;
    out.canvasCount = document.querySelectorAll('canvas').length;
    out.hasExportVideo = typeof viz.exportVideo === 'function';
    out.hasDispose = typeof viz.dispose === 'function';
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
  server.close();
})().catch((err) => { console.error(err); process.exit(1); });
