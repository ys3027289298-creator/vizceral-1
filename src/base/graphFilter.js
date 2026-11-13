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

/**
 * Pure graph filtering logic. This module is intentionally free of any
 * imports (no lodash, no three.js) so it can be unit tested and benchmarked
 * in plain Node without a DOM or WebGL context.
 *
 * A filter criteria object looks like:
 *   {
 *     nameQuery: 'api',        // optional, case-insensitive substring match
 *     metricKey: 'latency',    // optional, node.metrics[key] or node.metadata[key]
 *     min: 10,                 // optional, inclusive lower bound (requires metricKey)
 *     max: 500,                // optional, inclusive upper bound (requires metricKey)
 *     edgePolicy: 'hide'       // optional, 'hide' (default) or 'dim'
 *   }
 *
 * Edge policies (how connections are treated for NON-matching nodes):
 *   - 'hide': non-matching nodes are removed from the scene. A connection is
 *     visible iff BOTH its source and target nodes match. Connections touching
 *     a filtered-out node are disconnected (hidden), never dangling.
 *   - 'dim': nothing is removed. Non-matching nodes and any connection that
 *     does not have both endpoints matched are greyed out in place. The graph
 *     topology stays fully visible.
 *
 * In both policies the layout is never recomputed: node positions are
 * identical to the unfiltered graph.
 */

const EDGE_POLICIES = Object.freeze({ HIDE: 'hide', DIM: 'dim' });
const DEFAULT_EDGE_POLICY = EDGE_POLICIES.HIDE;

function isFiniteNumber (value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a filter criteria object.
 *
 * @param {object} criteria The criteria to validate
 * @returns {string[]} A list of human readable validation errors. Empty means valid.
 */
function validateCriteria (criteria) {
  const errors = [];
  if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
    return ['criteria must be a plain object'];
  }
  if (criteria.nameQuery !== undefined && typeof criteria.nameQuery !== 'string') {
    errors.push(`nameQuery must be a string, got ${typeof criteria.nameQuery}`);
  }
  if (criteria.edgePolicy !== undefined && criteria.edgePolicy !== EDGE_POLICIES.HIDE && criteria.edgePolicy !== EDGE_POLICIES.DIM) {
    errors.push(`edgePolicy must be '${EDGE_POLICIES.HIDE}' or '${EDGE_POLICIES.DIM}', got '${criteria.edgePolicy}'`);
  }
  const hasMin = criteria.min !== undefined;
  const hasMax = criteria.max !== undefined;
  if (hasMin && !isFiniteNumber(criteria.min)) {
    errors.push(`min must be a finite number, got ${criteria.min}`);
  }
  if (hasMax && !isFiniteNumber(criteria.max)) {
    errors.push(`max must be a finite number, got ${criteria.max}`);
  }
  if ((hasMin || hasMax) && (typeof criteria.metricKey !== 'string' || criteria.metricKey.length === 0)) {
    errors.push('metricKey must be a non-empty string when min or max is set');
  }
  if (criteria.metricKey !== undefined && (typeof criteria.metricKey !== 'string' || criteria.metricKey.length === 0)) {
    errors.push('metricKey must be a non-empty string');
  }
  if (hasMin && hasMax && isFiniteNumber(criteria.min) && isFiniteNumber(criteria.max) && criteria.min > criteria.max) {
    errors.push(`min (${criteria.min}) must not be greater than max (${criteria.max})`);
  }
  return errors;
}

/**
 * Whether a criteria object actually filters anything.
 */
function isCriteriaActive (criteria) {
  if (!criteria) { return false; }
  const hasQuery = typeof criteria.nameQuery === 'string' && criteria.nameQuery.trim().length > 0;
  const hasRange = criteria.min !== undefined || criteria.max !== undefined;
  return hasQuery || hasRange;
}

/**
 * Case-insensitive substring match against a node's name, displayName,
 * metadata.owner and sub-node names. Mirrors the match targets used by
 * TrafficGraph.highlightMatchedNodes.
 */
function matchesName (node, query) {
  const needle = query.toLowerCase();
  const targets = [node.name];
  if (node.displayName) { targets.push(node.displayName); }
  if (node.metadata && node.metadata.owner) { targets.push(node.metadata.owner); }
  if (node.nodes) {
    for (let i = 0; i < node.nodes.length; i++) {
      targets.push(node.nodes[i].name);
    }
  }
  return targets.join().toLowerCase().indexOf(needle) !== -1;
}

/**
 * Read a numeric metric value for a node. Lookup order: node.metrics[key],
 * then node.metadata[key]. Returns undefined when absent or non-numeric.
 */
function getNodeMetricValue (node, key) {
  if (node.metrics && isFiniteNumber(node.metrics[key])) {
    return node.metrics[key];
  }
  if (node.metadata && isFiniteNumber(node.metadata[key])) {
    return node.metadata[key];
  }
  return undefined;
}

/**
 * Inclusive range check. Undefined bounds are open ended.
 */
function inRange (value, min, max) {
  if (!isFiniteNumber(value)) { return false; }
  if (min !== undefined && value < min) { return false; }
  if (max !== undefined && value > max) { return false; }
  return true;
}

/**
 * Apply a filter criteria to plain graph data.
 *
 * @param {object} graph { nodes: [{name, displayName?, metadata?, metrics?, nodes?}],
 *                         connections: [{source, target}] }
 * @param {object} criteria The filter criteria (see module docstring)
 * @returns {object} The filter result:
 *   {
 *     active: boolean,          // whether the criteria filters anything
 *     empty: boolean,           // active and zero matched nodes
 *     edgePolicy: 'hide'|'dim',
 *     matched: string[],        // sorted names of matched nodes
 *     nodes: { [name]: { matched, hidden, dimmed } },
 *     connections: { [name]: { hidden, dimmed } },
 *     counts: { totalNodes, matchedNodes, hiddenNodes, dimmedNodes,
 *               totalConnections, visibleConnections, hiddenConnections, dimmedConnections }
 *   }
 */
function applyGraphFilter (graph, criteria) {
  const errors = validateCriteria(criteria);
  if (errors.length > 0) {
    throw new TypeError(`Invalid graph filter criteria: ${errors.join('; ')}`);
  }

  const edgePolicy = criteria.edgePolicy || DEFAULT_EDGE_POLICY;
  const active = isCriteriaActive(criteria);
  const hasQuery = active && typeof criteria.nameQuery === 'string' && criteria.nameQuery.trim().length > 0;
  const hasRange = active && (criteria.min !== undefined || criteria.max !== undefined);
  const query = hasQuery ? criteria.nameQuery.trim() : undefined;

  const nodes = {};
  const matched = [];
  let hiddenNodes = 0;
  let dimmedNodes = 0;

  const graphNodes = (graph && graph.nodes) || [];
  for (let i = 0; i < graphNodes.length; i++) {
    const node = graphNodes[i];
    let isMatch = true;
    if (active) {
      if (hasQuery && !matchesName(node, query)) { isMatch = false; }
      if (isMatch && hasRange && !inRange(getNodeMetricValue(node, criteria.metricKey), criteria.min, criteria.max)) {
        isMatch = false;
      }
    }
    const hidden = active && !isMatch && edgePolicy === EDGE_POLICIES.HIDE;
    const dimmed = active && !isMatch && edgePolicy === EDGE_POLICIES.DIM;
    if (isMatch) { matched.push(node.name); }
    if (hidden) { hiddenNodes++; }
    if (dimmed) { dimmedNodes++; }
    nodes[node.name] = { matched: isMatch, hidden, dimmed };
  }

  const connections = {};
  let visibleConnections = 0;
  let hiddenConnections = 0;
  let dimmedConnections = 0;
  const graphConnections = (graph && graph.connections) || [];
  for (let i = 0; i < graphConnections.length; i++) {
    const connection = graphConnections[i];
    const name = `${connection.source}--${connection.target}`;
    const sourceState = nodes[connection.source];
    const targetState = nodes[connection.target];
    const bothMatched = !!(sourceState && targetState && sourceState.matched && targetState.matched);
    const hidden = active && !bothMatched && edgePolicy === EDGE_POLICIES.HIDE;
    const dimmed = active && !bothMatched && edgePolicy === EDGE_POLICIES.DIM;
    if (hidden) { hiddenConnections++; } else if (dimmed) { dimmedConnections++; } else { visibleConnections++; }
    connections[name] = { hidden, dimmed };
  }

  matched.sort();

  return {
    active,
    empty: active && matched.length === 0,
    edgePolicy,
    matched,
    nodes,
    connections,
    counts: {
      totalNodes: graphNodes.length,
      matchedNodes: matched.length,
      hiddenNodes,
      dimmedNodes,
      totalConnections: graphConnections.length,
      visibleConnections,
      hiddenConnections,
      dimmedConnections
    }
  };
}

export {
  EDGE_POLICIES,
  DEFAULT_EDGE_POLICY,
  validateCriteria,
  isCriteriaActive,
  matchesName,
  getNodeMetricValue,
  inRange,
  applyGraphFilter
};
