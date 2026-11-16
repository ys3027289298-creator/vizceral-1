import * as THREE from 'three';
import Vizceral, {
  exportSceneToSVG,
  validateSVGStructure,
  SVGExportError,
  SVG_EXPORT_ERRORS,
  DEGRADATION_CODES
} from '../../src/vizceral';
import { makeSmallGraph, makeLargeGraph } from './trafficData';

function createVizceral (canvas) {
  const vizceral = new Vizceral(canvas);
  vizceral.setSize(600, 400);
  return vizceral;
}

function createEmptyScene () {
  // A scene whose only child is a fully transparent mesh (mirrors the
  // TrafficGraphView placeholder), so traversal finds zero drawables.
  const scene = new THREE.Scene();
  return scene;
}

function buildDashLineScene () {
  // Synthetic scene exercising dashed lines, additive blending and the
  // line-width degradation path. The production app currently draws solid
  // lines, so this covers the style-preservation contract explicitly.
  const scene = new THREE.Scene();
  const solidGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(100, 50, 0)
  ]);
  scene.add(new THREE.Line(solidGeometry, new THREE.LineBasicMaterial({ color: 0x5b5b5b })));

  const dashedGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -20, 0),
    new THREE.Vector3(120, -20, 0)
  ]);
  const dashedMaterial = new THREE.LineDashedMaterial({
    color: 0xbad5ed,
    dashSize: 8,
    gapSize: 4,
    linewidth: 2
  });
  scene.add(new THREE.Line(dashedGeometry, dashedMaterial));

  const wideGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -40, 0),
    new THREE.Vector3(80, -70, 0)
  ]);
  const wideMaterial = new THREE.LineBasicMaterial({
    color: 0xb82424,
    linewidth: 3,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.8
  });
  scene.add(new THREE.Line(wideGeometry, wideMaterial));
  return scene;
}

function buildScene (data) {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  const vizceral = createVizceral(canvas);
  vizceral.updateData(data);
  // Force the graph and its views to build synchronously.
  const graph = vizceral.getGraph(vizceral.rootGraphName);
  graph.setState(data, true);
  graph.validateLayout();
  vizceral.currentGraph = graph;
  graph.setCurrent(true);
  vizceral.scene.add(graph.view.container);
  // Run a handful of update ticks so particle systems and label placement settle.
  for (let i = 0; i < 5; i++) {
    graph.update(i * 16.7);
  }
  vizceral.render(0);
  return { vizceral, graph };
}

function buildSceneAsync (data) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    const vizceral = createVizceral(canvas);
    vizceral.updateData(data);
    const graph = vizceral.getGraph(vizceral.rootGraphName);
    // validateLayout() only relayouts when the graph is marked current.
    vizceral.currentGraph = graph;
    graph.setCurrent(true);
    vizceral.scene.add(graph.view.container);
    const timer = setTimeout(() => reject(new Error('layout worker timed out')), 15000);
    graph.on('viewUpdated', () => {
      clearTimeout(timer);
      for (let i = 0; i < 5; i++) {
        graph.update(i * 16.7);
      }
      vizceral.render(0);
      resolve({ vizceral, graph });
    });
  });
}

window.VizceralTest = {
  Vizceral,
  exportSceneToSVG,
  validateSVGStructure,
  SVGExportError,
  SVG_EXPORT_ERRORS,
  DEGRADATION_CODES,
  makeSmallGraph,
  makeLargeGraph,
  buildScene,
  buildSceneAsync,
  createVizceral,
  createEmptyScene,
  buildDashLineScene
};
