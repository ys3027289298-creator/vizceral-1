/* Pixel-level consistency proof: the patch must not change the renderer.
 * Renders the SAME deterministic scene with the baseline (git HEAD) bundle
 * and the patched bundle in headless Chromium (SwiftShader software WebGL,
 * fixed orthographic camera, fixed update ticks), then compares the raw
 * framebuffer and the canvas PNG byte for byte.
 *
 * Steps: materialize baseline-src from `git archive HEAD`, build both
 * bundles, render both, hash, compare. Writes pixel/pixel-consistency.json,
 * pixel-frame-baseline.png, pixel-frame-patched.png and merges the result
 * into before-after-comparison.json.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { launchBrowser, serveStatic } = require('./support/browser');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'svg-export');
const PIXEL_DIR = path.join(OUT_DIR, 'pixel');
const BASELINE_SRC = path.join(PIXEL_DIR, 'baseline-src');

// webpack 4 needs the legacy OpenSSL provider on Node >= 17; re-exec self
// with the flag if the parent shell did not provide it.
if (!String(process.env.NODE_OPTIONS || '').includes('openssl-legacy-provider')) {
  const result = require('child_process').spawnSync(
    process.execPath,
    [__filename].concat(process.argv.slice(2)),
    {
      stdio: 'inherit',
      env: Object.assign({}, process.env, {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --openssl-legacy-provider`.trim()
      })
    }
  );
  process.exit(result.status === null ? 1 : result.status);
}

function sha256 (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fnv1a (buffer) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i++) {
    hash ^= buffer[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16)}`;
}

function byteSum (buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) { sum += buffer[i]; }
  return sum;
}

function prepareBaselineSrc () {
  fs.rmSync(BASELINE_SRC, { recursive: true, force: true });
  fs.mkdirSync(BASELINE_SRC, { recursive: true });
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', BASELINE_SRC], { input: archive });
  // The pixel harness + fixtures are new (untracked at HEAD); copy them in
  // so baseline and patched run the IDENTICAL harness source.
  const supportDir = path.join(BASELINE_SRC, 'test', 'support');
  fs.mkdirSync(supportDir, { recursive: true });
  ['pixelHarnessEntry.js', 'trafficData.js'].forEach((name) => {
    fs.copyFileSync(path.join(ROOT, 'test', 'support', name), path.join(supportDir, name));
  });
}

function buildSide (side) {
  const buildScript = `
    const webpack = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'webpack'))});
    const factory = require(${JSON.stringify(path.join(ROOT, 'webpack.pixel.config.js'))});
    const config = factory({ side: ${JSON.stringify(side)} });
    webpack(config, (err, stats) => {
      if (err) { console.error(err); process.exit(1); }
      if (stats.hasErrors()) { console.error(stats.toString()); process.exit(1); }
      console.log(stats.toString({ colors: false, chunks: false, modules: false }));
    });
  `;
  execFileSync(process.execPath, ['-e', buildScript], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: Object.assign({}, process.env, {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --openssl-legacy-provider`.trim()
    })
  });
  fs.copyFileSync(
    path.join(ROOT, 'test', 'support', 'pixel.html'),
    path.join(PIXEL_DIR, `${side}-build`, 'index.html')
  );
}

async function renderSide (browser, side, captureExport) {
  const buildDir = path.join(PIXEL_DIR, `${side}-build`);
  const { server, url } = await serveStatic(buildDir);
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${url}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.PixelHarness !== undefined', { timeout: 30000 });
    const result = await page.evaluate(async (capture) => {
      const rendered = await window.PixelHarness.render(capture);
      const bytes = new Uint8Array(rendered.pixels);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return {
        width: rendered.width,
        height: rendered.height,
        pixelsBase64: btoa(binary),
        pngDataUrl: rendered.pngDataUrl,
        exporterPresent: rendered.exporterPresent,
        exportResult: rendered.exportResult
      };
    }, captureExport);
    await page.close();
    return {
      width: result.width,
      height: result.height,
      pixels: Buffer.from(result.pixelsBase64, 'base64'),
      png: Buffer.from(result.pngDataUrl.split(',')[1], 'base64'),
      exporterPresent: result.exporterPresent,
      exportResult: result.exportResult,
      pageErrors
    };
  } finally {
    server.close();
  }
}

async function main () {
  fs.mkdirSync(PIXEL_DIR, { recursive: true });
  prepareBaselineSrc();
  buildSide('baseline');
  buildSide('patched');

  const { browser, executablePath } = await launchBrowser();
  try {
    const baseline = await renderSide(browser, 'baseline', false);
    const patched = await renderSide(browser, 'patched', true);

    fs.writeFileSync(path.join(OUT_DIR, 'pixel-frame-baseline.png'), baseline.png);
    fs.writeFileSync(path.join(OUT_DIR, 'pixel-frame-patched.png'), patched.png);

    const summarize = (side) => ({
      byteSum: byteSum(side.pixels),
      fnv1a: fnv1a(side.pixels),
      pixelSha256: sha256(side.pixels),
      pngSha256: sha256(side.png),
      pngBytes: side.png.length,
      exporterPresent: side.exporterPresent,
      pageErrors: side.pageErrors
    });
    const baselineSummary = summarize(baseline);
    const patchedSummary = summarize(patched);
    if (patched.exportResult) {
      patchedSummary.svgExport = {
        stats: patched.exportResult.stats,
        degradations: patched.exportResult.degradations,
        viewBox: patched.exportResult.viewBox,
        svgBytes: patched.exportResult.svgBytes
      };
    }

    const framebuffersByteIdentical = baseline.pixels.equals(patched.pixels);
    const pngByteIdentical = baseline.png.equals(patched.png);
    const report = {
      generatedAt: new Date().toISOString(),
      renderer: `headless Chromium (${executablePath}) + SwiftShader software WebGL, fixed orthographic camera`,
      frameSize: {
        width: baseline.width,
        height: baseline.height,
        bytes: baseline.pixels.length
      },
      baseline: baselineSummary,
      patched: patchedSummary,
      framebuffersByteIdentical,
      pngByteIdentical,
      ok: framebuffersByteIdentical && pngByteIdentical
        && baseline.pageErrors.length === 0 && patched.pageErrors.length === 0
        && baseline.exporterPresent === false && patched.exporterPresent === true
    };
    fs.writeFileSync(path.join(PIXEL_DIR, 'pixel-consistency.json'), JSON.stringify(report, null, 2));

    // Merge the pixel proof into the before/after comparison.
    const comparisonPath = path.join(OUT_DIR, 'before-after-comparison.json');
    if (fs.existsSync(comparisonPath)) {
      const comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8'));
      comparison.pixelConsistency = {
        framebuffersByteIdentical,
        pngByteIdentical,
        baselinePngSha256: baselineSummary.pngSha256,
        patchedPngSha256: patchedSummary.pngSha256
      };
      fs.writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2));
    }

    console.log(JSON.stringify({
      ok: report.ok,
      framebuffersByteIdentical,
      pngByteIdentical,
      pixelSha256: baselineSummary.pixelSha256
    }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
