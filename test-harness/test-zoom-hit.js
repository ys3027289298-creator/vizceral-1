const {
  assert, approx, createVizceral, nodeScreenPosition, screenToViewport,
  hitAtScreen, dispatchWheel, setZoomAt, dragPan, dispatchMouse, test, VIEW_WIDTH, VIEW_HEIGHT
} = require('./lib');

console.log('== Zoom / pan / hit-detection tests ==');

test('default camera starts at 1x zoom centered at origin', () => {
  const v = createVizceral();
  assert.strictEqual(v.camera.zoom, 1);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
});

test('zoom is clamped to the documented lower bound (0.5x)', () => {
  const v = createVizceral();
  for (let i = 0; i < 30; i++) {
    dispatchWheel(v, 100, 100, +100);
  }
  assert.ok(approx(v.camera.zoom, 0.5, 1e-9), `zoom=${v.camera.zoom}`);
  assert.strictEqual(v.zoomPanInteraction.minZoom, 0.5);
});

test('zoom is clamped to the documented upper bound (8x)', () => {
  const v = createVizceral();
  for (let i = 0; i < 60; i++) {
    dispatchWheel(v, 100, 100, -100);
  }
  assert.ok(approx(v.camera.zoom, 8, 1e-9), `zoom=${v.camera.zoom}`);
  assert.strictEqual(v.zoomPanInteraction.maxZoom, 8);
});

test('wheel zoom keeps the world point under the cursor screen-fixed', () => {
  const v = createVizceral();
  const cursorScreen = { x: 400, y: 250 };
  const cursorViewport = screenToViewport(v, cursorScreen.x, cursorScreen.y);
  const worldBefore = v.zoomPanInteraction.viewportToWorld(
    cursorViewport.x, cursorViewport.y, new (require('../node_modules/three').Vector3)()
  );
  dispatchWheel(v, cursorViewport.x, cursorViewport.y, -200);
  const worldAfter = v.zoomPanInteraction.viewportToWorld(
    cursorViewport.x, cursorViewport.y, new (require('../node_modules/three').Vector3)()
  );
  assert.ok(approx(worldAfter.x, worldBefore.x, 1e-6), `x ${worldAfter.x} vs ${worldBefore.x}`);
  assert.ok(approx(worldAfter.y, worldBefore.y, 1e-6), `y ${worldAfter.y} vs ${worldBefore.y}`);
  assert.ok(v.camera.zoom > 1, `zoom should increase, got ${v.camera.zoom}`);
});

test('wheel event default is prevented (page never scrolls)', () => {
  const v = createVizceral();
  const event = dispatchWheel(v, 50, 50, -100);
  assert.strictEqual(event.defaultPrevented, true);
});

// Required proof: identical screen points must hit the same node at 0.5x / 1x / 4x.
[0.5, 1, 4].forEach((targetZoom) => {
  test(`node picking at ${targetZoom}x matches the node projected to that screen point`, () => {
    const v = createVizceral();
    const nodeNames = Object.keys(v.currentGraph.nodes);
    // Anchor the zoom on a node that stays on screen even at high zoom so the
    // same picking path can be exercised at every required zoom level.
    const anchor = nodeScreenPosition(v, 'us-west-2');
    const anchorViewport = screenToViewport(v, anchor.x, anchor.y);
    setZoomAt(v, anchorViewport.x, anchorViewport.y, targetZoom);
    assert.ok(approx(v.camera.zoom, targetZoom, 1e-6), `could not reach zoom ${targetZoom}, got ${v.camera.zoom}`);

    let checked = 0;
    nodeNames.forEach((nodeName) => {
      const screen = nodeScreenPosition(v, nodeName);
      // Off-screen nodes cannot be picked at this zoom; skip them.
      if (screen.x < 0 || screen.x > VIEW_WIDTH || screen.y < 0 || screen.y > VIEW_HEIGHT) {
        return;
      }
      // The entry node deliberately has no interactive mesh (product behavior).
      if (!screen.node.isInteractive()) {
        return;
      }
      const hit = hitAtScreen(v, screen.x, screen.y);
      assert.strictEqual(hit, nodeName, `at ${targetZoom}x screen(${screen.x.toFixed(1)},${screen.y.toFixed(1)}): expected ${nodeName}, got ${hit}`);
      checked += 1;
    });
    // At 4x only the anchor region remains inside the viewport; the assertion
    // is that every still-visible node is picked at its projected screen point.
    const minimumPicks = targetZoom >= 4 ? 1 : 3;
    assert.ok(checked >= minimumPicks, `expected >= ${minimumPicks} on-screen nodes at ${targetZoom}x, picked ${checked}`);
  });
});

test('a fixed screen point resolves to the expected world-space point at every zoom level', () => {
  const v = createVizceral();
  const THREE = require('../node_modules/three');
  const fixedScreen = { x: 700, y: 500 };
  const viewport = screenToViewport(v, fixedScreen.x, fixedScreen.y);
  const worldByZoom = {};
  const center = screenToViewport(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
  [0.5, 1, 4].forEach((targetZoom) => {
    setZoomAt(v, center.x, center.y, targetZoom);
    worldByZoom[targetZoom] = v.zoomPanInteraction.viewportToWorld(viewport.x, viewport.y, new THREE.Vector3());
  });
  // Screen-to-world must scale inversely with zoom around the (panned) center.
  const ratio05 = worldByZoom[0.5].x / worldByZoom[1].x;
  const ratio4 = worldByZoom[4].x / worldByZoom[1].x;
  assert.ok(approx(ratio05, 2, 0.01), `0.5x/1x world ratio ${ratio05}`);
  assert.ok(approx(ratio4, 0.25, 0.01), `4x/1x world ratio ${ratio4}`);
});

test('at 4x, panning to each off-screen node restores correct picking for every node', () => {
  const v = createVizceral();
  const THREE = require('../node_modules/three');
  const anchor = nodeScreenPosition(v, 'us-west-2');
  const anchorViewport = screenToViewport(v, anchor.x, anchor.y);
  setZoomAt(v, anchorViewport.x, anchorViewport.y, 4);
  assert.ok(approx(v.camera.zoom, 4, 1e-6));

  const interactiveNodes = Object.values(v.currentGraph.nodes).filter(node => node.isInteractive());
  interactiveNodes.forEach((node) => {
    // Pan the camera so the node's world position lands on the viewport center.
    const nodeWorld = new THREE.Vector3(node.position.x, node.position.y, 0);
    const centerWorld = v.zoomPanInteraction.viewportToWorld(
      v.boundingRect.left + (VIEW_WIDTH / 2),
      v.boundingRect.top + (VIEW_HEIGHT / 2),
      new THREE.Vector3()
    );
    v.zoomPanInteraction.moveCameraBy(nodeWorld.x - centerWorld.x, nodeWorld.y - centerWorld.y);
    const hit = hitAtScreen(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
    assert.strictEqual(hit, node.getName(), `4x centered pick for ${node.getName()} got ${hit}`);
  });
});

test('drag panning moves the camera and keeps node picking correct', () => {
  const v = createVizceral();
  const before = nodeScreenPosition(v, 'us-west-2');
  dragPan(v, { x: 300, y: 300 }, { x: 420, y: 380 });
  assert.ok(Math.abs(v.camera.position.x) + Math.abs(v.camera.position.y) > 0, 'camera must move when panning');
  const after = nodeScreenPosition(v, 'us-west-2');
  const hit = hitAtScreen(v, after.x, after.y);
  assert.strictEqual(hit, 'us-west-2');
  // Content follows the drag direction (drag down-right => content moves down-right).
  assert.ok(after.x > before.x, `x screen ${after.x} should exceed ${before.x}`);
  assert.ok(after.y > before.y, `y screen ${after.y} should exceed ${before.y}`);
});

test('a pan gesture suppresses the click so node click behavior does not fire', () => {
  const v = createVizceral();
  dragPan(v, { x: 200, y: 200 }, { x: 320, y: 260 });
  assert.strictEqual(v.zoomPanInteraction.shouldSuppressClick(), true);
  // Simulate the Hammer singletap that would normally arrive after mouseup.
  v.onDocumentClick({ center: { x: 320, y: 260 } });
  assert.strictEqual(v.zoomPanInteraction.shouldSuppressClick(), false);
});

test('a plain click (no drag) is not suppressed and still hit-tests', () => {
  const v = createVizceral();
  const canvas = v.renderer.domElement;
  const vp = screenToViewport(v, 100, 100);
  dispatchMouse(canvas, 'mousedown', vp.x, vp.y);
  dispatchMouse(document, 'mouseup', vp.x, vp.y);
  assert.strictEqual(v.zoomPanInteraction.shouldSuppressClick(), false);
});

test('double-click on empty space resets zoom and pan', () => {
  const v = createVizceral();
  const center = screenToViewport(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
  for (let i = 0; i < 20; i++) dispatchWheel(v, center.x, center.y, -100);
  dragPan(v, { x: 300, y: 300 }, { x: 400, y: 360 });
  assert.ok(v.camera.zoom > 1.1 || v.camera.position.x !== 0);
  const empty = screenToViewport(v, 50, 50);
  dispatchMouse(v.renderer.domElement, 'dblclick', empty.x, empty.y);
  assert.strictEqual(v.camera.zoom, 1);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
});

test('double-click on a node does not reset (original drill-down behavior preserved)', () => {
  const v = createVizceral();
  const center = screenToViewport(v, VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
  for (let i = 0; i < 10; i++) dispatchWheel(v, center.x, center.y, -100);
  const zoomBefore = v.camera.zoom;
  const screen = nodeScreenPosition(v, 'us-east-1');
  const vp = screenToViewport(v, screen.x, screen.y);
  dispatchMouse(v.renderer.domElement, 'dblclick', vp.x, vp.y);
  assert.strictEqual(v.camera.zoom, zoomBefore);
});

test('setOptions({ allowZoomPan: false }) detaches all interaction listeners', () => {
  const v = createVizceral();
  v.setOptions({ allowZoomPan: false });
  assert.strictEqual(v.zoomPanInteraction.isEnabled(), false);
  const event = dispatchWheel(v, 100, 100, -100);
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(v.camera.zoom, 1);
  v.setOptions({ allowZoomPan: true });
  assert.strictEqual(v.zoomPanInteraction.isEnabled(), true);
});

test('right-button drag does not start panning', () => {
  const v = createVizceral();
  const canvas = v.renderer.domElement;
  const from = screenToViewport(v, 200, 200);
  const to = screenToViewport(v, 320, 280);
  dispatchMouse(canvas, 'mousedown', from.x, from.y, 2);
  dispatchMouse(document, 'mousemove', to.x, to.y, 2);
  dispatchMouse(document, 'mouseup', to.x, to.y, 2);
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
});

if (process.exitCode) {
  console.log('ZOOM/HIT TESTS FAILED');
} else {
  console.log('ALL ZOOM/HIT TESTS PASSED');
}
