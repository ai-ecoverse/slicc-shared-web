import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workflows = ['release.yml', 'pipeline.yml', 'node-release.yml']
  .map((name) => `.github/workflows/${name}`)
  .filter((path) => existsSync(`${root}/${path}`));

function releaseConcurrency(path) {
  const lines = readFileSync(`${root}/${path}`, 'utf8').split('\n');
  const blocks = [];
  lines.forEach((line, i) => {
    const group = /^\s*group:\s*(.+?)\s*$/.exec(line);
    if (group && /^\s*concurrency:\s*$/.test(lines[i - 1] ?? '') && /release/.test(group[1])) {
      const cancel = /^\s*cancel-in-progress:\s*(\S+)\s*$/.exec(lines[i + 1] ?? '');
      blocks.push({ group: group[1], cancel: cancel?.[1] });
    }
  });
  return blocks;
}

function render(group, ref) {
  const context = {
    'github.ref': `refs/heads/${ref}`,
    'github.ref_name': ref,
    'github.repository': 'ai-ecoverse/consumer',
  };
  return group.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    assert.ok(context[expr], `unexpected expression ${expr} in ${group}`);
    return context[expr];
  });
}

test('release workflows are found', () => {
  assert.ok(workflows.length >= 2, workflows.join(','));
  for (const path of workflows) assert.ok(releaseConcurrency(path).length > 0, path);
});

test('release concurrency groups are per branch so main and 1.x never cancel each other', () => {
  for (const path of workflows) {
    for (const { group } of releaseConcurrency(path)) {
      assert.notEqual(render(group, 'main'), render(group, '1.x'), `${path}: ${group}`);
    }
  }
});

test('a release in progress is never cancelled', () => {
  for (const path of workflows) {
    for (const { group, cancel } of releaseConcurrency(path)) {
      assert.equal(cancel, 'false', `${path}: ${group}`);
    }
  }
});

function callerCancel(text) {
  if (!/uses:\s*\S*\.github\/workflows\/pipeline\.yml/.test(text)) return [];
  const match = /^concurrency:\n {2}group:.*\n {2}cancel-in-progress:\s*(.+?)\s*$/m.exec(text);
  return [match ? match[1] : 'false'];
}

function cancelsOn(cancel, event) {
  if (cancel === 'true' || cancel === 'false') return cancel === 'true';
  const expr = /^\$\{\{\s*github\.event_name\s*==\s*'([a-z_]+)'\s*\}\}$/.exec(cancel);
  assert.ok(expr, `unexpected cancel-in-progress ${cancel}`);
  return expr[1] === event;
}

test('a pipeline.yml caller never cancels a push to main, only superseded pull requests', () => {
  const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');
  const readme = readFileSync(`${root}/README.md`, 'utf8');
  const snippets = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const callers = [ci, ...snippets].flatMap(callerCancel);
  assert.ok(callers.length >= 2, String(callers.length));
  for (const cancel of callers) {
    assert.equal(cancelsOn(cancel, 'push'), false, cancel);
    assert.equal(cancelsOn(cancel, 'merge_group'), false, cancel);
    assert.equal(cancelsOn(cancel, 'pull_request'), true, cancel);
  }
});
