// Snapshots the output coordinates of the ORIGINAL layouts (ring, ringCenter, ltrTree)
// for a fixed input graph. Run against a git worktree of HEAD (pre-change) and against
// the working tree (post-change); byte-compare the two JSON outputs to prove the old
// behavior is bit-for-bit identical.
//
// Usage:
//   TARGET_ROOT=/path/to/repo node_modules/.bin/babel-node test/layout/snapshotOldLayouts.js > out.json
import path from 'path';
import { buildGraph } from './graphFactory';

const TARGET_ROOT = process.env.TARGET_ROOT || process.cwd();
const DIMENSIONS = { width: 1600, height: 1200 };

const RingLayout = require(path.join(TARGET_ROOT, 'src/layouts/ringLayout')).default;
const RingCenterLayout = require(path.join(TARGET_ROOT, 'src/layouts/ringCenterLayout')).default;
const LTRTreeLayouter = require(path.join(TARGET_ROOT, 'src/layouts/ltrTreeLayout/ltrTreeLayouter'));

function snapshot (LayoutClass, nodeCount) {
  const graph = buildGraph(nodeCount);
  new LayoutClass().run(graph, DIMENSIONS, () => {});
  return graph.nodes.map(n => [n.name, n.position.x, n.position.y]);
}

function snapshotLTRTree (nodeCount) {
  const graph = buildGraph(nodeCount);
  const data = {
    graph: {
      nodes: graph.nodes.map(n => ({ name: n.name, position: n.position, size: n.size, weight: undefined, metadata: n.metadata })),
      edges: graph.connections.map(c => ({ source: c.source.name, target: c.target.name }))
    },
    dimensions: DIMENSIONS,
    entryNode: undefined,
    options: undefined
  };
  const positions = new LTRTreeLayouter().layout(data);
  // Mirror the worker's center-origin adjustment (ltrTreeLayoutWorker.js)
  const halfWidth = DIMENSIONS.width / 2;
  const halfHeight = DIMENSIONS.height / 2;
  return Object.keys(positions).sort().map(name => [name, positions[name].x - halfWidth, positions[name].y - halfHeight]);
}

const result = {
  ring: snapshot(RingLayout, 200),
  ringCenter: snapshot(RingCenterLayout, 200),
  ltrTree: snapshotLTRTree(200)
};
console.log(JSON.stringify(result));
