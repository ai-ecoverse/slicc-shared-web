import { appendFileSync, readFileSync } from 'node:fs';
import { changedPaths, checkedSha, git, groupMembers, patterns, touchedPaths } from './changes.mjs';
import { github } from './github.mjs';

const receipt = {
  schema: 1,
  repository: process.env.GITHUB_REPOSITORY,
  run: process.env.GITHUB_RUN_ID ?? 'local',
  attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
  label: process.env.CERT_GUARD_APPROVAL_LABEL ?? 'cert-review-approved',
  residual:
    'self-guard catches accidental cert-path edits; not enforced against a deliberate rewrite of the workflow',
  status: 'INCOMPLETE',
  touched: false,
  members: [],
};

async function inspect(api, pull, base, head, globs, synchronized = false, diffHead = head) {
  const paths = changedPaths(base, diffHead);
  const touched = touchedPaths(paths, globs);
  const member = { pr: pull.number, base, head, paths, touched, approved: false };
  if (pull.head.sha !== head) throw new Error(`PR #${pull.number} head is stale`);
  let timing;
  if (synchronized && pull.labels.some((entry) => entry.name === receipt.label)) {
    try {
      timing = await api.freshness(pull, head, receipt.label);
    } catch (error) {
      member.reason = `approval timing unavailable; clearing label on synchronize: ${error.message}`;
      try {
        await api.api(
          `issues/${pull.number}/labels/${encodeURIComponent(receipt.label)}`,
          'DELETE'
        );
        member.removedApproval = true;
      } catch (removal) {
        member.reason += `; removal failed: ${removal.message}`;
      }
      member.status = 'INCOMPLETE';
      return member;
    }
    Object.assign(member, timing);
    if (!timing.fresh) {
      try {
        await api.api(
          `issues/${pull.number}/labels/${encodeURIComponent(receipt.label)}`,
          'DELETE'
        );
        member.removedApproval = true;
      } catch (error) {
        return { ...member, status: 'INCOMPLETE', reason: error.message };
      }
      member.reason =
        'synchronize cleared approval that is not newer than the current head arrival';
      member.status = touched.length ? 'FAIL' : 'PASS';
      return member;
    }
    member.keptApproval = true;
  }
  if (touched.length) {
    try {
      Object.assign(member, await api.approval(pull, head, receipt.label, timing));
    } catch (error) {
      return { ...member, status: 'INCOMPLETE', reason: error.message };
    }
  }
  member.status = !touched.length || member.approved ? 'PASS' : 'FAIL';
  return member;
}

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.repository?.full_name !== receipt.repository)
    throw new Error('event repository mismatch');
  if (!receipt.label || /[\r\n]/.test(receipt.label)) throw new Error('invalid approval label');
  const globs = patterns(
    process.env.CERT_GUARD_PATHS ??
      '.github/workflows/cert*.yml\n.github/workflows/cert*.yaml\nscripts/cert/**\ntools/cert-review/**\n.github/actions/cert-self-guard/**'
  );
  receipt.patterns = globs;
  const api = github(receipt.repository);
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const head = checkedSha(event.pull_request.head.sha);
    const base = checkedSha(event.pull_request.base.sha);
    const pull = await api.pull(event.pull_request.number);
    const comparison = git('merge-base', base, head);
    receipt.members.push(
      await inspect(api, pull, comparison, head, globs, event.action === 'synchronize')
    );
  } else if (process.env.GITHUB_EVENT_NAME === 'merge_group') {
    const base = checkedSha(event.merge_group.base_sha);
    const head = checkedSha(event.merge_group.head_sha);
    receipt.base = base;
    receipt.head = head;
    for (const member of groupMembers(base, head)) {
      try {
        const pull = await api.associated(member.head);
        receipt.members.push({
          ...(await inspect(api, pull, member.base, member.head, globs, false, member.merge)),
          merge: member.merge,
        });
      } catch (error) {
        receipt.members.push({ ...member, status: 'INCOMPLETE', reason: error.message });
      }
    }
  } else {
    throw new Error('self-guard requires pull_request or merge_group');
  }
  receipt.touched = receipt.members.some((member) => member.touched?.length);
  receipt.status = receipt.members.some((member) => member.status === 'FAIL')
    ? 'FAIL'
    : receipt.members.some((member) => member.status !== 'PASS')
      ? 'INCOMPLETE'
      : 'PASS';
} catch (error) {
  receipt.reason = error.message;
}
const serialized = JSON.stringify(receipt);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `status=${receipt.status}\ntouched=${receipt.touched}\nreceipt=${serialized}\n`
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### Certification self-guard: ${receipt.status}\n\n${receipt.residual}\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`
  );
console.log(serialized);
if (receipt.status !== 'PASS') {
  console.error('cert-review: needs coordinator review');
  process.exitCode = 1;
}
