// Bitwise legacy-behavior verification.
//
// Transpiles the relevant src files of BOTH the baseline commit (no filter
// feature) and the current working tree, drives both through an identical
// deterministic scenario with the graph filter DISABLED, and compares the
// resulting snapshots byte for byte (SHA-256 over canonical JSON).
//
// Then runs the current code with the graph filter ENABLED and proves the
// layout inputs and node positions are identical to the legacy run
// (layout zero-change guarantee).
//
// Run: node test/verifyLegacy.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The transpiled builds live outside the repo; let them resolve the repo's
// node_modules (lodash, @tweenjs/tween.js) without a shell-level NODE_PATH.
process.env.NODE_PATH = path.join(__dirname, '..', 'node_modules');
require('module').Module._initPaths();

const babel = require('babel-core');

const REPO = path.join(__dirname, '..');
const BASELINE_SRC = process.env.BASELINE_SRC || '/tmp/vizceral-baseline/src';
const CURRENT_SRC = path.join(REPO, 'src');

const TRANSPILE_FILES = [
  'base/trafficGraph.js',
  'base/node.js',
  'base/connection.js',
  'base/graphObject.js',
  'base/graphFilter.js'
];

const STUBS = {
  'physics/particleSystem.js': `class ParticleSystem {
  constructor () { this.options = {}; }
  setLastUpdateTime () {}
  enable () {}
  disable () {}
  update () {}
  onTrafficGraphChanged () {}
  getOptions () { return this.options; }
}
module.exports = ParticleSystem;
`,
  'notices.js': `module.exports = { hideNotices () {}, showNotices () {} };
`,
  'base/trafficGraphView.js': `class TrafficGraphView {
  constructor () { this.updateStateCalls = 0; }
  updateState () { this.updateStateCalls += 1; }
  removeObject () {}
  invalidateInteractiveChildren () {}
}
module.exports = TrafficGraphView;
`
};

function build (srcDir, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const rel of TRANSPILE_FILES) {
    const from = path.join(srcDir, rel);
    if (!fs.existsSync(from)) { continue; } // baseline has no graphFilter.js
    const { code } = babel.transformFileSync(from, {
      babelrc: false,
      presets: [require.resolve('babel-preset-env')]
    });
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, code);
  }
  for (const [rel, code] of Object.entries(STUBS)) {
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, code);
  }
}

// Deterministic datasets
const D1 = {
  maxVolume: 1000,
  nodes: [
    { name: 'frontend', displayName: 'Frontend', metadata: { owner: 'team-web', latency: 120 }, metrics: { rps: 500 } },
    { name: 'api-gateway', metadata: { owner: 'team-core', latency: 40 }, metrics: { rps: 900 } },
    { name: 'api-orders', metadata: { owner: 'team-core', latency: 250 }, metrics: { rps: 120 } },
    { name: 'database', metadata: { owner: 'team-data', latency: 5 }, metrics: { rps: 300 } },
    { name: 'cache', metadata: { latency: 1 }, metrics: { rps: 50 } },
    { name: 'worker', metadata: { owner: 'team-core', latency: 80 }, metrics: { rps: 200 } }
  ],
  connections: [
    { source: 'frontend', target: 'api-gateway', metrics: { normal: 100 } },
    { source: 'api-gateway', target: 'api-orders', metrics: { normal: 80 } },
    { source: 'api-orders', target: 'database', metrics: { normal: 60 } },
    { source: 'api-gateway', target: 'cache', metrics: { normal: 40 } },
    { source: 'frontend', target: 'worker', metrics: { normal: 20 } },
    { source: 'worker', target: 'database', metrics: { normal: 10 } }
  ]
};

const D2 = {
  maxVolume: 1000,
  nodes: D1.nodes.filter(n => n.name !== 'cache').concat([
    { name: 'search-api', metadata: { owner: 'team-search', latency: 60 }, metrics: { rps: 700 } }
  ]),
  connections: D1.connections.filter(c => c.target !== 'cache').concat([
    { source: 'frontend', target: 'search-api', metrics: { normal: 70 } }
  ])
};

const FILTERS = [
  {
    name: 'minVolume',
    type: 'connection',
    value: 50,
    defaultValue: 50,
    passes: (obj, v) => obj.getVolumeTotal() >= v
  },
  {
    name: 'showAll',
    type: 'node',
    value: true,
    defaultValue: true,
    passes: () => true
  }
];

function runScenario (buildDir, mode) {
  // trafficGraph.js reads the global `window` for performance.now(); provide
  // an identical stub on both sides so behavior stays deterministic.
  global.window = {};
  const TrafficGraph = require(path.join(buildDir, 'base', 'trafficGraph.js')).default;
  const Node = require(path.join(buildDir, 'base', 'node.js')).default;
  const Connection = require(path.join(buildDir, 'base', 'connection.js')).default;
  const GraphObject = require(path.join(buildDir, 'base', 'graphObject.js')).default;

  const layoutRuns = [];
  const events = [];
  const viewCalls = [];

  class FakeLayout {
    run (graph, dimensions, layoutComplete) {
      layoutRuns.push({
        nodes: graph.nodes.map(n => n.getName()),
        connections: graph.connections.map(c => c.getName()),
        entryNode: graph.entryNode === undefined ? null : graph.entryNode,
        dimensions: { width: dimensions.width, height: dimensions.height }
      });
      graph.nodes.forEach((n, i) => {
        n.updatePosition({ x: (i * 37) % 101, y: (i * 53) % 97 });
      });
      layoutComplete();
    }
  }

  // Replace view creation with a deterministic fake that records calls.
  GraphObject.prototype.getView = function getView () {
    if (!this.__fakeView) {
      const name = this.getName();
      this.__fakeView = {
        dimmed: false,
        setDimmed (dimmed, applied) { viewCalls.push(['setDimmed', name, dimmed, applied]); this.dimmed = dimmed; return true; },
        setDimPercent () {},
        setHighlight (h) { viewCalls.push(['setHighlight', name, h]); },
        update () {},
        updatePosition () {},
        showLabel () {},
        refresh () {},
        cleanup () {}
      };
    }
    return this.__fakeView;
  };

  const graph = new TrafficGraph('test', null, null, 800, 600, Node, Connection, FakeLayout, undefined);
  graph.on('viewUpdated', () => events.push(['viewUpdated']));
  graph.on('objectHighlighted', o => events.push(['objectHighlighted', o ? o.getName() : null]));
  graph.on('graphFilterStatus', s => events.push(['graphFilterStatus', s]));

  graph.setState(JSON.parse(JSON.stringify(D1)), true);
  graph.setCurrent(true);

  const matches = graph.highlightMatchedNodes('api');
  events.push(['matches', matches]);
  graph.highlightMatchedNodes('');

  graph.setFilters(FILTERS);

  graph.setState(JSON.parse(JSON.stringify(D2)), true);
  graph.validateLayout();

  graph.highlightObject(graph.getNode('api-gateway'));
  graph.highlightObject(undefined);

  graph.update(16);

  const filterStatuses = [];
  if (mode === 'filtered') {
    filterStatuses.push(['hide', graph.setGraphFilter({ nameQuery: 'api' })]);
    filterStatuses.push(['dim', graph.setGraphFilter({ nameQuery: 'api', edgePolicy: 'dim' })]);
    filterStatuses.push(['range', graph.setGraphFilter({ metricKey: 'latency', min: 40, max: 120, edgePolicy: 'dim' })]);
    filterStatuses.push(['empty', graph.setGraphFilter({ nameQuery: 'no-such-node' })]);
    filterStatuses.push(['cleared', graph.clearGraphFilter()]);
    try {
      graph.setGraphFilter({ metricKey: 'latency', min: 100, max: 10 });
    } catch (e) {
      filterStatuses.push(['invalidThrows', `${e.constructor.name}: ${e.message}`]);
    }
  }

  const nodeNames = Object.keys(graph.nodes).sort();
  const connectionNames = Object.keys(graph.connections).sort();
  return {
    layoutRuns,
    events,
    viewCalls,
    filterStatuses,
    updateStateCalls: graph.view.updateStateCalls,
    nodeCounts: graph.nodeCounts,
    volume: graph.volume,
    nodes: nodeNames.map(name => ({
      name,
      filtered: !!graph.nodes[name].filtered,
      filterHidden: !!graph.nodes[name].filterHidden,
      visible: graph.nodes[name].isVisible(),
      position: { x: graph.nodes[name].position.x, y: graph.nodes[name].position.y }
    })),
    connections: connectionNames.map(name => ({
      name,
      filtered: !!graph.connections[name].filtered,
      filterHidden: !!graph.connections[name].filterHidden,
      visible: graph.connections[name].isVisible()
    }))
  };
}

function canonical (value) {
  if (Array.isArray(value)) { return value.map(canonical); }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) { out[key] = canonical(value[key]); }
    return out;
  }
  return value;
}

function hash (snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}

// ---- main ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-verify-'));
const baselineDir = path.join(tmp, 'baseline');
const currentDir = path.join(tmp, 'current');
build(BASELINE_SRC, baselineDir);
build(CURRENT_SRC, currentDir);

const baselineLegacy = runScenario(baselineDir, 'legacy');
const currentLegacy = runScenario(currentDir, 'legacy');
const currentFiltered = runScenario(currentDir, 'filtered');

const legacyEqual = JSON.stringify(canonical(baselineLegacy)) === JSON.stringify(canonical(currentLegacy));

// Layout zero-change: layout inputs and final positions with filter enabled
// must equal the legacy run of the same code.
const positionsOf = s => s.nodes.map(n => [n.name, n.position.x, n.position.y]);
const layoutInputsEqual = JSON.stringify(currentFiltered.layoutRuns) === JSON.stringify(currentLegacy.layoutRuns);
const positionsEqual = JSON.stringify(positionsOf(currentFiltered)) === JSON.stringify(positionsOf(currentLegacy));

const report = {
  legacyBitwise: {
    baselineSha256: hash(baselineLegacy),
    currentSha256: hash(currentLegacy),
    identical: legacyEqual
  },
  layoutZeroChange: {
    layoutInputsIdentical: layoutInputsEqual,
    nodePositionsIdentical: positionsEqual
  },
  filterStatuses: currentFiltered.filterStatuses,
  snapshots: {
    baselineLegacy,
    currentFiltered
  }
};

const outFile = path.join(REPO, 'artifacts', 'verify-legacy.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(`baseline (85af133) legacy snapshot sha256: ${report.legacyBitwise.baselineSha256}`);
console.log(`current  (filter off) snapshot sha256: ${report.legacyBitwise.currentSha256}`);
console.log(`legacy behavior bitwise identical: ${legacyEqual}`);
console.log(`layout inputs identical with filter on: ${layoutInputsEqual}`);
console.log(`node positions identical with filter on: ${positionsEqual}`);
console.log(`full report: ${path.relative(REPO, outFile)}`);

assert.ok(legacyEqual, 'FAIL: legacy behavior differs between baseline and current code');
assert.ok(layoutInputsEqual, 'FAIL: layout inputs changed when graph filter is active');
assert.ok(positionsEqual, 'FAIL: node positions changed when graph filter is active');
console.log('\nAll verification checks passed');
