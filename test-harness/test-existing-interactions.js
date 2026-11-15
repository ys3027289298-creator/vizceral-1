const {
  assert, createVizceral, nodeScreenPosition, hitAtScreen, screenToViewport,
  dispatchMouse, dragPan, test
} = require('./lib');

console.log('== Pre-existing interaction regression tests ==');

test('single click still drives the original graph click handler', () => {
  const v = createVizceral();
  const screen = nodeScreenPosition(v, 'us-east-1');
  const vp = screenToViewport(v, screen.x, screen.y);
  let viewChanged = null;
  v.on('viewChanged', payload => { viewChanged = payload.view; });
  // Global graph click on an interactive region node emits setView -> viewChanged.
  v.onDocumentClick({ center: { x: vp.x, y: vp.y } });
  assert.ok(viewChanged !== null, 'clicking a region node must still trigger setView');
  assert.deepStrictEqual(viewChanged, ['us-east-1']);
});

test('hover hit detection still reports the node under the cursor (mousemove path)', () => {
  const v = createVizceral();
  const screen = nodeScreenPosition(v, 'eu-west-1');
  const vp = screenToViewport(v, screen.x, screen.y);
  assert.strictEqual(v.calculateIntersectedObject(vp.x, vp.y).getName(), 'eu-west-1');
  v.onDocumentMouseMove({ clientX: vp.x, clientY: vp.y, preventDefault () {} });
  // The hovered object itself is applied through the original 100ms hover timer.
});

test('double-clicking a node still drills down (Hammer doubletap path preserved)', () => {
  const v = createVizceral();
  const screen = nodeScreenPosition(v, 'us-west-2');
  const vp = screenToViewport(v, screen.x, screen.y);
  let viewChanged = null;
  v.on('viewChanged', payload => { viewChanged = payload.view; });
  v.onDocumentDoubleClick({ center: { x: vp.x, y: vp.y } });
  assert.deepStrictEqual(viewChanged, ['us-west-2']);
  // Zoom/pan reset when switching graphs (fresh framing per graph).
  assert.strictEqual(v.camera.zoom, 1);
  assert.strictEqual(v.camera.position.x, 0);
});

test('node dragging (allowDraggingOfNodes) still moves nodes and does not start view panning', () => {
  const v = createVizceral();
  v.setOptions({ allowDraggingOfNodes: true });
  const target = v.currentGraph.nodes['us-east-1'];
  const original = { x: target.position.x, y: target.position.y };
  const screen = nodeScreenPosition(v, 'us-east-1');
  const start = screenToViewport(v, screen.x, screen.y);
  const end = screenToViewport(v, screen.x + 80, screen.y + 60);
  v.onDocumentMouseMove({ clientX: start.x, clientY: start.y, preventDefault () {} });
  dispatchMouse(v.renderer.domElement, 'mousedown', start.x, start.y);
  const mid = screenToViewport(v, screen.x + 30, screen.y + 20);
  dispatchMouse(document, 'mousemove', mid.x, mid.y);
  dispatchMouse(document, 'mousemove', end.x, end.y);
  dispatchMouse(document, 'mouseup', end.x, end.y);
  assert.notStrictEqual(target.position.x, original.x);
  assert.notStrictEqual(target.position.y, original.y);
  // View panning must not have engaged on a node press.
  assert.strictEqual(v.camera.position.x, 0);
  assert.strictEqual(v.camera.position.y, 0);
  v.setOptions({ allowDraggingOfNodes: false });
});

test('empty-space drag pans the view even when node dragging is enabled', () => {
  const v = createVizceral();
  v.setOptions({ allowDraggingOfNodes: true });
  dragPan(v, { x: 30, y: 30 }, { x: 200, y: 150 });
  assert.ok(Math.abs(v.camera.position.x) + Math.abs(v.camera.position.y) > 0);
  v.setOptions({ allowDraggingOfNodes: false });
});

test('findNodes search highlight behavior is unchanged', () => {
  const v = createVizceral();
  const matches = v.findNodes('us-east');
  assert.strictEqual(matches.total, 5);
  assert.ok(matches.visible >= 1);
  const cleared = v.findNodes('');
  assert.strictEqual(cleared.total, 5);
});

test('highlighted object API still works after zoom operations', () => {
  const v = createVizceral();
  // Drill into a region graph, where highlightObject is supported (the global
  // graph intentionally makes it a no-op).
  v.setView(['us-east-1']);
  const node = Object.values(v.currentGraph.nodes).find(item => item.isInteractive());
  assert.ok(node, 'region graph must contain an interactive node');
  v.setHighlightedNode(node);
  assert.strictEqual(v.currentGraph.highlightedObject, node);
  const vp = screenToViewport(v, 400, 400);
  v.zoomPanInteraction.zoomAt(vp.x, vp.y, 4);
  assert.strictEqual(v.currentGraph.highlightedObject, node);
  v.setHighlightedNode(undefined);
  assert.strictEqual(v.currentGraph.highlightedObject, undefined);
});

if (process.exitCode) {
  console.log('EXISTING-INTERACTION TESTS FAILED');
} else {
  console.log('ALL EXISTING-INTERACTION TESTS PASSED');
}
