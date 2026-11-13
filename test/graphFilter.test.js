// Unit tests for the pure graph filter module.
// Run: node test/graphFilter.test.js
const assert = require('assert');
const { loadGraphFilter } = require('./loadGraphFilter');

const gf = loadGraphFilter();

function makeGraph () {
  return {
    nodes: [
      { name: 'frontend', displayName: 'Frontend', metadata: { owner: 'team-web', latency: 120 }, metrics: { rps: 500 } },
      { name: 'api-gateway', metadata: { owner: 'team-core', latency: 40 }, metrics: { rps: 900 } },
      { name: 'api-orders', metadata: { owner: 'team-core', latency: 250 }, metrics: { rps: 120 } },
      { name: 'database', metadata: { owner: 'team-data', latency: 5 }, metrics: { rps: 300 } },
      { name: 'cache', metadata: { latency: 1 } }
    ],
    connections: [
      { source: 'frontend', target: 'api-gateway' },
      { source: 'api-gateway', target: 'api-orders' },
      { source: 'api-orders', target: 'database' },
      { source: 'api-gateway', target: 'cache' }
    ]
  };
}

let passed = 0;
function test (name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('inactive criteria (empty object) matches everything and hides nothing', () => {
  const r = gf.applyGraphFilter(makeGraph(), {});
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.empty, false);
  assert.strictEqual(r.counts.matchedNodes, 5);
  assert.strictEqual(r.counts.hiddenNodes, 0);
  assert.strictEqual(r.counts.dimmedNodes, 0);
  assert.strictEqual(r.counts.visibleConnections, 4);
});

test('fuzzy name match is case-insensitive substring', () => {
  const r = gf.applyGraphFilter(makeGraph(), { nameQuery: 'API' });
  assert.deepStrictEqual(r.matched, ['api-gateway', 'api-orders']);
});

test('name match covers displayName and metadata.owner', () => {
  const byDisplay = gf.applyGraphFilter(makeGraph(), { nameQuery: 'front' });
  assert.deepStrictEqual(byDisplay.matched, ['frontend']);
  const byOwner = gf.applyGraphFilter(makeGraph(), { nameQuery: 'team-data' });
  assert.deepStrictEqual(byOwner.matched, ['database']);
});

test('numeric range filter on metadata value, inclusive bounds', () => {
  const r = gf.applyGraphFilter(makeGraph(), { metricKey: 'latency', min: 40, max: 120 });
  assert.deepStrictEqual(r.matched, ['api-gateway', 'frontend']);
});

test('numeric range filter on metrics value, open upper bound', () => {
  const r = gf.applyGraphFilter(makeGraph(), { metricKey: 'rps', min: 400 });
  assert.deepStrictEqual(r.matched, ['api-gateway', 'frontend']);
});

test('nodes missing the metric do not match when range filter is active', () => {
  const r = gf.applyGraphFilter(makeGraph(), { metricKey: 'nonexistent', min: 0 });
  assert.strictEqual(r.counts.matchedNodes, 0);
  assert.strictEqual(r.empty, true);
});

test('name query and range filter combine with AND semantics', () => {
  const r = gf.applyGraphFilter(makeGraph(), { nameQuery: 'api', metricKey: 'latency', max: 100 });
  assert.deepStrictEqual(r.matched, ['api-gateway']);
});

test('edgePolicy hide: connection visible iff both endpoints matched', () => {
  const r = gf.applyGraphFilter(makeGraph(), { nameQuery: 'api', edgePolicy: 'hide' });
  assert.strictEqual(r.edgePolicy, 'hide');
  assert.strictEqual(r.counts.hiddenNodes, 3);
  assert.strictEqual(r.counts.dimmedNodes, 0);
  assert.strictEqual(r.counts.visibleConnections, 1);
  assert.strictEqual(r.counts.hiddenConnections, 3);
  assert.strictEqual(r.connections['api-gateway--api-orders'].hidden, false);
  assert.strictEqual(r.connections['frontend--api-gateway'].hidden, true);
});

test('edgePolicy dim: nothing hidden, non-matched greyed', () => {
  const r = gf.applyGraphFilter(makeGraph(), { nameQuery: 'api', edgePolicy: 'dim' });
  assert.strictEqual(r.counts.hiddenNodes, 0);
  assert.strictEqual(r.counts.dimmedNodes, 3);
  assert.strictEqual(r.counts.hiddenConnections, 0);
  assert.strictEqual(r.counts.dimmedConnections, 3);
  assert.strictEqual(r.counts.visibleConnections, 1);
  assert.strictEqual(r.nodes.frontend.dimmed, true);
  assert.strictEqual(r.nodes['api-gateway'].matched, true);
});

test('empty result state is explicit', () => {
  const r = gf.applyGraphFilter(makeGraph(), { nameQuery: 'does-not-exist' });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.empty, true);
  assert.strictEqual(r.counts.matchedNodes, 0);
  assert.deepStrictEqual(r.matched, []);
});

test('default edge policy is hide', () => {
  const r = gf.applyGraphFilter(makeGraph(), { nameQuery: 'api' });
  assert.strictEqual(r.edgePolicy, 'hide');
});

console.log(`\n${passed} tests passed`);
