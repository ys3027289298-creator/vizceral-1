/* Deterministic render harness shared by baseline and patched builds.
 * The SVG exporter is feature-detected so this exact source runs unchanged
 * against the unmodified Vizceral baseline. Promise-style only (no async
 * keyword) to stay compatible with the project's babel-preset-env targets. */
import Vizceral from '../../src/vizceral';
import { makeSmallGraph } from './trafficData';

function createVizceral (canvas) {
  const vizceral = new Vizceral(canvas);
  vizceral.setSize(600, 400);
  return vizceral;
}

window.PixelHarness = {
  render (captureExport) {
    const canvas = document.getElementById('gl');
    const vizceral = createVizceral(canvas);
    const data = makeSmallGraph();
    vizceral.updateData(data);
    const graph = vizceral.getGraph(vizceral.rootGraphName);
    vizceral.currentGraph = graph;
    graph.setCurrent(true);
    vizceral.scene.add(graph.view.container);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('layout worker timed out')), 15000);
      graph.on('viewUpdated', () => {
        clearTimeout(timer);

        for (let i = 0; i < 5; i++) {
          graph.update(i * 16.7);
        }
        vizceral.render(0);

        const gl = vizceral.renderer.getContext();
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        let exportResult = null;
        if (captureExport && typeof vizceral.exportSVG === 'function') {
          const exported = vizceral.exportSVG();
          exportResult = {
            stats: exported.stats,
            degradations: exported.degradations,
            viewBox: exported.viewBox,
            svgBytes: exported.svg.length
          };
        }

        resolve({
          width: gl.drawingBufferWidth,
          height: gl.drawingBufferHeight,
          pixels: pixels.buffer,
          pngDataUrl: canvas.toDataURL('image/png'),
          exporterPresent: typeof vizceral.exportSVG === 'function',
          exportResult
        });
      });
    });
  }
};
