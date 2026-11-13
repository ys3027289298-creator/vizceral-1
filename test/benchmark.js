// Benchmark: graph filter cost at 1000 nodes / 3000 connections.
// Run: node --expose-gc test/benchmark.js
const { performance } = require('perf_hooks');
const { loadGraphFilter } = require('./loadGraphFilter');

const gf = loadGraphFilter();

const NODE_COUNT = 1000;
const CONNECTION_COUNT = 3000;

function makeGraph (n, m) {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      name: `service-${i}`,
      displayName: `Service ${i}`,
      metadata: { owner: `team-${i % 20}`, latency: i % 500 },
      metrics: { rps: (i * 7) % 1000 }
    });
  }
  const connections = [];
  for (let i = 0; i < m; i++) {
    connections.push({
      source: `service-${i % n}`,
      target: `service-${(i * 13 + 7) % n}`
    });
  }
  return { nodes, connections };
}

function bench (label, graph, criteria, iterations) {
  for (let i = 0; i < 10; i++) { gf.applyGraphFilter(graph, criteria); }
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    gf.applyGraphFilter(graph, criteria);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    label,
    iterations,
    meanMs: +(sum / iterations).toFixed(4),
    minMs: +samples[0].toFixed(4),
    p50Ms: +samples[Math.floor(iterations * 0.5)].toFixed(4),
    p95Ms: +samples[Math.floor(iterations * 0.95)].toFixed(4),
    maxMs: +samples[iterations - 1].toFixed(4)
  };
}

const graph = makeGraph(NODE_COUNT, CONNECTION_COUNT);
const ITERATIONS = 200;

const results = [
  bench('name query only (hide)', graph, { nameQuery: 'service-1' }, ITERATIONS),
  bench('name query only (dim)', graph, { nameQuery: 'service-1', edgePolicy: 'dim' }, ITERATIONS),
  bench('range only (hide)', graph, { metricKey: 'latency', min: 100, max: 200 }, ITERATIONS),
  bench('name + range combined (hide)', graph, { nameQuery: 'service-9', metricKey: 'rps', min: 100 }, ITERATIONS),
  bench('no match (empty state)', graph, { nameQuery: 'no-such-node' }, ITERATIONS),
  bench('inactive criteria (no-op)', graph, {}, ITERATIONS)
];

let memBefore = null;
let memAfter = null;
if (global.gc) {
  global.gc();
  memBefore = process.memoryUsage().heapUsed;
  const retained = gf.applyGraphFilter(graph, { nameQuery: 'service-1' });
  memAfter = process.memoryUsage().heapUsed;
  if (!retained.counts) { throw new Error('unexpected'); }
  global.gc();
}

const report = {
  config: { nodes: NODE_COUNT, connections: CONNECTION_COUNT, iterations: ITERATIONS, node: process.version },
  results,
  memory: memBefore === null ? 'run with --expose-gc' : {
    heapDeltaBytesPerFilterRun: memAfter - memBefore,
    note: 'one applyGraphFilter result retained; excludes input graph'
  }
};

console.log(JSON.stringify(report, null, 2));
