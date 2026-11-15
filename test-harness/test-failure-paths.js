const {
  assert, createVizceral, screenToViewport, dispatchWheel,
  dispatchMouse, dragPan, test, VIEW_WIDTH, VIEW_HEIGHT
} = require('./lib');

console.log('== Failure-path / robustness tests ==');

test('setEnabled rejects non-boolean values with TypeError', () => {
  const v = createVizceral();
  assert.throws(() => v.zoomPanInteraction.setEnabled('yes'), TypeError);
  assert.throws(() => v.zoomPanInteraction.setEnabled(1), TypeError);
  assert.throws(() => v.zoomPanInteraction.setEnabled(null), TypeError);
  // State untouched after rejected calls.
  assert.strictEqual(v.zoomPanInteraction.isEnabled(), true);
});

test('clampZoom never returns values outside [minZoom, maxZoom]', () => {
  const v = createVizceral();
  assert.strictEqual(v.zoomPanInteraction.clampZoom(-5), 0.5);
  assert.strictEqual(v.zoomPanInteraction.clampZoom(0), 0.5);
  assert.strictEqual(v.zoomPanInteraction.clampZoom(100), 8);
  assert.strictEqual(v.zoomPanInteraction.clampZoom(NaN), 1);
  assert.strictEqual(v.zoomPanInteraction.clampZoom(2), 2);
});

test('zoomAt at the clamp boundary is a no-op and leaves the ray usable', () => {
  const v = createVizceral();
  const vp = screenToViewport(v, 100, 100);
  v.zoomPanInteraction.zoomAt(vp.x, vp.y, 0.5);
  const positionAtBound = { x: v.camera.position.x, y: v.camera.position.y };
  const returned = v.zoomPanInteraction.zoomAt(vp.x, vp.y, 0.01);
  assert.strictEqual(returned, 0.5);
  assert.strictEqual(v.camera.zoom, 0.5);
  assert.strictEqual(v.camera.position.x, positionAtBound.x);
  assert.strictEqual(v.camera.position.y, positionAtBound.y);
  // Picking still returns a value (null or a node) instead of throwing.
  const hit = v.calculateIntersectedObject(vp.x, vp.y);
  assert.ok(hit === null || hit === undefined || typeof hit.getName === 'function');
});

test('wheel with deltaY of zero does not change the view', () => {
  const v = createVizceral();
  const vp = screenToViewport(v, 300, 300);
  dispatchWheel(v, vp.x, vp.y, 0);
  assert.strictEqual(v.camera.zoom, 1);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
});

test('mouseup without a preceding mousedown is a safe no-op', () => {
  const v = createVizceral();
  const vp = screenToViewport(v, 300, 300);
  assert.doesNotThrow(() => dispatchMouse(document, 'mouseup', vp.x, vp.y));
  assert.strictEqual(v.zoomPanInteraction._state, 0);
});

test('mousemove without a pressed button never starts a pan', () => {
  const v = createVizceral();
  const from = screenToViewport(v, 100, 100);
  const to = screenToViewport(v, 700, 500);
  dispatchMouse(document, 'mousemove', to.x, to.y);
  dispatchMouse(document, 'mousemove', from.x, from.y);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
  assert.strictEqual(v.zoomPanInteraction._state, 0);
});

test('interleaved pan attempts cannot leave the interaction stuck in a dragging state', () => {
  const v = createVizceral();
  const canvas = v.renderer.domElement;
  const a = screenToViewport(v, 200, 200);
  const b = screenToViewport(v, 500, 400);
  dispatchMouse(canvas, 'mousedown', a.x, a.y);
  assert.strictEqual(v.zoomPanInteraction._state, 1);
  // A second mousedown while already pressed must be ignored, not corrupt state.
  dispatchMouse(canvas, 'mousedown', b.x, b.y);
  assert.strictEqual(v.zoomPanInteraction._state, 1);
  dispatchMouse(document, 'mousemove', b.x, b.y);
  dispatchMouse(document, 'mouseup', b.x, b.y);
  assert.strictEqual(v.zoomPanInteraction._state, 0);
  // The interaction must accept a fresh gesture afterwards.
  dispatchMouse(canvas, 'mousedown', a.x, a.y);
  assert.strictEqual(v.zoomPanInteraction._state, 1);
  dispatchMouse(document, 'mouseup', a.x, a.y);
});

test('window blur releases an in-progress pan (no stuck drag)', () => {
  const v = createVizceral();
  const canvas = v.renderer.domElement;
  const a = screenToViewport(v, 200, 200);
  dispatchMouse(canvas, 'mousedown', a.x, a.y);
  dispatchMouse(document, 'mousemove', a.x + 50, a.y + 50);
  assert.strictEqual(v.zoomPanInteraction._state, 2);
  window.dispatchEvent(new window.Event('blur'));
  assert.strictEqual(v.zoomPanInteraction._state, 0);
});

test('disabling zoom/pan mid-gesture releases the gesture and ignores later events', () => {
  const v = createVizceral();
  const canvas = v.renderer.domElement;
  const a = screenToViewport(v, 200, 200);
  dispatchMouse(canvas, 'mousedown', a.x, a.y);
  dispatchMouse(document, 'mousemove', a.x + 40, a.y + 40);
  assert.strictEqual(v.zoomPanInteraction._state, 2);
  v.setOptions({ allowZoomPan: false });
  assert.strictEqual(v.zoomPanInteraction._state, 0);
  const before = { zoom: v.camera.zoom, x: v.camera.position.x, y: v.camera.position.y };
  dispatchWheel(v, a.x, a.y, -500);
  dispatchMouse(document, 'mousemove', a.x + 200, a.y + 200);
  assert.strictEqual(v.camera.zoom, before.zoom);
  assert.strictEqual(v.camera.position.x, before.x);
});

test('double-click reset on the already-default view is idempotent', () => {
  const v = createVizceral();
  const empty = screenToViewport(v, 20, 20);
  dispatchMouse(v.renderer.domElement, 'dblclick', empty.x, empty.y);
  dispatchMouse(v.renderer.domElement, 'dblclick', empty.x, empty.y);
  assert.strictEqual(v.camera.zoom, 1);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
});

test('panning beyond the graph bounds and resetting recovers the default view exactly', () => {
  const v = createVizceral();
  for (let i = 0; i < 10; i++) {
    dragPan(v, { x: 100, y: 100 }, { x: VIEW_WIDTH - 50, y: VIEW_HEIGHT - 50 });
  }
  for (let i = 0; i < 30; i++) {
    const vp = screenToViewport(v, 640, 400);
    dispatchWheel(v, vp.x, vp.y, -1000);
  }
  assert.ok(v.camera.zoom === 8 || Math.abs(v.camera.position.x) > 0);
  const empty = screenToViewport(v, 10, 10);
  dispatchMouse(v.renderer.domElement, 'dblclick', empty.x, empty.y);
  assert.strictEqual(v.camera.zoom, 1);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
  assert.strictEqual(v.camera.position.z, 600);
});

test('hit testing with out-of-canvas coordinates does not throw', () => {
  const v = createVizceral();
  assert.doesNotThrow(() => {
    v.calculateIntersectedObject(-9999, -9999);
    v.calculateIntersectedObject(9999, 9999);
  });
});

if (process.exitCode) {
  console.log('FAILURE-PATH TESTS FAILED');
} else {
  console.log('ALL FAILURE-PATH TESTS PASSED');
}
