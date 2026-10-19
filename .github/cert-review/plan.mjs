import { readFileSync } from 'node:fs';
import {
  decide,
  diffOf,
  diffSize,
  git,
  globs,
  noop,
  output,
  sha,
  touchedPaths,
  WORKFLOW,
} from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const head = sha(pull.head.sha);
const repo = env.GITHUB_REPOSITORY;

if (
  noop({
    action: event.action,
    label: event.label?.name,
    approval: env.APPROVAL,
    changes: event.changes,
  })
) {
  console.log(`cert-review plan: noop (${event.action} ${event.label?.name ?? ''})`);
  output({ kind: 'noop' });
  process.exit(0);
}

const fileAt = (commit) => {
  try {
    return git('show', `${sha(commit)}:${WORKFLOW}`);
  } catch {
    return '';
  }
};
const onMain = fileAt(pull.base.sha);
const target = /^\s*pull_request_target:/m.test(onMain);
if (env.GITHUB_EVENT_NAME === 'pull_request' && target) {
  console.log(
    `cert-review plan: noop (main's ${WORKFLOW} runs on pull_request_target, which certifies this head)`
  );
  output({ kind: 'noop' });
  process.exit(0);
}
const pinned = target ? onMain : fileAt(pull.head.sha);
const uses = [
  ...pinned.matchAll(
    /ai-ecoverse\/slicc-shared-web\/\.github\/workflows\/cert-review\.yml@([0-9a-f]{40})/g
  ),
].map((m) => m[1]);
if (uses.length !== 1 || uses[0] !== env.CERT_TOOLS_REF) {
  const title = 'incomplete: tools-ref is not the pinned cert-review; re-run';
  const summaryText = `${WORKFLOW} on main must call slicc-shared-web's cert-review.yml at exactly one sha and pass that sha as tools-ref (found ${uses.join(', ') || 'none'}, tools-ref ${env.CERT_TOOLS_REF || 'empty'}).`;
  console.log(`cert-review plan: failure: ${title}`);
  output({ kind: 'decided', conclusion: 'failure', title, summary: summaryText });
  process.exit(0);
}

const fork = pull.head.repo?.full_name !== repo;
const files = fork ? [] : diffOf(sha(pull.base.sha), head);
const paths = touchedPaths(files);
const d = decide({
  fork,
  repo,
  baseRef: pull.base.ref,
  size: diffSize(files),
  draft: pull.draft === true,
  approval: env.APPROVAL,
  guard: env.GUARD,
  receipt: env.RECEIPT,
  head,
  paths,
  quiet: globs(env.QUIET),
  loud: globs(env.LOUD),
});
if (d.kind === 'review') {
  console.log(
    `cert-review plan: review #${pull.number} ${head}, ${d.behaviour.length} behaviour files`
  );
  output({ kind: 'review' });
} else {
  console.log(`cert-review plan: ${d.conclusion} #${pull.number} ${head}: ${d.title}`);
  output({ kind: 'decided', conclusion: d.conclusion, title: d.title, summary: d.summary });
}
