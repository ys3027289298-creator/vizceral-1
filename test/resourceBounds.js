/* Memory/resource bounds measurement for the 1000-node export.
 * Samples performance.memory around 5 export runs, persists the final SVG,
 * and cross-checks disk content against exporter stats (no element loss).
 * Writes resource-bounds.json. */
const fs = require('fs');
const path = require('path');
const { launchBrowser, serveStatic } = require('./support/browser');

const OUT_DIR = path.resolve(__dirname, '..', 'artifacts', 'svg-export');
const BUILD_DIR = path.join(OUT_DIR, 'build');

function countTag (text, tag) {
  const matches = text.match(new RegExp(`<${tag}\\b`, 'g'));
  return matches ? matches.length : 0;
}

async function main () {
  const { browser } = await launchBrowser();
  const { server, url } = await serveStatic(BUILD_DIR);
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${url}/harness.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.VizceralTest !== undefined', { timeout: 30000 });

    const result = await page.evaluate(() => {
      const T = window.VizceralTest;
      const memory = () => (performance.memory
        ? { usedJSHeapSize: performance.memory.usedJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit }
        : { usedJSHeapSize: null, jsHeapSizeLimit: null });
      return T.buildSceneAsync(T.makeLargeGraph(1000)).then(({ vizceral }) => {
        const baseline = memory();
        const samples = [];
        let exported = null;
        let peak = baseline.usedJSHeapSize;
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          exported = vizceral.exportSVG();
          const elapsedMs = performance.now() - start;
          const sample = memory();
          peak = Math.max(peak, sample.usedJSHeapSize);
          samples.push({ run: i, elapsedMs, usedJSHeapSize: sample.usedJSHeapSize });
        }
        return {
          baselineUsedBytes: baseline.usedJSHeapSize,
          heapLimitBytes: baseline.jsHeapSizeLimit,
          peakUsedBytes: peak,
          samples,
          svg: exported.svg,
          stats: exported.stats,
          degradations: exported.degradations
        };
      });
    });

    const largePath = path.join(OUT_DIR, 'large-graph-1000.svg');
    fs.writeFileSync(largePath, result.svg);
    const diskBytes = fs.statSync(largePath).size;
    const diskCounts = {
      svg: countTag(result.svg, 'svg'),
      path: countTag(result.svg, 'path'),
      polyline: countTag(result.svg, 'polyline'),
      line: countTag(result.svg, 'line'),
      circle: countTag(result.svg, 'circle'),
      rect: countTag(result.svg, 'rect'),
      text: countTag(result.svg, 'text'),
      image: countTag(result.svg, 'image')
    };
    // Path closure check on the disk-bound string.
    const pathElements = result.svg.match(/<path\b[^>]*\bd="[^"]*"[^>]*>/g) || [];
    let closedPaths = 0;
    let openPaths = 0;
    pathElements.forEach((element) => {
      const data = (element.match(/\bd="([^"]*)"/) || [])[1] || '';
      const moves = (data.match(/M/g) || []).length;
      const closes = (data.match(/Z/g) || []).length;
      if (moves > 0 && moves === closes && /Z$/.test(data.trim())) { closedPaths++; } else { openPaths++; }
    });

    const s = result.stats;
    const noElementLoss = diskCounts.path === s.svgPaths
      && diskCounts.polyline === s.svgPolylines
      && diskCounts.line === s.svgLines
      && diskCounts.circle === s.svgCircles
      && diskCounts.text === s.svgTexts
      && diskCounts.rect >= s.svgRects
      && openPaths === 0;

    const report = {
      generatedAt: new Date().toISOString(),
      nodeCount: 1000,
      jsHeap: {
        baselineUsedBytes: result.baselineUsedBytes,
        peakUsedBytes: result.peakUsedBytes,
        heapLimitBytes: result.heapLimitBytes,
        growthBytes: result.peakUsedBytes - result.baselineUsedBytes
      },
      perRunSamples: result.samples,
      output: {
        svgBytesOnDisk: diskBytes,
        returnedSvgBytes: result.svg.length,
        matchesReturnedLength: diskBytes === Buffer.byteLength(result.svg)
      },
      onDiskTagCounts: diskCounts,
      diskValidation: { valid: openPaths === 0, closedPaths, openPaths },
      exporterStats: s,
      degradations: result.degradations,
      noElementLoss,
      pageErrors,
      ok: noElementLoss && pageErrors.length === 0
    };
    fs.writeFileSync(path.join(OUT_DIR, 'resource-bounds.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, jsHeap: report.jsHeap, noElementLoss }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    server.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
