# slicc-shared-web

Configuration shared by SLICC's web repos ([slicc-bios](https://github.com/ai-ecoverse/slicc-bios), [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel), [slicc-spectrum](https://github.com/ai-ecoverse/slicc-spectrum), and whatever comes next), so a rule changes in one place.

| File | What it is | How a repo uses it |
|---|---|---|
| `default.json` | Root Renovate preset: automerge on, one dependency per PR, exact pins, 7-day release age (14 for majors, 0 for vulnerability fixes and for our own `@ai-ecoverse` packages, which also jump the PR queue), and a manager for jsDelivr pins inside `src/` | `renovate.json`: `{ "extends": ["github>ai-ecoverse/slicc-shared-web"] }` |
| `.github/workflows/node-ci.yml` | Reusable CI: `npm ci`, lint, Chromium's system libraries, integration tests, hotspots in the job summary, coverage/profiles/screenshots as artifacts. The browser itself comes from each repo's `pretest` | `jobs: { ci: { uses: ai-ecoverse/slicc-shared-web/.github/workflows/node-ci.yml@vX.Y.Z } }` |
| `biome.json` | Formatter settings and slicc's strict linter: cognitive complexity ≤ 25, functions ≤ 150 lines, no unused variables or imports, no floating or misused promises, naming conventions, `import type`/`export type`. Test files under `test/` get slicc's test exemptions | `biome.json`: `{ "extends": ["@ai-ecoverse/slicc-shared-web/biome"] }` |
| `tsconfig.json` | TypeScript base for Node's type stripping | `tsconfig.json`: `{ "extends": "@ai-ecoverse/slicc-shared-web/tsconfig.json", "include": ["src/**/*.ts"] }` |
| `lefthook.yml` | Pre-commit hooks: Biome, typecheck, no comments, no unit tests in git, AGENTS.md, diff coverage | `lefthook.yml`: `extends: [node_modules/@ai-ecoverse/slicc-shared-web/lefthook.yml]` |
| `mcr.config.mjs` | Unit-test coverage for JS and TS sources in `src/` (TS types are stripped first), written to `coverage/unit/lcov.info` | `test:unit`: `mcr -c node_modules/@ai-ecoverse/slicc-shared-web/mcr.config.mjs node --test 'test/unit/**/*.test.mjs'` |
| `bin/` | `slicc-lint` runs every check below plus Biome and, if the repo has one, `typecheck`. `slicc-lint-comments` runs the [slicc no-comment checker](https://github.com/ai-ecoverse/slicc/tree/main/packages/dev-tools/no-comment) at a pinned commit, allowing AGENTS.md. `slicc-agents-md`, `slicc-no-unit-tests` and `slicc-diff-cover` complete the set | `lint`: `slicc-lint`, and the hooks above |

Install it from npm, and pin the reusable workflow to the matching `vX.Y.Z` tag. Renovate keeps both current without the usual waiting period:

```sh
npm install --save-dev --save-exact @ai-ecoverse/slicc-shared-web
```

The hooks expect two scripts in each repo: `test:unit`, which writes `coverage/unit/lcov.info` (unit tests stay out of git), and, in TypeScript repos, `typecheck`. The reusable workflow expects `lint`, plus `test` for the integration tests, with a `pretest` that installs Chromium (`playwright-core install --no-shell chromium`). The diff-coverage hook runs `diff-cover` through `uvx`, so install [uv](https://docs.astral.sh/uv/) once.

## Rules every repo follows

- No comments anywhere, and no `.md` files except README.md and AGENTS.md.
- Agent guidance lives in AGENTS.md only, at most 1,000 characters per file. There is no CLAUDE.md, not even as a symlink, since Claude reads AGENTS.md.
- Unit tests stay out of git, in a gitignored `test/unit/`. The pre-commit hook requires them to execute every staged line in `src/`.
- Integration tests are committed and run in CI.
