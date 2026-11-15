/**
 * Repeatedly runs short exports in one browser session and reports the number
 * of frames actually muxed into each container, to validate that pacing never
 * drops a frame under scheduler contention.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
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

function countFrames(file) {
  return Number(execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file
  ], { encoding: 'utf8' }).trim());
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 820 });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.addScriptTag({ url: './build/vizceral-current.js' });
  await page.waitForFunction('window.driver');
  await page.evaluate(() => window.driver.ensureUnwrapped());
  await page.evaluate((w, h) => {
    const { driver } = window;
    driver.installDeterministicRandom();
    window.live = driver.createLive(w, h);
    driver.feed(window.live, 0);
    driver.warmup(window.live, 30);
  }, 640, 360);

  const runs = 4;
  const results = [];
  const clipSeconds = Number(process.env.CLIP_SECONDS || 2);
  for (let i = 0; i < runs; i += 1) {
    const out = await page.evaluate(async (seconds) => {
      const result = await window.live.exportVideo({
        fps: 30, duration: seconds, width: 640, height: 360
      }).promise;
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(result.blob);
      });
    }, clipSeconds);
    const file = path.join('/tmp', `stability-${i}.webm`);
    fs.writeFileSync(file, Buffer.from(out, 'base64'));
    results.push({ run: i, frames: countFrames(file), expected: 30 * clipSeconds });
  }
  console.log(JSON.stringify(results));
  const allComplete = results.every(r => r.frames === r.expected);
  console.log(allComplete ? `STABLE: every run muxed exactly ${results[0].expected} frames` : 'FRAME LOSS DETECTED');
  process.exitCode = allComplete ? 0 : 1;
  await browser.close();
  server.close();
})().catch((error) => { console.error(error); process.exit(1); });
