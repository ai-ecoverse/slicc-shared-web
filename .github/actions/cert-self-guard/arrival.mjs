export async function headArrival(api, head, timeline) {
  let unavailable;
  try {
    const suites = [];
    for (let page = 1; page <= 30; page++) {
      const data = await api(`commits/${head}/check-suites?per_page=100&page=${page}`);
      if (!Array.isArray(data.check_suites) || !Number.isSafeInteger(data.total_count))
        throw new Error('invalid check-suite arrival evidence');
      suites.push(...data.check_suites);
      if (data.check_suites.length < 100) {
        if (suites.length !== data.total_count) throw new Error('check-suite listing incomplete');
        const dates = suites
          .map((suite) => {
            if (suite.head_sha !== head || !Number.isFinite(Date.parse(suite.created_at)))
              throw new Error('check-suite head or timestamp invalid');
            return suite.created_at;
          })
          .sort((a, b) => Date.parse(a) - Date.parse(b));
        if (dates.length)
          return {
            headArrivedAt: dates[0],
            headArrivalSource: 'earliest GitHub check-suite created_at',
          };
        throw new Error('head has no check-suite arrival evidence');
      }
    }
    throw new Error('check-suite evidence exceeds pagination limit');
  } catch (error) {
    unavailable = error.message;
  }
  const pushes = timeline.filter((entry) =>
    ['head_ref_force_pushed', 'head_ref_pushed'].includes(entry.event)
  );
  const latest = pushes.at(-1);
  if (latest?.after_commit?.sha === head && Number.isFinite(Date.parse(latest.created_at)))
    return {
      headArrivedAt: latest.created_at,
      headArrivalSource: `GitHub PR timeline ${latest.event}`,
      headArrivalEvent: latest.id,
    };
  throw new Error(
    `server-side head arrival unavailable: ${unavailable}; no matching latest head-push timeline event`
  );
}
