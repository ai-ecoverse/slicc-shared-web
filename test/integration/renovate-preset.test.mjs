import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const preset = JSON.parse(readFileSync(new URL('../../default.json', import.meta.url), 'utf8'));
const names = ['@ai-ecoverse/slicc-shared-web', 'ai-ecoverse/slicc-shared-web'];

function enabled(packageName, updateType) {
  let result = true;
  for (const rule of preset.packageRules) {
    if (!('enabled' in rule)) continue;
    if (!rule.matchPackageNames?.includes(packageName)) continue;
    if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(updateType)) continue;
    result = rule.enabled;
  }
  return result;
}

test('slicc-shared-web majors are never offered, as the npm package or as the workflow ref', () => {
  for (const name of names) assert.equal(enabled(name, 'major'), false, name);
});

test('slicc-shared-web minors and patches still update', () => {
  for (const name of names) {
    for (const updateType of ['minor', 'patch'])
      assert.equal(enabled(name, updateType), true, `${name} ${updateType}`);
  }
});

test('the rule disables only majors and is not an allowedVersions cap', () => {
  const rule = preset.packageRules.find(
    (r) => r.enabled === false && names.every((n) => r.matchPackageNames?.includes(n))
  );
  assert.ok(rule);
  assert.deepEqual(rule.matchUpdateTypes, ['major']);
  assert.equal(rule.allowedVersions, undefined);
});

test('the slicc-shared-web package and workflow ref update together in one PR', () => {
  const rule = preset.packageRules.find(
    (r) => r.groupName && names.every((n) => r.matchPackageNames?.includes(n))
  );
  assert.equal(rule?.groupName, 'slicc-shared-web');
});

function postUpdateOptions(upgrade) {
  let result = preset.postUpdateOptions ?? [];
  for (const rule of preset.packageRules) {
    if (!('postUpdateOptions' in rule)) continue;
    if (rule.matchManagers && !rule.matchManagers.includes(upgrade.manager)) continue;
    if (rule.matchPackageNames && !rule.matchPackageNames.includes(upgrade.depName)) continue;
    result = rule.postUpdateOptions;
  }
  return result;
}

function branchPostUpdateOptions(upgrades) {
  const [first] = [...upgrades].sort((a, b) =>
    a.depName < b.depName ? -1 : a.depName > b.depName ? 1 : 0
  );
  return postUpdateOptions(first);
}

test('a Go module update runs go mod tidy and rewrites import paths', () => {
  const options = postUpdateOptions({ manager: 'gomod', depName: 'github.com/pion/webrtc/v4' });
  assert.ok(options.includes('gomodTidy'));
  assert.ok(options.includes('gomodUpdateImportPaths'));
});

test('a group that moves an npm package with its Go module still tidies go.sum', () => {
  const options = branchPostUpdateOptions([
    { manager: 'gomod', depName: 'github.com/ai-ecoverse/slicc-browsers' },
    { manager: 'npm', depName: '@ai-ecoverse/slicc-browsers' },
  ]);
  assert.ok(options.includes('gomodTidy'));
  assert.ok(options.includes('gomodUpdateImportPaths'));
});
