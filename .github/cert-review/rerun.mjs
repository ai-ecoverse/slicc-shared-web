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
if (['labeled', 'unlabeled'].includes(event.action) && event.label?.name !== env.APPROVAL) {
  say(`noop (label ${event.label?.name ?? ''})`);
  process.exit(0);
}
if (event.action === 'edited' && !event.changes?.base) {
  say('noop (edited, not the base)');
  process.exit(0);
}
if (!['labeled', 'unlabeled', 'ready_for_review', 'edited'].includes(event.action)) {
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
const ours = runs.filter(
  (r) => !r.pull_requests?.length || r.pull_requests.some((p) => p.number === pull.number)
);
const run = newestRun(ours, repo);
if (!run) {
  say(`FAIL no cert-review run on ${head} to re-run; push, or close and reopen the pull request`);
  process.exit(1);
}
const wait = Number(env.CERT_RERUN_WAIT_MS ?? 180000);
if (run.status !== 'completed') {
  say(
    `cert-review run ${run.id} on ${head} is ${run.status}: cancelling it, since it read the pull request before this ${event.action}`
  );
  try {
    await gh.call(`actions/runs/${run.id}/cancel`, 'POST');
  } catch (err) {
    if (err.status !== 409) throw err;
  }
  const until = Date.now() + wait;
  for (;;) {
    const now = await gh.call(`actions/runs/${run.id}`);
    if (now.status === 'completed') break;
    if (Date.now() > until) {
      say(`FAIL run ${run.id} did not stop within ${wait / 1000}s; re-run it when it has`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, Number(env.CERT_RERUN_POLL_MS ?? 5000)));
  }
}
try {
  await gh.call(`actions/runs/${run.id}/rerun`, 'POST');
} catch (err) {
  if (err.status !== 403 || !/already running|in progress/i.test(err.message)) throw err;
  say(`skip: run ${run.id} is already re-running (another event got there first)`);
  process.exit(0);
}
say(`re-ran every job of cert-review run ${run.id} on ${head} (#${pull.number} ${event.action})`);
