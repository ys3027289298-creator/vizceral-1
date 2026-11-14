/**
 *
 *  Copyright 2016 Netflix, Inc.
 *
 *     Licensed under the Apache License, Version 2.0 (the "License");
 *     you may not use this file except in compliance with the License.
 *     You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 *
 */
import { each } from 'lodash';

const Console = console;

const DEFAULT_OPTIONS = {
  repulsion: 22500, // pair-wise repulsion constant (force = repulsion / distance); defaults to springLength^2
  springLength: 150, // ideal resting length of an edge
  springConstant: 1, // spring stiffness multiplier (force = springConstant * distance^2 / springLength)
  gravity: 0.05, // pull towards the canvas center, keeps disconnected components bounded
  initialTemperature: 150, // cap on a single node move in the first iteration
  cooling: 0.98, // geometric temperature decay per iteration (0, 1); guarantees convergence
  maxIterations: 1000, // hard upper bound on iterations; bounds total work to O(maxIterations * n^2)
  convergenceThreshold: 0.5, // converged when max node displacement in an iteration drops below this
  seed: 0x2f6e2b1, // PRNG seed for initial positions; fixed seed => reproducible layouts
  nodeRadius: 30 // fallback radius (for overlap detection) when a node has no size
};

// Deterministic PRNG (mulberry32). Same seed => same sequence => same layout.
function mulberry32 (seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a += 0x6D2B79F5;
    a |= 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nodeName (node) {
  return typeof node.getName === 'function' ? node.getName() : node.name;
}

function nodeRadius (node, fallback) {
  return (node.size ? node.size / 2 : fallback);
}

function finiteNumber (value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateOptions (options) {
  const errors = [];
  const positive = ['repulsion', 'springLength', 'springConstant', 'gravity', 'initialTemperature', 'convergenceThreshold', 'nodeRadius'];
  each(positive, (key) => {
    if (!finiteNumber(options[key]) || options[key] <= 0) {
      errors.push(`${key} must be a finite number > 0, got: ${options[key]}`);
    }
  });
  if (!finiteNumber(options.cooling) || options.cooling <= 0 || options.cooling >= 1) {
    errors.push(`cooling must be a finite number in (0, 1), got: ${options.cooling}`);
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
    errors.push(`maxIterations must be an integer >= 1, got: ${options.maxIterations}`);
  }
  if (!Number.isInteger(options.seed)) {
    errors.push(`seed must be an integer, got: ${options.seed}`);
  }
  if (errors.length > 0) {
    throw new Error(`ForceDirectedLayout: invalid options - ${errors.join('; ')}`);
  }
}

function pinnedPosition (node) {
  if (node.userPositioned && node.userPosition
    && finiteNumber(node.userPosition.x) && finiteNumber(node.userPosition.y)) {
    return { x: node.userPosition.x, y: node.userPosition.y };
  }
  const metadataPosition = node.metadata && node.metadata.position;
  if (metadataPosition && finiteNumber(metadataPosition.x) && finiteNumber(metadataPosition.y)) {
    return { x: metadataPosition.x, y: metadataPosition.y };
  }
  return undefined;
}

class ForceDirectedLayout {
  constructor () {
    // Stats of the most recent run; convergenceCurve[i] is the max node movement applied in
    // iteration i, rawDisplacementCurve[i] is the uncapped max force magnitude of iteration i.
    this.lastRunStats = null;
  }

  getConvergenceCurve () {
    return this.lastRunStats ? this.lastRunStats.convergenceCurve.slice() : [];
  }

  countOverlapPairs (nodes, positions, options) {
    let overlapPairs = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const minDistance = nodeRadius(nodes[i], options.nodeRadius) + nodeRadius(nodes[j], options.nodeRadius);
        if ((dx * dx) + (dy * dy) < minDistance * minDistance) {
          overlapPairs++;
        }
      }
    }
    return overlapPairs;
  }

  run (graph, dimensions, layoutComplete) {
    const options = Object.assign({}, DEFAULT_OPTIONS, (graph.options && graph.options.forceDirected) || {});
    validateOptions(options);

    const nodes = graph.nodes || [];
    const connections = graph.connections || [];

    if (nodes.length === 0) {
      this.lastRunStats = {
        nodeCount: 0, connectionCount: 0, iterations: 0, converged: true, convergenceCurve: [], overlapPairs: 0, parameters: options
      };
      layoutComplete();
      return;
    }

    const halfWidth = dimensions.width * 0.5;
    const halfHeight = dimensions.height * 0.5;

    // Deterministic initial placement: fixed seed + input node order, no Math.random().
    const random = mulberry32(options.seed);
    const positions = new Array(nodes.length);
    const pinned = new Array(nodes.length);
    const indexByName = {};
    for (let i = 0; i < nodes.length; i++) {
      indexByName[nodeName(nodes[i])] = i;
      const fixed = pinnedPosition(nodes[i]);
      if (fixed) {
        pinned[i] = true;
        positions[i] = { x: fixed.x, y: fixed.y };
      } else {
        pinned[i] = false;
        positions[i] = {
          x: (random() * 2 - 1) * halfWidth,
          y: (random() * 2 - 1) * halfHeight
        };
      }
    }

    const edges = [];
    each(connections, (connection) => {
      const sourceIndex = indexByName[nodeName(connection.source)];
      const targetIndex = indexByName[nodeName(connection.target)];
      if (sourceIndex !== undefined && targetIndex !== undefined && sourceIndex !== targetIndex) {
        edges.push([sourceIndex, targetIndex]);
      }
    });

    const forceX = new Float64Array(nodes.length);
    const forceY = new Float64Array(nodes.length);
    const convergenceCurve = [];
    const rawDisplacementCurve = [];
    let converged = false;
    let iterations = 0;
    let temperature = options.initialTemperature;

    for (iterations = 0; iterations < options.maxIterations; iterations++) {
      forceX.fill(0);
      forceY.fill(0);

      // Pair-wise repulsion, O(n^2)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = positions[j].x - positions[i].x;
          let dy = positions[j].y - positions[i].y;
          let distanceSquared = (dx * dx) + (dy * dy);
          if (distanceSquared === 0) {
            // Perfectly overlapping nodes would divide by zero; nudge deterministically.
            dx = (i - j) || 1;
            dy = 1;
            distanceSquared = (dx * dx) + (dy * dy);
          }
          const distance = Math.sqrt(distanceSquared);
          const force = options.repulsion / distance;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          forceX[i] -= fx;
          forceY[i] -= fy;
          forceX[j] += fx;
          forceY[j] += fy;
        }
      }

      // Springs along edges, O(e)
      for (let e = 0; e < edges.length; e++) {
        const i = edges[e][0];
        const j = edges[e][1];
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const distance = Math.sqrt((dx * dx) + (dy * dy)) || 1;
        const force = (options.springConstant * distance * distance) / options.springLength;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        forceX[i] += fx;
        forceY[i] += fy;
        forceX[j] -= fx;
        forceY[j] -= fy;
      }

      // Center gravity + displacement capped by the (cooling) temperature, O(n)
      let maxDisplacement = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (!pinned[i]) {
          forceX[i] -= positions[i].x * options.gravity;
          forceY[i] -= positions[i].y * options.gravity;
          const displacement = Math.sqrt((forceX[i] * forceX[i]) + (forceY[i] * forceY[i]));
          const capped = Math.min(displacement, temperature) / (displacement || 1);
          positions[i].x += forceX[i] * capped;
          positions[i].y += forceY[i] * capped;
          if (displacement > maxDisplacement) {
            maxDisplacement = displacement;
          }
        }
      }

      const applied = Math.min(maxDisplacement, temperature);
      convergenceCurve.push(applied);
      rawDisplacementCurve.push(maxDisplacement);
      temperature *= options.cooling;
      if (applied < options.convergenceThreshold) {
        converged = true;
        iterations++;
        break;
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      nodes[i].updatePosition({ x: positions[i].x, y: positions[i].y });
    }

    const overlapPairs = this.countOverlapPairs(nodes, positions, options);
    this.lastRunStats = {
      nodeCount: nodes.length,
      connectionCount: edges.length,
      iterations,
      converged,
      convergenceCurve,
      rawDisplacementCurve,
      overlapPairs,
      parameters: options
    };

    if (!converged) {
      Console.warn(`ForceDirectedLayout: did not converge within ${options.maxIterations} iterations (last max displacement: ${convergenceCurve[convergenceCurve.length - 1]}). Returning best-effort positions.`);
    }

    layoutComplete();
  }
}

export default ForceDirectedLayout;
