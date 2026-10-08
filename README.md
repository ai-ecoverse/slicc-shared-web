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
| `pnpmfile.mjs` | pnpm's counterpart to the Renovate preset: an `updateConfig` hook that adds `@ai-ecoverse/*` to `minimumReleaseAgeExclude`, so pnpm 12 doesn't hold back our own fresh releases (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) while third-party packages keep its age check | in a repo with a pnpm lockfile, as a [config dependency](https://pnpm.io/config-dependencies) in `pnpm-workspace.yaml`: `configDependencies: { '@ai-ecoverse/slicc-shared-web': X.Y.Z }` plus `pnpmfile: node_modules/.pnpm-config/@ai-ecoverse/slicc-shared-web/pnpmfile.mjs` |
| `harness/` | The CDP integration-test harness, described [below](#integration-test-harness) | `import { launch } from '@ai-ecoverse/slicc-shared-web/harness'`, and `--test-global-setup=node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs` |

Install it from npm, and pin the reusable workflow to the matching `vX.Y.Z` tag. Renovate keeps both current without the usual waiting period:

```sh
npm install --save-dev --save-exact @ai-ecoverse/slicc-shared-web
```

The hooks expect two scripts in each repo: `test:unit`, which writes `coverage/unit/lcov.info` (unit tests stay out of git), and, in TypeScript repos, `typecheck`. The reusable workflow expects `lint`, plus `test` for the integration tests, with a `pretest` that installs Chromium (`playwright-core install --no-shell chromium`). The diff-coverage hook runs `diff-cover` through `uvx`, so install [uv](https://docs.astral.sh/uv/) once.

## Rules every repo follows

- No comments anywhere, and no `.md` files except README.md and AGENTS.md.
- Agent guidance committed to a repo lives in AGENTS.md only, at most 1,000 characters per file. The repo has no CLAUDE.md, not even as a symlink, since Claude reads AGENTS.md. The check covers tracked and untracked files; gitignored local files are personal and stay out of it.
- Unit tests stay out of git, in a gitignored `test/unit/`. The pre-commit hook requires them to execute every staged line in `src/`.
- Integration tests are committed and run in CI.

## Integration-test harness

`harness/` drives playwright-core's Chromium over raw CDP, as its only client, from `node --test`. Every page, service worker, shared worker and dedicated worker, nested ones included, starts paused, gets coverage and the CPU profiler switched on in the same tick, and only then runs. Each test gets its own browser context and leaves `artifacts/<suite>/<test>/` behind: one CPU profile per target and snapshot, a screenshot per tab and a `console.log` of every target. The global teardown merges the raw coverage into `coverage/` (console table, lcov, V8 HTML) and writes `artifacts/hotspots.md`, the 15 frames with the most self time in the repo's own scripts.

`playwright-core` and `monocart-coverage-reports` are peer dependencies; pin both in the repo's `devDependencies`. A repo describes what to serve and launches the browser once per test file:

```js
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({
  roots: [['/dist/', 'dist/'], ['/', 'test/integration/page/']],
  isolated: true,
  coverage: ['/dist/'],
});
after(() => chrome.close());

test('boots', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => document.title === 'ready');
});
```

| `launch` option | Meaning | Default |
|---|---|---|
| `roots` | `[urlPrefix, directory]` pairs the local server serves, first match wins | `[['/', 'src/']]` |
| `aliases` | Extra `[urlPrefix, directory]` pairs used only to map coverage and profiles back to files, for scripts that something else serves, such as a service worker | none |
| `isolated` | Send COOP, COEP and CORP on every response, so pages are cross-origin isolated | `false` |
| `coverage` | URL prefixes whose `.js`/`.mjs` scripts count for coverage. `node_modules/` never does. A `.map` next to a file is used | `['/']` |
| `exits` | `{ urlPath: [regex, ...] }`: a breakpoint on the first line matching each pattern in that worker script, where the harness takes the worker's coverage and profile before it closes itself | none |
| `intercept` | Remote URL prefixes answered from a disk cache in `node_modules/.cache/` | none |
| `extensions` | Unpacked extension directories to load. Their scripts are covered and profiled like the repo's own, and tests then run in the default browser context, closing their tabs when they end, because Chrome does not run extensions in the per-test contexts | none |
| `args` | Extra Chromium flags, such as `--host-resolver-rules` or `--ignore-certificate-errors` | none |
| `timeout` | How long `page.until` polls and `page.evaluate` waits, in ms | `30000` |

`chrome.page(t)` opens a tab and returns the page API: `goto(path)`, `reload()`, `evaluate(fn, ...args)`, `until(fn, ...args)`, `press(key, ...modifiers)` (a key name like `Enter` or `F5`, or a single character typed with its US-layout key code), `type(text)`, `insert(text)`, `enter()`, `init(fn)` (runs in every new document), `expose(name, handler)` (a binding the page calls with a JSON string), `screenshot(file)`, `tab()` (another tab in the same context), `close()`, `errors`, `responses` and `dir` (the test's artifact directory). `goto` and `reload` wait until the new document is complete and no longer `about:blank`, and retry the navigation once if that never happens. `until` polls until the function returns a truthy value (not only strict `true`) and resolves with that value; the timeout error names the last result. `within(ms, fn, ...args)` is `until` with its own deadline, for a stage that should take a known time. Both stop at the deadline even if one evaluation never answers. Every CDP call has a deadline: `connect(url).send(method, params, sessionId, ms)` rejects with `<method>: no answer in <ms> ms` (60 s unless given), so a stuck page fails its test instead of hanging the run. Downloads of intercepted URLs time out after 60 s and are tried up to three times; a `4xx` is not retried. `chrome.requests` lists the paths the server saw in this test, `chrome.overrides` is a `Map` of paths to bodies served instead of files, and `chrome.cdn` takes `status` (answer every intercepted request with it), `corrupt` (flip the last byte) and lists the intercepted `requests`. All of them reset with each test. `serve(options)` starts the same server on its own, for an `npm start`.

Why it works the way it does:

- Playwright detaches from shared workers, which resumes them early, so their coverage started late about half the time. Raw CDP keeps every worker paused until the profiler runs.
- `debugger;` pauses in `beforeunload` but not in `pagehide` or `pageswap`, so a `beforeunload` hook, installed after `Page.enable`, takes the coverage of a page before it navigates. The pause only answers CDP when the page itself starts the navigation, so `goto` and `reload` go through `location`, never `Page.navigate` or `Page.reload`. Navigating away from `about:blank` skips the coverage dump so the first real load is not held in `beforeunload` for a useless snapshot.
- `goto` used to return as soon as the document swapped (`window.stale` cleared), which is before `readyState` is `complete` and before module scripts run. About 1 load in 20 then looked blank to the next assertion. It now waits for a complete, non-blank document.
- `takePreciseCoverage` resets the counters, so every snapshot is a delta, and all of them are kept and summed.
- monocart's `add()` from parallel test processes loses data, so each test writes raw JSON and the teardown merges it once.
- Coverage of a script served from `chrome.overrides` would be mapped onto the file on disk, so a path overridden during a test is left out of that test's coverage.
- `--disable-extensions --disable-component-extensions-with-background-pages` keeps a Hangouts service worker out of every run.
- The attach event can arrive before `Target.createTarget` returns, so new tabs wait on a slot keyed by target id.
- A worker blocked in `Atomics.wait`, or one that is already gone, may never answer; snapshots give up after 3 s, and closing a context or the browser after 10 s. A call to a target that detaches or crashes fails instead of waiting forever, and a new tab that never attaches fails after 10 s.
