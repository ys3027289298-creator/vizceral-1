/**
 * End-to-end verification for the Vizceral video-export feature, driven by
 * headless Chromium (puppeteer). Produces every required artifact under
 * ./artifacts and prints a summary.
 *
 * Scenarios:
 *   1. Bitwise/pixel consistency between the baseline and current build
 *      (identical fixture, seeded PRNG, fixed synthetic timestamps).
 *   2. A 10 s export: resolution/frame-count/file-size metrics and live-state invariance.
 *   3. Failure paths: unavailable encoder, unsupported MIME, bad options, no data,
 *      concurrent export, encoder crash.
 *   4. Mid-export cancellation: resource release + untouched live state.
 *   5. Resource/memory upper-bound sampling.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.resolve(__dirname);
const ARTIFACTS = path.resolve(ROOT, 'artifacts');
const BUILD_DIR = path.resolve(TEST_DIR, 'build');

// Vizceral's particle animation advances per render() call, not per wall-clock
// time (connectionView.update ignores its time argument). The meaningful
// deterministic "time axis" is therefore a frame count; timestamps below are
// only the values passed to render() and increase monotonically.
const PROBE_FRAME_OFFSETS = [240, 300, 420, 660, 838];
const SYNTHETIC_TIMESTAMPS_MS = PROBE_FRAME_OFFSETS.map(offset => offset * (1000 / 60));
const WARMUP_FRAMES = 120;
const PIXEL_TOLERANCE_PERCENT = 3;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function startStaticServer() {
  const mime = {
    '.js': 'application/javascript',
    '.html': 'text/html',
    '.png': 'image/png',
    '.json': 'application/json'
  };
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const filePath = path.normalize(path.join(TEST_DIR, urlPath === '/' ? 'index.html' : urlPath));
    if (!filePath.startsWith(TEST_DIR)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function newPage(browser, port, bundleFile) {
  const page = await browser.newPage();
  const consoleMessages = [];
  page.on('console', message => consoleMessages.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', error => consoleMessages.push(`[pageerror] ${error.message}`));
  await page.setViewport({ width: 1366, height: 820 });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: `./build/${bundleFile}` });
  await page.waitForFunction('window.Vizceral !== undefined && window.driver !== undefined');
  await page.evaluate(() => window.driver.ensureUnwrapped());
  page.__consoleMessages = consoleMessages;
  return page;
}

async function createLivePage(browser, port, bundleFile, width, height, tick = 0) {
  const page = await newPage(browser, port, bundleFile);
  const reference = await page.evaluate((w, h, t, warmup) => {
    const { driver } = window;
    driver.installDeterministicRandom();
    window.live = driver.createLive(w, h);
    driver.feed(window.live, t);
    driver.warmup(window.live, warmup);
    const livePixels = driver.snapshotPixels(window.live, w, h);
    return {
      pixels: driver.hashBytes(livePixels),
      state: driver.snapshotState(window.live),
      gl: Object.assign({}, driver.glAccount),
      domCanvasCount: driver.domCanvasCount()
    };
  }, width, height, tick, WARMUP_FRAMES);
  return { page: page, reference: reference };
}

async function renderProbeFrames(page, width, height) {
  return page.evaluate((frameOffsets, timestamps, w, h) => {
    const { driver } = window;
    const vizceral = window.live;
    // Render every frame up to each probe point so the per-frame particle
    // simulation advances identically in the baseline and current builds.
    const frames = frameOffsets.map((frameCount, index) => {
      const previousOffset = index === 0 ? 0 : frameOffsets[index - 1];
      for (let frame = previousOffset; frame < frameCount; frame += 1) {
        vizceral.render(frame * (1000 / 60));
      }
      const pixels = driver.snapshotPixels(vizceral, w, h);
      return {
        frame: frameCount,
        timestampMs: timestamps[index],
        hash: driver.hashBytes(pixels),
        pixels: Array.from(pixels),
        stateHash: driver.hashBytes(
          new TextEncoder().encode(driver.snapshotState(vizceral))
        )
      };
    });
    return frames;
  }, PROBE_FRAME_OFFSETS, SYNTHETIC_TIMESTAMPS_MS, width, height);
}

function diffPixelArrays(a, b) {
  let differing = 0;
  let maxDelta = 0;
  let deltaSum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = Math.abs(a[i] - b[i]);
    if (delta !== 0) { differing += 1; }
    if (delta > maxDelta) { maxDelta = delta; }
    deltaSum += delta;
  }
  return {
    differingChannels: differing,
    totalChannels: length,
    percentChannelsDifferent: (differing / length) * 100,
    maxChannelDelta: maxDelta,
    meanChannelDelta: deltaSum / length
  };
}

async function runConsistency(browser, port, width, height) {
  const baselinePage = await newPage(browser, port, 'vizceral-baseline.js');
  const currentPage = await newPage(browser, port, 'vizceral-current.js');

  await baselinePage.evaluate((w, h) => {
    const { driver } = window;
    driver.installDeterministicRandom();
    window.live = driver.createLive(w, h);
    driver.feed(window.live, 0);
    driver.warmup(window.live, 120);
  }, width, height);
  await currentPage.evaluate((w, h) => {
    const { driver } = window;
    driver.installDeterministicRandom();
    window.live = driver.createLive(w, h);
    driver.feed(window.live, 0);
    driver.warmup(window.live, 120);
  }, width, height);

  const baselineFrames = await renderProbeFrames(baselinePage, width, height);
  const currentFrames = await renderProbeFrames(currentPage, width, height);

  const frames = baselineFrames.map((frame, index) => {
    const other = currentFrames[index];
    const diff = diffPixelArrays(frame.pixels, other.pixels);
    return {
      frame: frame.frame,
      timestampMs: frame.timestampMs,
      baselineHash: frame.hash,
      currentHash: other.hash,
      bitwiseIdentical: frame.hash === other.hash,
      simulationStateBitwiseIdentical: frame.stateHash === other.stateHash,
      differingChannels: diff.differingChannels,
      totalChannels: diff.totalChannels,
      percentChannelsDifferent: diff.percentChannelsDifferent,
      maxChannelDelta: diff.maxChannelDelta,
      meanChannelDelta: diff.meanChannelDelta
    };
  });

  const result = {
    input: 'test/fixture-data.js (identical for both builds)',
    syntheticTimestampsMs: SYNTHETIC_TIMESTAMPS_MS,
    warmupFrames: WARMUP_FRAMES,
    deterministicPrng: true,
    baseline: {
      setup: {
        hasExportVideo: await baselinePage.evaluate('typeof window.Vizceral.prototype.exportVideo === "function"'),
        hasDispose: await baselinePage.evaluate('typeof window.Vizceral.prototype.dispose === "function"')
      }
    },
    current: {
      setup: {
        hasExportVideo: await currentPage.evaluate('typeof window.Vizceral.prototype.exportVideo === "function"'),
        hasDispose: await currentPage.evaluate('typeof window.Vizceral.prototype.dispose === "function"')
      }
    },
    frames: frames,
    allFramesBitwiseIdentical: frames.every(f => f.bitwiseIdentical),
    allSimulationStateBitwiseIdentical: frames.every(f => f.simulationStateBitwiseIdentical),
    maxPercentChannelsDifferent: Math.max.apply(null, frames.map(f => f.percentChannelsDifferent)),
    pixelTolerancePercent: PIXEL_TOLERANCE_PERCENT,
    withinRasterizerTolerance: frames.every(f => f.percentChannelsDifferent <= PIXEL_TOLERANCE_PERCENT)
  };

  await baselinePage.close();
  await currentPage.close();
  return result;
}

module.exports = {
  ARTIFACTS,
  BUILD_DIR,
  TEST_DIR,
  diffPixelArrays,
  ensureDir,
  newPage,
  runConsistency,
  createLivePage,
  sha256,
  startStaticServer,
  puppeteer
};
