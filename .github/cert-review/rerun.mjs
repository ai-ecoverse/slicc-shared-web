import { readFileSync } from 'node:fs';
import { api, newestRun, sha } from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const repo = env.GITHUB_REPOSITORY;
const say = (line) => console.log(`cert-rerun: ${line}`);

if (env.GITHUB_EVENT_NAME !== 'pull_request_target') {
  say(`noop (event ${env.GITHUB_EVENT_NAME})`);
  process.exit(0);
}
if (event.action === 'labeled' && event.label?.name !== env.APPROVAL) {
  say(`noop (label ${event.label?.name ?? ''})`);
  process.exit(0);
}
if (!['labeled', 'ready_for_review'].includes(event.action)) {
  say(`noop (action ${event.action})`);
  process.exit(0);
}
if (pull.head.repo?.full_name !== repo) {
  say('noop (a fork: cert-review never reviews forks)');
  process.exit(0);
}
if (pull.draft === true) {
  say('noop (a draft: marking it ready re-runs the review)');
  process.exit(0);
}

const gh = api(repo);
const head = sha(pull.head.sha);
const runs = [];
for (let page = 1; page <= 10; page++) {
  const r = await gh.call(
    `actions/runs?event=pull_request_target&head_sha=${head}&per_page=100&page=${page}`
  );
  runs.push(...(r.workflow_runs ?? []));
  if ((r.workflow_runs ?? []).length < 100) break;
}
const run = newestRun(runs, repo);
if (!run) {
  say(`FAIL no cert-review run on ${head} to re-run; push, or close and reopen the pull request`);
  process.exit(1);
}
if (run.status !== 'completed') {
  say(
    `skip: cert-review run ${run.id} on ${head} is ${run.status}; its post reads the live pull request`
  );
  process.exit(0);
}
await gh.call(`actions/runs/${run.id}/rerun`, 'POST');
say(`re-ran every job of cert-review run ${run.id} on ${head} (#${pull.number} ${event.action})`);
