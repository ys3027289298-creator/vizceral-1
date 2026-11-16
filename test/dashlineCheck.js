/* Style-preservation check: dashed lines, additive blending, line width.
 * Uses the synthetic dash-line scene from the harness and asserts the SVG
 * carries stroke-dasharray / mix-blend-mode and records the matching
 * degradation codes. Writes dashline-scene.svg and dashline-check.json. */
const fs = require('fs');
const path = require('path');
const { launchBrowser, serveStatic } = require('./support/browser');

const OUT_DIR = path.resolve(__dirname, '..', 'artifacts', 'svg-export');
const BUILD_DIR = path.join(OUT_DIR, 'build');

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
      const scene = T.buildDashLineScene();
      const exported = T.exportSceneToSVG(scene);
      const polylines = exported.svg.match(/<polyline\b[^>]*>/g) || [];
      return {
        polylines,
        degradations: exported.degradations,
        validation: T.validateSVGStructure(exported.svg, exported.stats),
        svg: exported.svg
      };
    });

    fs.writeFileSync(path.join(OUT_DIR, 'dashline-scene.svg'), result.svg);

    const solid = result.polylines.find(p => p.includes('rgb(91,91,91)')) || '';
    const dashed = result.polylines.find(p => p.includes('rgb(186,213,237)')) || '';
    const additive = result.polylines.find(p => p.includes('rgba(184,36,36,0.8)')) || '';
    const report = {
      polylines: result.polylines,
      dashArrayPresent: /stroke-dasharray="8,4"/.test(dashed),
      solidLineHasNoDash: solid !== '' && !/stroke-dasharray/.test(solid),
      additiveMarked: (result.degradations['additive-blending-flattened'] || 0) >= 1,
      lineWidthMarked: (result.degradations['line-width-unsupported'] || 0) >= 1,
      blendModePresent: /mix-blend-mode:screen/.test(additive),
      validation: result.validation.valid,
      degradations: result.degradations,
      pageErrors
    };
    report.ok = report.dashArrayPresent && report.solidLineHasNoDash
      && report.additiveMarked && report.lineWidthMarked
      && report.blendModePresent && report.validation && pageErrors.length === 0;
    fs.writeFileSync(path.join(OUT_DIR, 'dashline-check.json'), JSON.stringify(report, null, 2));
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
