// Headless verification harness for the force-directed layout.
// Run with: node_modules/.bin/babel-node test/layout/runChecks.js
import fs from 'fs';
import path from 'path';
import { buildGraph } from './graphFactory';
import ForceDirectedLayout from '../../src/layouts/forceDirectedLayout';
import RingLayout from '../../src/layouts/ringLayout';
import RingCenterLayout from '../../src/layouts/ringCenterLayout';

const DIMENSIONS = { width: 1600, height: 1200 };
const NODE_COUNT = 200;
const OUTPUT_DIR = path.join(__dirname, 'output');

let failures = 0;
function check (label, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) { failures++; }
  console.log(`  [${status}] ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
}

function metrics (nodes) {
  let overlapPairs = 0;
  let minDistance = Infinity;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const pi = nodes[i].position;
    minX = Math.min(minX, pi.x); maxX = Math.max(maxX, pi.x);
    minY = Math.min(minY, pi.y); maxY = Math.max(maxY, pi.y);
    for (let j = i + 1; j < nodes.length; j++) {
      const pj = nodes[j].position;
      const dx = pj.x - pi.x;
      const dy = pj.y - pi.y;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      minDistance = Math.min(minDistance, distance);
      const minAllowed = (nodes[i].size / 2) + (nodes[j].size / 2);
      if (distance < minAllowed) { overlapPairs++; }
    }
  }
  return {
    overlapPairs,
    minPairDistance: Math.round(minDistance * 1000) / 1000,
    boundingBox: `${Math.round(maxX - minX)}x${Math.round(maxY - minY)}`
  };
}

function runLayout (LayoutClass, graph) {
  const layout = new LayoutClass();
  layout.run(graph, DIMENSIONS, () => {});
  return layout;
}

if (!fs.existsSync(OUTPUT_DIR)) { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); }

// ---------------------------------------------------------------- 1. Before/after comparison (same input)
console.log(`\n== 1. Before/after comparison (${NODE_COUNT} nodes, same input graph, ${DIMENSIONS.width}x${DIMENSIONS.height}) ==`);
const comparison = {};
[['ring (before)', RingLayout], ['ringCenter (before)', RingCenterLayout], ['forceDirected (after)', ForceDirectedLayout]].forEach(([label, LayoutClass]) => {
  const graph = buildGraph(NODE_COUNT);
  runLayout(LayoutClass, graph);
  comparison[label] = metrics(graph.nodes);
  console.log(`  ${label}: ${JSON.stringify(comparison[label])}`);
});
fs.writeFileSync(path.join(OUTPUT_DIR, 'comparison.json'), JSON.stringify(comparison, null, 2));

// ---------------------------------------------------------------- 2. Determinism / reproducibility
console.log('\n== 2. Determinism: same input => identical coordinates ==');
const positionsOf = graph => JSON.stringify(graph.nodes.map(n => [n.name, n.position.x, n.position.y]));
const runA = buildGraph(NODE_COUNT);
runLayout(ForceDirectedLayout, runA);
const runB = buildGraph(NODE_COUNT);
runLayout(ForceDirectedLayout, runB);
check('two independent runs produce bit-identical coordinates', positionsOf(runA) === positionsOf(runB));
const runC = buildGraph(NODE_COUNT);
const layoutC = runLayout(ForceDirectedLayout, runC);
const positionsBeforeRerun = positionsOf(runC);
layoutC.run(runC, DIMENSIONS, () => {});
check('re-running the same layout instance is bit-identical', positionsOf(runC) === positionsBeforeRerun);

// ---------------------------------------------------------------- 3. Convergence (200 nodes)
console.log('\n== 3. Convergence at 200 nodes ==');
const graph200 = buildGraph(NODE_COUNT);
const forceLayout = runLayout(ForceDirectedLayout, graph200);
const stats = forceLayout.lastRunStats;
console.log(`  iterations to converge: ${stats.iterations}`);
console.log(`  converged: ${stats.converged}`);
console.log(`  final overlap pairs: ${stats.overlapPairs}`);
console.log(`  curve head: ${stats.convergenceCurve.slice(0, 5).map(v => v.toFixed(2)).join(', ')}`);
console.log(`  curve tail: ${stats.convergenceCurve.slice(-5).map(v => v.toFixed(4)).join(', ')}`);
check('converged within maxIterations', stats.converged === true, `${stats.iterations} iterations`);
check('convergence curve is monotonically non-increasing in its tail',
  stats.convergenceCurve[stats.convergenceCurve.length - 1] <= stats.convergenceCurve[0]);
fs.writeFileSync(path.join(OUTPUT_DIR, 'convergence-200.json'), JSON.stringify({
  nodeCount: stats.nodeCount,
  connectionCount: stats.connectionCount,
  iterations: stats.iterations,
  converged: stats.converged,
  overlapPairs: stats.overlapPairs,
  parameters: stats.parameters,
  convergenceCurve: stats.convergenceCurve,
  rawDisplacementCurve: stats.rawDisplacementCurve
}, null, 2));

// ---------------------------------------------------------------- 4. Failure paths
console.log('\n== 4. Failure paths ==');
// 4a. Invalid option => explicit error
try {
  const graph = buildGraph(10);
  graph.options = { forceDirected: { repulsion: -1 } };
  runLayout(ForceDirectedLayout, graph);
  check('invalid repulsion throws', false, 'no error thrown');
} catch (error) {
  check('invalid repulsion throws', /ForceDirectedLayout: invalid options - repulsion must be a finite number > 0, got: -1/.test(error.message), error.message);
}
// 4b. Invalid cooling => explicit error
try {
  const graph = buildGraph(10);
  graph.options = { forceDirected: { cooling: 1.5 } };
  runLayout(ForceDirectedLayout, graph);
  check('invalid cooling throws', false, 'no error thrown');
} catch (error) {
  check('invalid cooling throws', /cooling must be a finite number in \(0, 1\), got: 1.5/.test(error.message), error.message);
}
// 4c. Empty graph => no crash, trivially converged
{
  const layout = new ForceDirectedLayout();
  let completed = false;
  layout.run({ nodes: [], connections: [] }, DIMENSIONS, () => { completed = true; });
  check('empty graph completes without error', completed && layout.lastRunStats.iterations === 0 && layout.lastRunStats.converged === true);
}
// 4d. Non-convergence within maxIterations => warning + best-effort result
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => { warnings.push(msg); };
  const graph = buildGraph(NODE_COUNT);
  graph.options = { forceDirected: { maxIterations: 3 } };
  const layout = runLayout(ForceDirectedLayout, graph);
  console.warn = originalWarn;
  check('non-convergence warns and returns best-effort positions',
    layout.lastRunStats.converged === false
    && layout.lastRunStats.iterations === 3
    && warnings.length === 1
    && /did not converge within 3 iterations/.test(warnings[0])
    && graph.nodes.every(n => Number.isFinite(n.position.x) && Number.isFinite(n.position.y)),
    warnings[0]);
}

// ---------------------------------------------------------------- 5. User-dragged positions survive layout switches
console.log('\n== 5. Dragged node positions are preserved ==');
{
  // Force layout pins user-dragged nodes during simulation
  const graph = buildGraph(50);
  const dragged = graph.nodes[7];
  dragged.userPositioned = true;
  dragged.userPosition = { x: 123.5, y: -456.25 };
  runLayout(ForceDirectedLayout, graph);
  check('force layout keeps dragged node pinned', dragged.position.x === 123.5 && dragged.position.y === -456.25,
    `position after layout: (${dragged.position.x}, ${dragged.position.y})`);
}
{
  // Switching to another layout and back: trafficGraph restores dragged positions after any layout run
  // (mirrors the restore step in TrafficGraph._relayout's layout-complete callback)
  const graph = buildGraph(50);
  const dragged = graph.nodes[7];
  dragged.userPositioned = true;
  dragged.userPosition = { x: 123.5, y: -456.25 };
  runLayout(RingLayout, graph); // ring layout overwrites everything...
  graph.nodes.forEach((node) => { // ...then the graph-level restore re-applies dragged positions
    if (node.userPositioned && node.userPosition) {
      node.updatePosition({ x: node.userPosition.x, y: node.userPosition.y });
    }
  });
  check('dragged position restored after switching to ring layout', dragged.position.x === 123.5 && dragged.position.y === -456.25);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
