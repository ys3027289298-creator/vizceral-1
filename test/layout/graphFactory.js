// Deterministic mock graph factory for headless layout checks.
// Builds the exact same graph on every run (no Math.random, no Date).

function mulberry32 (seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MockNode {
  constructor (name, size) {
    this.type = 'node';
    this.name = name;
    this.size = size;
    this.position = { x: 0, y: 0 };
    this.metadata = undefined;
  }

  getName () {
    return this.name;
  }

  isEntryNode () {
    return this.name === 'node-000';
  }

  updatePosition (position) {
    this.position.x = position.x;
    this.position.y = position.y;
  }
}

// 200 nodes, region-renderer default size (60), ~420 deterministic edges.
function buildGraph (nodeCount, seed) {
  const random = mulberry32(seed === undefined ? 1234 : seed);
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const name = `node-${String(i).padStart(3, '0')}`;
    nodes.push(new MockNode(name, 60));
  }
  const connections = [];
  const seen = {};
  const addEdge = (a, b) => {
    if (a === b) { return; }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen[key]) { return; }
    seen[key] = true;
    connections.push({ source: nodes[a], target: nodes[b] });
  };
  // Backbone so the graph is mostly connected
  for (let i = 1; i < nodeCount; i++) {
    addEdge(Math.floor(random() * i), i);
  }
  // Extra deterministic chords
  for (let i = 0; i < nodeCount; i++) {
    addEdge(i, (i * 7 + 13) % nodeCount);
    if (i % 5 === 0) {
      addEdge(i, (i * 31 + 7) % nodeCount);
    }
  }
  return { nodes, connections, options: undefined, entryNode: undefined };
}

module.exports = { buildGraph, MockNode };
