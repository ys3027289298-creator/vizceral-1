const {
  assert, createVizceral, screenToViewport, dispatchWheel,
  dragPan, test, VIEW_WIDTH, VIEW_HEIGHT
} = require('./lib');

console.log('== Resource / memory upper-bound tests ==');

test('zoom/pan adds no THREE objects, geometries or materials to the scene graph', () => {
  const v = createVizceral();
  const countObjects = (root) => {
    let total = 0;
    root.traverse(() => { total += 1; });
    return total;
  };
  const before = countObjects(v.scene);
  const center = screenToViewport(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
  for (let i = 0; i < 50; i++) dispatchWheel(v, center.x, center.y, i % 2 ? 100 : -100);
  for (let i = 0; i < 10; i++) {
    dragPan(v, { x: 200, y: 200 }, { x: 300 + (i * 20), y: 250 + (i * 15) });
  }
  v.zoomPanInteraction.resetView();
  const after = countObjects(v.scene);
  assert.strictEqual(after, before, `scene objects ${before} -> ${after}`);
});

test('interaction state uses a fixed number of bounded vectors (no per-event allocation growth)', () => {
  const v = createVizceral();
  const zpi = v.zoomPanInteraction;
  const ownKeysBefore = Object.keys(zpi).sort();
  const center = screenToViewport(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
  for (let i = 0; i < 200; i++) dispatchWheel(v, center.x, center.y, -10);
  for (let i = 0; i < 20; i++) {
    dragPan(v, { x: 100, y: 100 }, { x: 140, y: 140 });
  }
  const ownKeysAfter = Object.keys(zpi).sort();
  assert.deepStrictEqual(ownKeysAfter, ownKeysBefore);
  // Only scalar camera state plus 5 preallocated Vector2/Vector3 instances.
  const vectorInstances = ownKeysBefore.filter(key => /Vector/.test(zpi[key] && zpi[key].constructor && zpi[key].constructor.name)).length;
  assert.strictEqual(vectorInstances, 2);
});

test('event listener count stays constant across repeated enable/disable cycles', () => {
  const v = createVizceral();
  const canvas = v.renderer.domElement;
  // jsdom does not expose listener lists; use dispatch behavior as the
  // observable bound: one wheel zoom regardless of how many cycles ran.
  for (let i = 0; i < 10; i++) {
    v.setOptions({ allowZoomPan: false });
    v.setOptions({ allowZoomPan: true });
  }
  const vp = screenToViewport(v, 100, 100);
  dispatchWheel(v, vp.x, vp.y, -100);
  const expected = Math.exp(100 * v.zoomPanInteraction.wheelZoomSpeed);
  assert.ok(Math.abs(v.camera.zoom - expected) < 1e-12, `zoom ${v.camera.zoom} vs single-listener ${expected}`);
});

test('200 mixed interactions keep heap growth bounded (no retained event objects)', () => {
  const v = createVizceral();
  if (typeof global.gc !== 'function') {
    console.log('  SKIP  explicit GC unavailable, running retention assertion without forced GC');
  } else {
    global.gc(true);
  }
  const baseline = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) {
    const vp = screenToViewport(v, 50 + (i % 400), 50 + (i % 300));
    dispatchWheel(v, vp.x, vp.y, i % 2 ? 50 : -50);
    if (i % 10 === 0) v.zoomPanInteraction.resetView();
  }
  if (typeof global.gc === 'function') global.gc(true);
  const growth = process.memoryUsage().heapUsed - baseline;
  // The interaction layer allocates no persistent per-event storage; allow
  // 5 MB for unrelated engine/runtime churn during the 200-event loop.
  assert.ok(growth < 5 * 1024 * 1024, `heap grew ${(growth / 1024 / 1024).toFixed(2)} MB`);
});

test('camera zoom state is always a finite number inside the documented range', () => {
  const v = createVizceral();
  const center = screenToViewport(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
  for (let i = 0; i < 100; i++) {
    dispatchWheel(v, center.x, center.y, i % 3 === 0 ? -1e6 : 1e6);
    assert.ok(Number.isFinite(v.camera.zoom));
    assert.ok(v.camera.zoom >= 0.5 && v.camera.zoom <= 8);
    assert.ok(Number.isFinite(v.camera.position.x) && Number.isFinite(v.camera.position.y));
  }
});

if (process.exitCode) {
  console.log('RESOURCE TESTS FAILED');
} else {
  console.log('ALL RESOURCE TESTS PASSED');
}
