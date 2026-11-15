const fs = require('fs');
const path = require('path');
const {
  assert, approx, createVizceral, nodeScreenPosition, hitAtScreen,
  screenToViewport, readAllPixels, readPixel, renderFrames, dispatchMouse,
  VIEW_WIDTH, VIEW_HEIGHT
} = require('./lib');

const OUT_DIR = path.resolve(__dirname, '..', 'artifacts');
const label = process.env.VIZCERAL_LABEL || 'after';

console.log(`== Behavior snapshot (${label}) ==`);

function snapshot () {
  const v = createVizceral();
  renderFrames(v, 10);
  const result = {
    label,
    viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
    camera: {
      zoom: v.camera.zoom,
      position: { x: v.camera.position.x, y: v.camera.position.y, z: v.camera.position.z },
      frustum: {
        left: v.camera.left, right: v.camera.right, top: v.camera.top, bottom: v.camera.bottom
      }
    },
    nodes: {},
    picks: {},
    pixels: {}
  };

  const interactiveNames = [];
  Object.values(v.currentGraph.nodes).forEach((node) => {
    const name = node.getName();
    const screen = nodeScreenPosition(v, name);
    result.nodes[name] = {
      world: { x: node.position.x, y: node.position.y },
      screen: { x: Number(screen.x.toFixed(6)), y: Number(screen.y.toFixed(6)) },
      interactive: node.isInteractive(),
      clickable: node.isClickable(),
      draggable: node.isDraggable()
    };
    if (node.isInteractive() && screen.x >= 0 && screen.x <= VIEW_WIDTH && screen.y >= 0 && screen.y <= VIEW_HEIGHT) {
      interactiveNames.push(name);
    }
  });

  // Fixed screen probes: every probe point is evaluated identically in both runs.
  const probes = [
    { name: 'topleft', x: 40, y: 40 },
    { name: 'center', x: VIEW_WIDTH / 2, y: VIEW_HEIGHT / 2 },
    { name: 'bottomright', x: VIEW_WIDTH - 40, y: VIEW_HEIGHT - 40 },
    ...interactiveNames.map(name => ({ name: `node:${name}`, ...nodeScreenPosition(v, name) }))
  ];
  probes.forEach((probe) => {
    result.picks[probe.name] = hitAtScreen(v, probe.x, probe.y);
  });

  // Pixel evidence: full deterministic frame hash plus selected probe pixels.
  const allPixels = readAllPixels(v);
  result.pixels.hash = fnv1aHex(allPixels);
  result.pixels.nonEmptyPixels = countNonBackgroundPixels(allPixels);
  ['center', 'topleft', 'bottomright'].forEach((probeName) => {
    const probe = probes.find(item => item.name === probeName);
    result.pixels[probeName] = readPixel(v, probe.x, probe.y);
  });
  result.pixels.nodeSamples = {};
  interactiveNames.forEach((name) => {
    const screen = nodeScreenPosition(v, name);
    result.pixels.nodeSamples[name] = readPixel(v, screen.x, screen.y);
  });

  return result;
}

function fnv1aHex (buffer) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i++) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function countNonBackgroundPixels (buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    // Clear color is (45,45,45); anything else counts as drawn content.
    if (!(buffer[i] === 45 && buffer[i + 1] === 45 && buffer[i + 2] === 45 && buffer[i + 3] === 255)) {
      count += 1;
    }
  }
  return count;
}

const snapshotData = snapshot();
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `snapshot-${label}.json`);
fs.writeFileSync(outFile, `${JSON.stringify(snapshotData, null, 2)}\n`);
console.log(`snapshot written: ${path.relative(path.resolve(__dirname, '..'), outFile)}`);
console.log('pixel hash:', snapshotData.pixels.hash, 'non-background px:', snapshotData.pixels.nonEmptyPixels);
console.log('picks:', JSON.stringify(snapshotData.picks));

// If a baseline snapshot exists alongside, diff it directly.
const baselineFile = path.join(OUT_DIR, 'snapshot-before.json');
if (label === 'after' && fs.existsSync(baselineFile)) {
  const before = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  let failures = 0;
  const compare = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
      failures += 1;
      console.log(`  DIFF  ${name}\n        before=${e}\n        after =${a}`);
    } else {
      console.log(`  SAME  ${name}`);
    }
  };
  console.log('== Before/after comparison (same input data, same viewport) ==');
  compare('camera defaults', snapshotData.camera, before.camera);
  compare('node layout & flags', snapshotData.nodes, before.nodes);
  compare('all hit-test probes', snapshotData.picks, before.picks);
  compare('full-frame pixel hash', snapshotData.pixels.hash, before.pixels.hash);
  compare('non-background pixel count', snapshotData.pixels.nonEmptyPixels, before.pixels.nonEmptyPixels);
  compare('probe pixels', {
    center: snapshotData.pixels.center, topleft: snapshotData.pixels.topleft,
    bottomright: snapshotData.pixels.bottomright, nodeSamples: snapshotData.pixels.nodeSamples
  }, {
    center: before.pixels.center, topleft: before.pixels.topleft,
    bottomright: before.pixels.bottomright, nodeSamples: before.pixels.nodeSamples
  });
  if (failures > 0) {
    console.log(`PARITY FAILED (${failures} differing field(s))`);
    process.exitCode = 1;
  } else {
    console.log('PARITY VERIFIED: before/after outputs are bit-identical');
  }
}
