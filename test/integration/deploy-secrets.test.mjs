import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(join(repo, '.github', 'workflows', 'pipeline.yml'), 'utf8');
const step = workflow.match(
  /- name: Secrets as environment variables\n[\s\S]*?<<'EOF'\n([\s\S]*?)\n {10}EOF\n/
)[1];
const script = step.replace(/^ {10}/gm, '');
const declared = [
  ...workflow.match(/\n {4}secrets:\n((?: {6}.*\n)+)/)[1].matchAll(/^ {6}(\w+):$/gm),
].map((match) => match[1]);

const secrets = {
  github_token: 'gh',
  ...Object.fromEntries(declared.map((name) => [name, name.toLowerCase()])),
  DEPLOY_TOKEN: 'deploy',
  OTHER: 'multi\nline',
  THIRD: 'third',
};

function exported(deploySecrets) {
  const run = spawnSync(process.execPath, ['--input-type=module'], {
    input: script,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SECRETS: JSON.stringify(secrets),
      DEPLOY_SECRETS: deploySecrets,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('without deploy-secrets the deploy step exports no secret, and the pipeline declares its own', () => {
  for (const name of ['AWS_BEARER_TOKEN_BEDROCK', 'SLICC_ISSUES_TOKEN'])
    assert.ok(declared.includes(name), name);
  assert.equal(exported(''), '');
});

test('with deploy-secrets, the deploy step exports only the listed caller secrets', () => {
  assert.equal(
    exported(` third\nDEPLOY_TOKEN  MISSING github_token\n${declared.join('\n')}\n`),
    'DEPLOY_TOKEN<<SLICC_EOF\ndeploy\nSLICC_EOF\nTHIRD<<SLICC_EOF\nthird\nSLICC_EOF\n'
  );
});
