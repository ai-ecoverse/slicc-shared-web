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
