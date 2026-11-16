/* Pure-string structural validation of the exported SVG files on disk.
 * No DOM, no browser: re-parses the artifacts with regex/string ops and
 * verifies element counts and that every <path> is closed (M count == Z
 * count and the data ends with Z). Writes structure-validation.json. */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(__dirname, '..', 'artifacts', 'svg-export');
const FILES = ['small-graph.svg', 'large-graph-1000.svg'];

function countTag (text, tag) {
  const matches = text.match(new RegExp(`<${tag}\\b`, 'g'));
  return matches ? matches.length : 0;
}

function checkFile (filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const errors = [];
  const counts = {
    svg: countTag(text, 'svg'),
    path: countTag(text, 'path'),
    polyline: countTag(text, 'polyline'),
    line: countTag(text, 'line'),
    circle: countTag(text, 'circle'),
    rect: countTag(text, 'rect'),
    text: countTag(text, 'text'),
    image: countTag(text, 'image'),
    title: countTag(text, 'title')
  };

  if (!text.startsWith('<?xml')) { errors.push('missing XML header'); }
  if (counts.svg !== 1) { errors.push(`expected exactly 1 svg root, found ${counts.svg}`); }
  if (!/viewBox="[^"]+"/.test(text)) { errors.push('missing viewBox'); }

  const pathElements = text.match(/<path\b[^>]*\bd="[^"]*"[^>]*>/g) || [];
  let closedPaths = 0;
  let openPaths = 0;
  const openPathDetails = [];
  pathElements.forEach((element, index) => {
    const data = (element.match(/\bd="([^"]*)"/) || [])[1] || '';
    const moveCount = (data.match(/M/g) || []).length;
    const closeCount = (data.match(/Z/g) || []).length;
    if (moveCount > 0 && moveCount === closeCount && /Z$/.test(data.trim())) {
      closedPaths++;
    } else {
      openPaths++;
      if (openPathDetails.length < 10) {
        openPathDetails.push({ index, moveCount, closeCount, tail: data.slice(-24) });
      }
    }
  });
  if (openPaths > 0) { errors.push(`${openPaths} open or malformed paths`); }

  return {
    file: path.relative(path.resolve(__dirname, '..'), filePath),
    bytes: Buffer.byteLength(text),
    valid: errors.length === 0,
    errors,
    elementCounts: counts,
    closedPaths,
    openPaths,
    openPathDetails
  };
}

function main () {
  const results = FILES
    .map(name => path.join(OUT_DIR, name))
    .filter(filePath => fs.existsSync(filePath))
    .map(checkFile);
  const report = {
    generatedAt: new Date().toISOString(),
    validator: 'test/structureCheck.js (pure string parse, no DOM)',
    results,
    ok: results.length === FILES.length && results.every(r => r.valid)
  };
  fs.writeFileSync(path.join(OUT_DIR, 'structure-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

main();
