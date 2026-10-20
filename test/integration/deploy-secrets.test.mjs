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

test('the deploy step exports the caller secrets but none of the pipeline’s own', () => {
  const secrets = {
    github_token: 'gh',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock',
    SLICC_ISSUES_TOKEN: 'issues',
    DEPLOY_TOKEN: 'deploy',
    OTHER: 'multi\nline',
  };
  const run = spawnSync(process.execPath, ['--input-type=module'], {
    input: script,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SECRETS: JSON.stringify(secrets) },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.stdout,
    'DEPLOY_TOKEN<<SLICC_EOF\ndeploy\nSLICC_EOF\nOTHER<<SLICC_EOF\nmulti\nline\nSLICC_EOF\n'
  );
});
