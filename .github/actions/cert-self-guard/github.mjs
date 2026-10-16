import { headArrival } from './arrival.mjs';
import { git } from './changes.mjs';

export function github(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('invalid repository');
  const origin = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const api = async (route, method = 'GET') => {
    const response = await fetch(`${origin}/repos/${repository}/${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(60000),
    });
    if (method === 'DELETE' && [204, 404].includes(response.status)) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${route}: HTTP ${response.status}`);
    return response.json();
  };
  const pages = async (route) => {
    const rows = [];
    for (let page = 1; page <= 30; page++) {
      const entries = await api(`${route}?per_page=100&page=${page}`);
      if (!Array.isArray(entries)) throw new Error('invalid paginated GitHub response');
      rows.push(...entries);
      if (entries.length < 100) return rows;
    }
    throw new Error('GitHub evidence exceeds pagination limit');
  };
  const approval = async (pull, head, label) => {
    const details = { head };
    const missing = (reason) => ({ approved: false, reason, ...details });
    if (pull.head.sha !== head) return missing('queued or reviewed head is stale');
    if (!pull.labels.some((entry) => entry.name === label)) return missing('approval label absent');
    const timeline = await pages(`issues/${pull.number}/timeline`);
    const latest = timeline
      .filter(
        (entry) => ['labeled', 'unlabeled'].includes(entry.event) && entry.label?.name === label
      )
      .at(-1);
    if (latest?.event !== 'labeled') return missing('approval application event absent or removed');
    const headDate = git('show', '-s', '--format=%cI', head);
    const arrival = await headArrival(api, head, timeline);
    Object.assign(details, { headDate, ...arrival });
    const headTime = Date.parse(arrival.headArrivedAt);
    const labelTime = Date.parse(latest.created_at);
    if (!Number.isFinite(labelTime)) throw new Error('approval timestamp evidence invalid');
    if (labelTime <= headTime)
      return missing('approval event is not newer than server-side head arrival');
    const actor = latest.actor?.login;
    if (!/^[\w-]+$/.test(actor ?? '')) return missing('approval labeler missing');
    const permission = await api(`collaborators/${actor}/permission`);
    if (
      !['admin', 'maintain'].includes(permission.permission) &&
      !['admin', 'maintain'].includes(permission.role_name)
    )
      return missing('approval labeler lacks admin or maintain permission');
    return {
      approved: true,
      head,
      actor,
      permission: permission.role_name ?? permission.permission,
      event: latest.id,
      createdAt: latest.created_at,
      ...details,
    };
  };
  const pull = async (number) => {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('invalid PR number');
    const value = await api(`pulls/${number}`);
    if (
      value.number !== number ||
      value.base?.ref !== 'main' ||
      value.base.repo?.full_name !== repository ||
      value.state !== 'open'
    )
      throw new Error('PR is closed or does not target this repository main');
    return value;
  };
  const associated = async (head) => {
    const entries = await pages(`commits/${head}/pulls`);
    const matches = entries.filter(
      (entry) =>
        entry.head?.sha === head &&
        entry.base?.ref === 'main' &&
        entry.base.repo?.full_name === repository &&
        entry.state === 'open'
    );
    if (matches.length !== 1) throw new Error(`cannot uniquely resolve queued PR at ${head}`);
    return pull(matches[0].number);
  };
  return { api, pull, associated, approval };
}
