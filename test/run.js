/**
 * Builds bundles (if needed), launches headless Chromium, runs every scenario
 * and writes the four required deliverables into ./artifacts.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  ARTIFACTS,
  BUILD_DIR,
  TEST_DIR,
  ensureDir,
  createLivePage,
  runConsistency,
  sha256,
  startStaticServer,
  puppeteer
} = require('./run-verification');

const LIVE_WIDTH = 640;
const LIVE_HEIGHT = 360;

function writeJson(name, data) {
  fs.writeFileSync(path.join(ARTIFACTS, name), `${JSON.stringify(data, null, 2)}\n`);
}

function ffprobeMedia(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,nb_read_frames,r_frame_rate',
      '-show_packets',
      '-of', 'json',
      filePath
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const stream = parsed.streams && parsed.streams[0];
    const packets = parsed.packets || [];
    const lastPts = packets.length
      ? Number(packets[packets.length - 1].pts_time)
      : null;
    return {
      codec: stream ? stream.codec_name : null,
      width: stream ? stream.width : null,
      height: stream ? stream.height : null,
      containerFrames: stream ? Number(stream.nb_read_frames) : null,
      lastPacketPtsSeconds: lastPts,
      measuredDurationSeconds: lastPts !== null
        ? Math.round((lastPts + 1 / 30) * 1000) / 1000
        : null
    };
  } catch (error) {
    return { ffprobeError: error.message };
  }
}

function buildBundles() {
  execFileSync(process.execPath, [path.join(TEST_DIR, 'build-bundles.js')], {
    stdio: 'inherit',
    cwd: path.resolve(TEST_DIR, '..')
  });
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist'
    ]
  });
}

async function prepareLivePage(browser, port) {
  const { page } = await createLivePage(browser, port, 'vizceral-current.js', LIVE_WIDTH, LIVE_HEIGHT);
  await page.addScriptTag({ url: './run-scenarios.js' });
  await page.waitForFunction('window.scenarios !== undefined');
  return page;
}

async function main() {
  ensureDir(ARTIFACTS);
  if (!fs.existsSync(path.join(BUILD_DIR, 'vizceral-current.js'))
      || process.env.REBUILD === '1') {
    buildBundles();
  }

  const server = await startStaticServer();
  const { port } = server.address();
  const browser = await launchBrowser();

  try {
    // 1) Before/after consistency (separate pages, same fixture and PRNG seed).
    console.log('[1/5] baseline vs current consistency...');
    const consistency = await runConsistency(browser, port, LIVE_WIDTH, LIVE_HEIGHT);
    writeJson('baseline-comparison.json', { at: new Date().toISOString(), ...consistency });

    // Shared live page for the remaining scenarios.
    const page = await prepareLivePage(browser, port);

    // 2) 10 second export metrics.
    console.log('[2/5] 10s export...');
    const tenSecond = await page.evaluate((w, h) => window.scenarios.export10s({
      fps: 30,
      duration: 10,
      width: 1280,
      height: 720
    }, w, h), LIVE_WIDTH, LIVE_HEIGHT);
    const videoBuffer = Buffer.from(tenSecond.base64, 'base64');
    const videoPath = path.join(ARTIFACTS, 'export-10s.webm');
    fs.writeFileSync(videoPath, videoBuffer);
    delete tenSecond.base64;
    tenSecond.sha256 = sha256(videoBuffer);
    tenSecond.mediaProbe = ffprobeMedia(videoPath);
    tenSecond.meta.diskBytes = videoBuffer.length;

    // One representative frame PNG for visual inspection.
    const framePng = await page.screenshot({ encoding: 'binary' });
    fs.writeFileSync(path.join(ARTIFACTS, 'live-page.png'), framePng);
    try {
      execFileSync('ffmpeg', [
        '-y', '-v', 'error', '-i', videoPath, '-frames:v', '1',
        path.join(ARTIFACTS, 'export-10s-frame.png')
      ]);
    } catch (error) {
      console.warn('ffmpeg frame extraction failed:', error.message);
    }

    // 3) Failure paths.
    console.log('[3/5] failure paths...');
    const failures = await page.evaluate((w, h) => window.scenarios.runFailures(w, h), LIVE_WIDTH, LIVE_HEIGHT);

    // 4) Mid-export cancellation.
    console.log('[4/5] cancellation...');
    const cancellation = await page.evaluate((w, h) => window.scenarios.runCancellation({
      fps: 30, duration: 5, width: w, height: h
    }, 127, w, h), LIVE_WIDTH, LIVE_HEIGHT);

    // 5) Resource/memory bounds.
    console.log('[5/5] resource bounds...');
    const bounds = await page.evaluate((w, h) => window.scenarios.sampleBounds({
      fps: 30, duration: 5, width: w, height: h
    }), LIVE_WIDTH, LIVE_HEIGHT);

    const derivedBounds = {
      maxSimultaneousCanvases: Math.max.apply(null, bounds.samples.map(s => s.domCanvases)),
      maxSimultaneousLiveWebGLContexts: Math.max.apply(null,
        bounds.samples.map(s => s.liveWebGLContexts)),
      exportFrameBufferBytes: bounds.frameBufferBytes,
      exportFrameBufferMB: Math.round((bounds.frameBufferBytes / (1024 * 1024)) * 100) / 100,
      retainedRawFrameBuffers: bounds.rawFrameBuffersRetainedAfterSettle,
      maxObservedJsHeapMB: Math.max.apply(null,
        bounds.samples.map(s => s.jsHeapMB).filter(v => v !== null)),
      encoderChunksRetainedAfterSettle: bounds.encoderChunksRetainedAfterSettle,
      liveRendererAndCameraBoundThroughoutExport: bounds.samples
        .filter(s => typeof s.liveRendererBound === 'boolean')
        .every(s => s.liveRendererBound && s.liveCameraBound && s.liveGraphUnchanged)
    };
    writeJson('resource-bounds.json', {
      at: new Date().toISOString(),
      bounds: bounds,
      derivedUpperBounds: derivedBounds
    });

    const shortMeta = await page.evaluate(() => window.scenarios.shortExport({
      fps: 30, duration: 2, width: 640, height: 360
    }));

    const verification = {
      at: new Date().toISOString(),
      checks: {
        consistency: {
          setup: consistency.current.setup,
          consistency: {
            allFramesBitwiseIdentical: consistency.allFramesBitwiseIdentical,
            allSimulationStateBitwiseIdentical: consistency.allSimulationStateBitwiseIdentical,
            maxPercentChannelsDifferent: consistency.maxPercentChannelsDifferent,
            withinRasterizerTolerance: consistency.withinRasterizerTolerance
          }
        },
        export10s: tenSecond,
        failures: failures,
        cancellation: cancellation,
        shortExport: shortMeta
      },
      allOk: (
        consistency.withinRasterizerTolerance
        && consistency.allSimulationStateBitwiseIdentical
        && tenSecond.stateUnchanged
        && tenSecond.pixelsUnchanged
        && failures.failures.every(f => f.rejected && f.name === 'VideoExportError')
        && cancellation.settled
        && cancellation.rejection.code === 'CANCELLED'
        && cancellation.stateUnchanged
        && cancellation.pixelsUnchanged
      )
    };
    writeJson('video-export-verification.json', verification);

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify({
      allOk: verification.allOk,
      tenSecond: tenSecond.meta,
      failureCount: failures.failures.length,
      cancelled: cancellation.rejection.code
    }, null, 2));
    if (!verification.allOk) {
      process.exitCode = 1;
    }
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
