import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [renovateDir, repoDir, configFile] = process.argv.slice(2);
const dist = pathToFileURL(join(renovateDir, 'node_modules', 'renovate', 'dist', '/'));
const load = (path) => import(new URL(path, dist));

const { presetSources, resolveConfigPresets } = await load('config/presets/index.js');
const { mergeChildConfig } = await load('config/utils.js');
const { getConfig } = await load('config/defaults.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { getPlatformPrOptions } = await load('workers/repository/update/pr/index.js');

const preset = JSON.parse(readFileSync(join(repoDir, 'default.json'), 'utf8'));
presetSources.github.load = async () => ({
  getPreset: async ({ repo, presetName }) => {
    if (repo !== 'ai-ecoverse/slicc-shared-web' || presetName !== 'default') {
      throw new Error(`unexpected preset github>${repo}:${presetName}`);
    }
    return preset;
  },
});

const own = JSON.parse(readFileSync(configFile, 'utf8'));
const { config } = await resolveConfigPresets(own);
const resolved = mergeChildConfig(getConfig(), config);

const upgrades = [
  { depName: '@ai-ecoverse/slicc-cdp', updateType: 'patch' },
  { depName: '@biomejs/biome', updateType: 'minor' },
];
const result = [];
for (const { depName, updateType } of upgrades) {
  const upgrade = await applyPackageRules({
    ...resolved,
    manager: 'npm',
    datasource: 'npm',
    depType: 'devDependencies',
    depName,
    packageName: depName,
    updateType,
  });
  result.push({
    depName,
    automerge: upgrade.automerge,
    automergeType: upgrade.automergeType,
    platformAutomerge: upgrade.platformAutomerge,
    usePlatformAutomerge: getPlatformPrOptions(upgrade).usePlatformAutomerge,
  });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
