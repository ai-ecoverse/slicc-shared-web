import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [renovateDir, repoDir, configFile, depName, ...cases] = process.argv.slice(2);
const dist = pathToFileURL(join(renovateDir, 'node_modules', 'renovate', 'dist', '/'));
const load = (path) => import(new URL(path, dist));

const { presetSources, resolveConfigPresets } = await load('config/presets/index.js');
const { mergeChildConfig } = await load('config/utils.js');
const { getConfig } = await load('config/defaults.js');
const { applyPackageRules } = await load('util/package-rules/index.js');
const { lookupUpdates } = await load('workers/repository/process/lookup/index.js');
const { default: datasources } = await load('modules/datasource/api.js');

const preset = JSON.parse(readFileSync(join(repoDir, 'default.json'), 'utf8'));
presetSources.github.load = async () => ({
  getPreset: async ({ repo, presetName }) => {
    if (repo !== 'ai-ecoverse/slicc-shared-web' || presetName !== 'default') {
      throw new Error(`unexpected preset github>${repo}:${presetName}`);
    }
    return preset;
  },
});

let published = [];
datasources.get('npm').getReleases = async ({ packageName }) => {
  if (packageName !== depName) throw new Error(`unexpected lookup of ${packageName}`);
  return {
    releases: published.map((version) => ({
      version,
      releaseTimestamp: '2020-01-01T00:00:00.000Z',
    })),
    tags: { latest: published.at(-1) },
  };
};

const own = JSON.parse(readFileSync(configFile, 'utf8'));
const { config } = await resolveConfigPresets(own);
const resolved = mergeChildConfig(getConfig(), config);

const result = [];
for (const [currentValue, newVersion] of cases.map((c) => c.split(':'))) {
  published = [currentValue, newVersion];
  const depConfig = await applyPackageRules(
    {
      ...resolved,
      manager: 'npm',
      datasource: 'npm',
      versioning: 'npm',
      depType: 'devDependencies',
      depName,
      packageName: depName,
      currentValue,
    },
    'pre-lookup'
  );
  const { val, err } = (await lookupUpdates(depConfig)).unwrap();
  if (err) throw err;
  result.push({
    currentValue,
    newVersion,
    offered: val.updates.some((update) => update.newVersion === newVersion),
  });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
