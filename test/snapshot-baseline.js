/**
 * Extracts the pre-change (HEAD) version of ./src into test/baseline-src so the
 * webpack test config can build the baseline bundle for before/after comparison.
 * Uses `git archive`, so uncommitted feature work is excluded by construction.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.resolve(__dirname, 'baseline-src');

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

const tar = execFileSync('git', ['archive', 'HEAD', 'src'], { cwd: ROOT });
execFileSync('tar', ['-x', '-C', TARGET, '--strip-components=1'], { input: tar });

const files = execFileSync('find', [TARGET, '-type', 'f'], { encoding: 'utf8' })
  .trim().split('\n');
console.log(`Baseline snapshot written to ${TARGET} (${files.length} files from git HEAD:src)`);
