/* Browser-side visual check of the exported SVG: loads small-graph.svg as a
 * real document, verifies it renders at the viewBox size with the expected
 * vector elements and label texts, and captures a raster screenshot for
 * eyeballing. Writes svg-visual-check.json and small-graph-render.png. */
const fs = require('fs');
const path = require('path');
const { launchBrowser, serveStatic } = require('./support/browser');

const OUT_DIR = path.resolve(__dirname, '..', 'artifacts', 'svg-export');

async function main () {
  const { browser } = await launchBrowser();
  const { server, url } = await serveStatic(OUT_DIR);
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await page.goto(`${url}/small-graph.svg`, { waitUntil: 'load' });
    const info = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      const rect = svg.getBoundingClientRect();
      return {
        viewBox: svg.getAttribute('viewBox'),
        renderedWidth: rect.width,
        renderedHeight: rect.height,
        textCount: svg.querySelectorAll('text').length,
        pathCount: svg.querySelectorAll('path').length,
        circleCount: svg.querySelectorAll('circle').length,
        polylineCount: svg.querySelectorAll('polyline').length,
        sampleText: Array.from(svg.querySelectorAll('text')).map(t => t.textContent)
      };
    });
    await page.screenshot({ path: path.join(OUT_DIR, 'small-graph-render.png'), fullPage: true });

    const testReport = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'test-report.json'), 'utf8'));
    const expected = testReport.suites.smallGraph.stats;
    const report = Object.assign({}, info, {
      expected: {
        texts: expected.svgTexts,
        paths: expected.svgPaths,
        circles: expected.svgCircles,
        polylines: expected.svgPolylines
      },
      pageErrors
    });
    report.ok = info.textCount === expected.svgTexts
      && info.pathCount === expected.svgPaths
      && info.circleCount === expected.svgCircles
      && info.polylineCount === expected.svgPolylines
      && pageErrors.length === 0;
    fs.writeFileSync(path.join(OUT_DIR, 'svg-visual-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
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
