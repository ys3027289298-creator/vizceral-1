const assert = require('assert');
const THREE = require('../node_modules/three');
const { createVizceral, VIEW_WIDTH, VIEW_HEIGHT } = require('./factory');

function approx (actual, expected, epsilon = 1e-6) {
  return Math.abs(actual - expected) <= epsilon;
}

function nodeScreenPosition (vizceral, nodeName) {
  const node = vizceral.currentGraph.nodes[nodeName];
  const projected = new THREE.Vector3(node.position.x, node.position.y, node.position.z || 0).project(vizceral.camera);
  return {
    x: ((projected.x + 1) / 2) * VIEW_WIDTH,
    y: ((-projected.y + 1) / 2) * VIEW_HEIGHT,
    node
  };
}

function screenToViewport (vizceral, screenX, screenY) {
  return { x: vizceral.boundingRect.left + screenX, y: vizceral.boundingRect.top + screenY };
}

function hitAtScreen (vizceral, screenX, screenY) {
  const viewport = screenToViewport(vizceral, Math.round(screenX), Math.round(screenY));
  const hit = vizceral.calculateIntersectedObject(viewport.x, viewport.y);
  return hit ? hit.getName() : null;
}

function dispatchWheel (vizceral, viewportX, viewportY, deltaY) {
  const event = new window.WheelEvent('wheel', {
    deltaY,
    clientX: viewportX,
    clientY: viewportY,
    bubbles: true,
    cancelable: true
  });
  vizceral.renderer.domElement.dispatchEvent(event);
  return event;
}

// Sets an exact zoom level through the production zoomAt() code path,
// anchored at a given viewport position (deterministic replacement for a
// sequence of wheel notches).
function setZoomAt (vizceral, viewportX, viewportY, zoom) {
  vizceral.zoomPanInteraction.zoomAt(viewportX, viewportY, zoom);
}

function dispatchMouse (target, type, viewportX, viewportY, button = 0) {
  const event = new window.MouseEvent(type, {
    clientX: viewportX,
    clientY: viewportY,
    button,
    bubbles: true,
    cancelable: true,
    view: window
  });
  target.dispatchEvent(event);
  return event;
}

// Performs a drag-pan from one screen point to another using the same
// mousedown/mousemove/mouseup sequence a browser would emit.
function dragPan (vizceral, fromScreen, toScreen) {
  const canvas = vizceral.renderer.domElement;
  const from = screenToViewport(vizceral, fromScreen.x, fromScreen.y);
  const to = screenToViewport(vizceral, toScreen.x, toScreen.y);
  dispatchMouse(canvas, 'mousedown', from.x, from.y);
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * (i / steps));
    const y = from.y + ((to.y - from.y) * (i / steps));
    dispatchMouse(document, 'mousemove', x, y);
  }
  dispatchMouse(document, 'mouseup', to.x, to.y);
}

function readPixel (vizceral, screenX, screenY) {
  const gl = vizceral.renderer.getContext();
  const pixel = new Uint8Array(4);
  gl.readPixels(Math.round(screenX), Math.round(VIEW_HEIGHT - screenY), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return Array.from(pixel);
}

function readAllPixels (vizceral) {
  const gl = vizceral.renderer.getContext();
  const pixels = new Uint8Array(VIEW_WIDTH * VIEW_HEIGHT * 4);
  gl.readPixels(0, 0, VIEW_WIDTH, VIEW_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

function renderFrames (vizceral, count) {
  for (let i = 0; i < count; i++) {
    vizceral.render(2000 + (i * 16));
  }
}

let passedCount = 0;
function test (name, fn) {
  try {
    fn();
    passedCount += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assert,
  approx,
  createVizceral,
  nodeScreenPosition,
  screenToViewport,
  hitAtScreen,
  dispatchWheel,
  setZoomAt,
  dispatchMouse,
  dragPan,
  readPixel,
  readAllPixels,
  renderFrames,
  test,
  VIEW_WIDTH,
  VIEW_HEIGHT
};
