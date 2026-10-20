import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workflows = ['release.yml', 'pipeline.yml', 'node-release.yml']
  .map((name) => `.github/workflows/${name}`)
  .filter((path) => existsSync(`${root}/${path}`));

function releaseGroups(path) {
  const lines = readFileSync(`${root}/${path}`, 'utf8').split('\n');
  const groups = [];
  lines.forEach((line, i) => {
    const match = /^\s*group:\s*(.+?)\s*$/.exec(line);
    if (match && /^\s*concurrency:\s*$/.test(lines[i - 1] ?? '') && /release/.test(match[1])) {
      groups.push(match[1]);
    }
  });
  return groups;
}

function render(group, ref) {
  return group.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const value = { 'github.ref': ref, 'github.repository': 'ai-ecoverse/consumer' }[expr];
    assert.ok(value, `unexpected expression ${expr} in ${group}`);
    return value;
  });
}

test('release workflows are found', () => {
  assert.ok(workflows.length >= 2, workflows.join(','));
  for (const path of workflows) assert.ok(releaseGroups(path).length > 0, path);
});

test('release concurrency groups are per ref so main and 1.x never cancel each other', () => {
  for (const path of workflows) {
    for (const group of releaseGroups(path)) {
      const main = render(group, 'refs/heads/main');
      const maintenance = render(group, 'refs/heads/1.x');
      assert.notEqual(main, maintenance, `${path}: ${group}`);
    }
  }
});
