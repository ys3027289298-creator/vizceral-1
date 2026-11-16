/* Deterministic sample traffic data for SVG export validation. */
function makeSmallGraph () {
  return {
    name: 'edge',
    renderer: 'region',
    maxVolume: 600,
    nodes: [
      {
        name: 'api-gateway',
        displayName: 'api-gateway',
        class: 'normal',
        nodes: [],
        connections: []
      },
      {
        name: 'auth-service',
        displayName: 'auth-service',
        class: 'warning',
        nodes: [],
        connections: []
      },
      {
        name: 'billing-service',
        displayName: 'billing-service',
        class: 'danger',
        nodes: [],
        connections: []
      },
      {
        name: 'cache-layer',
        displayName: 'cache-layer',
        class: 'normal',
        node_type: 'storage',
        nodes: [],
        connections: []
      }
    ],
    connections: [
      { source: 'api-gateway', target: 'auth-service', metrics: { normal: 420, warning: 30, danger: 4 } },
      { source: 'api-gateway', target: 'billing-service', metrics: { normal: 260, danger: 12 } },
      { source: 'auth-service', target: 'cache-layer', metrics: { normal: 380 } }
    ]
  };
}

function makeLargeGraph (nodeCount) {
  const nodes = [];
  const connections = [];
  for (let i = 0; i < nodeCount; i++) {
    let classValue = 'normal';
    if (i % 37 === 0) {
      classValue = 'danger';
    } else if (i % 11 === 0) {
      classValue = 'warning';
    }
    nodes.push({
      name: `node-${i}`,
      displayName: `node-${i}`,
      class: classValue,
      nodes: [],
      connections: []
    });
    if (i > 0) {
      const source = Math.floor(i / 2);
      connections.push({
        source: `node-${source}`,
        target: `node-${i}`,
        metrics: { normal: 100 + (i % 50) }
      });
    }
  }
  return {
    name: 'large-edge',
    renderer: 'region',
    maxVolume: 200,
    nodes,
    connections
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeSmallGraph, makeLargeGraph };
}
