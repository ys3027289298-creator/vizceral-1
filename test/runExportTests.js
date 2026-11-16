/* Functional test runner for the SVG exporter.
 * Loads the harness bundle in headless Chromium and exercises:
 *   1. smallGraph   - 4 nodes / 3 edges end-to-end export + in-page validation
 *   2. failures     - the four deterministic error codes
 *   3. benchmark1000- 1000-node graph, 5 timed export runs
 * Writes: small-graph.svg, large-graph-1000.svg, test-report.json,
 *         benchmark-1000.json, before-after-comparison.json
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, serveStatic } = require('./support/browser');

const OUT_DIR = path.resolve(__dirname, '..', 'artifacts', 'svg-export');
const BUILD_DIR = path.join(OUT_DIR, 'build');

function median (values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main () {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, executablePath } = await launchBrowser();
  const { server, url } = await serveStatic(BUILD_DIR);
  const report = { generatedAt: new Date().toISOString(), chrome: executablePath, suites: {} };

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') { pageErrors.push(`console: ${msg.text()}`); }
    });
    await page.goto(`${url}/harness.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.VizceralTest !== undefined', { timeout: 30000 });

    // ---- Suite 1: small graph end-to-end ----------------------------------
    const small = await page.evaluate(() => {
      const T = window.VizceralTest;
      return T.buildSceneAsync(T.makeSmallGraph()).then(({ vizceral }) => {
        const exported = vizceral.exportSVG();
        const validation = T.validateSVGStructure(exported.svg, exported.stats);
        return {
          stats: exported.stats,
          degradations: exported.degradations,
          viewBox: exported.viewBox,
          validation,
          svg: exported.svg
        };
      });
    });
    fs.writeFileSync(path.join(OUT_DIR, 'small-graph.svg'), small.svg);
    report.suites.smallGraph = {
      nodeCount: 4,
      edgeCount: 3,
      stats: small.stats,
      degradations: small.degradations,
      viewBox: small.viewBox,
      validation: small.validation,
      svgBytes: small.svg.length,
      pageErrors: pageErrors.slice(),
      ok: small.validation.valid && pageErrors.length === 0
    };

    // ---- Suite 2: deterministic failure paths ------------------------------
    const failures = await page.evaluate(() => {
      const T = window.VizceralTest;
      const capture = (fn) => {
        try {
          fn();
          return { ok: false, code: null, error: 'expected export to throw, but it returned' };
        } catch (err) {
          // Note: babel-transpiled `class extends Error` breaks `instanceof`
          // across the bundle boundary, so match on name + code as well.
          const isExportError = err && (err instanceof T.SVGExportError
            || (err.name === 'SVGExportError' && typeof err.code === 'string'));
          return {
            ok: isExportError,
            code: err && err.code ? err.code : null,
            name: err && err.name,
            message: err && err.message
          };
        }
      };
      const cases = [];
      cases.push(Object.assign({ case: 'null-scene' },
        capture(() => T.exportSceneToSVG(null))));
      cases.push(Object.assign({ case: 'empty-scene' },
        capture(() => T.exportSceneToSVG(T.createEmptyScene()))));
      cases.push(Object.assign({ case: 'invalid-options' },
        capture(() => T.exportSceneToSVG(T.createEmptyScene(), { maxElements: -5 }))));
      return T.buildSceneAsync(T.makeSmallGraph()).then(({ vizceral }) => {
        cases.push(Object.assign({ case: 'element-limit' },
          capture(() => T.exportSceneToSVG(vizceral.scene, { maxElements: 2 }))));
        return cases;
      });
    });
    const expectedCodes = {
      'null-scene': 'NO_SCENE',
      'empty-scene': 'EMPTY_SCENE',
      'invalid-options': 'INVALID_OPTIONS',
      'element-limit': 'ELEMENT_LIMIT_EXCEEDED'
    };
    failures.forEach((entry) => {
      entry.expectedCode = expectedCodes[entry.case];
      entry.ok = entry.ok && entry.code === entry.expectedCode;
    });
    report.suites.failures = {
      cases: failures,
      pageErrors: pageErrors.slice(),
      ok: failures.every(entry => entry.ok) && pageErrors.length === 0
    };

    // ---- Suite 3: 1000-node benchmark --------------------------------------
    const bench = await page.evaluate(() => {
      const T = window.VizceralTest;
      return T.buildSceneAsync(T.makeLargeGraph(1000)).then(({ vizceral }) => {
        const runs = [];
        let exported = null;
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          exported = vizceral.exportSVG();
          runs.push(performance.now() - start);
        }
        const validation = T.validateSVGStructure(exported.svg, exported.stats);
        return {
          runs,
          stats: exported.stats,
          degradations: exported.degradations,
          viewBox: exported.viewBox,
          validation,
          svg: exported.svg
        };
      });
    });
    const largePath = path.join(OUT_DIR, 'large-graph-1000.svg');
    fs.writeFileSync(largePath, bench.svg);
    const medianMs = median(bench.runs);
    report.suites.benchmark1000 = {
      nodeCount: 1000,
      edgeCount: 999,
      runs: bench.runs,
      stats: bench.stats,
      degradations: bench.degradations,
      viewBox: bench.viewBox,
      validation: bench.validation,
      svgBytes: bench.svg.length,
      medianElapsedMs: medianMs,
      pageErrors: pageErrors.slice(),
      ok: bench.validation.valid && pageErrors.length === 0
    };

    const diskBytes = fs.statSync(largePath).size;
    const benchmarkSummary = {
      nodeCount: 1000,
      edgeCount: 999,
      timingRunsMs: bench.runs.map(v => Math.round(v * 10) / 10),
      medianElapsedMs: Math.round(medianMs * 10) / 10,
      svgFileBytes: diskBytes,
      svgFileKiB: Math.round((diskBytes / 1024) * 100) / 100,
      svgFileMiB: Math.round((diskBytes / (1024 * 1024)) * 100) / 100,
      inMemoryTagCounts: bench.validation.counts,
      inMemoryStructureValidation: {
        valid: bench.validation.valid,
        errors: bench.validation.errors,
        closedPaths: bench.validation.closedPaths,
        openPaths: bench.validation.openPaths
      },
      viewBox: bench.viewBox,
      degradations: bench.degradations,
      note: 'Timing is the median of 5 export runs in one page session. Disk-level tag counts and closure are verified separately by test/structureCheck.js. Particle counts vary run-to-run due to randomized particle positions.'
    };
    fs.writeFileSync(path.join(OUT_DIR, 'benchmark-1000.json'), JSON.stringify(benchmarkSummary, null, 2));

    // ---- Before/after comparison (same input fixture) -----------------------
    const comparison = {
      generatedAt: new Date().toISOString(),
      input: {
        fixture: 'test/support/trafficData.js#makeSmallGraph',
        renderer: 'region',
        nodes: 4,
        edges: 3,
        maxVolume: 600
      },
      before: {
        exportEntryPoint: null,
        nodeRepresentation: 'WebGL framebuffer bitmap only (no vector export existed)',
        edgeRepresentation: 'WebGL framebuffer bitmap only',
        labelRepresentation: 'Canvas 2D texture on a plane (bitmap)',
        vectorElements: 0,
        structureValidation: 'not available',
        exporterPresentInBundle: false
      },
      after: {
        exportEntryPoint: 'vizceral.exportSVG(options) / exportSceneToSVG(scene, options)',
        nodePaths: small.stats.svgPaths,
        edgePolylines: small.stats.svgPolylines,
        particleCircles: small.stats.svgCircles,
        labelRects: small.stats.svgRects,
        labelTexts: small.stats.svgTexts,
        rasterImageFallbacks: small.stats.svgImages,
        vectorElements: small.stats.svgPaths + small.stats.svgPolylines
          + small.stats.svgLines + small.stats.svgCircles
          + small.stats.svgRects + small.stats.svgTexts,
        openPaths: small.validation.openPaths,
        closedPaths: small.validation.closedPaths,
        structureValid: small.validation.valid,
        viewBox: small.viewBox,
        svgBytes: small.svg.length,
        exporterPresentInBundle: true,
        degradations: small.degradations
      }
    };
    fs.writeFileSync(path.join(OUT_DIR, 'before-after-comparison.json'), JSON.stringify(comparison, null, 2));

    report.ok = report.suites.smallGraph.ok && report.suites.failures.ok && report.suites.benchmark1000.ok;
    fs.writeFileSync(path.join(OUT_DIR, 'test-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: report.ok,
      smallGraph: report.suites.smallGraph.ok,
      failures: report.suites.failures.ok,
      benchmark1000: report.suites.benchmark1000.ok,
      medianElapsedMs: medianMs,
      svgBytes1000: bench.svg.length
    }, null, 2));
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
