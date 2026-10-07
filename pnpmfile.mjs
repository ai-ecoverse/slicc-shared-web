export const hooks = {
  updateConfig(config) {
    const exclude = new Set([...(config.minimumReleaseAgeExclude ?? []), '@ai-ecoverse/*']);
    return Object.assign(config, { minimumReleaseAgeExclude: [...exclude] });
  },
};
