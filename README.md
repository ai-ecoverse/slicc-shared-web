# slicc-shared-web

Configuration shared by SLICC's web repos ([slicc-bios](https://github.com/ai-ecoverse/slicc-bios), [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel), [slicc-spectrum](https://github.com/ai-ecoverse/slicc-spectrum), and whatever comes next), so a rule changes in one place.

| File | What it is | How a repo uses it |
|---|---|---|
| `default.json` | Root Renovate preset: automerge on, one dependency per PR, exact pins, 7-day release age (14 for majors, 0 for vulnerability fixes and for our own `@ai-ecoverse` packages and `github.com/ai-ecoverse/*` Go modules, which also jump the PR queue), `<upstream>-<build>` versions of our own `@ai-ecoverse` packages, such as `9.12.0-6`, which Renovate would otherwise skip as prereleases, never past the npm `latest` dist-tag (only `<upstream>-slicc.<n>` ones for `@ai-ecoverse/fnox` and its `@ai-ecoverse/fnox-*` platform packages), one PR each, majors included, for the certified pairs `@ai-ecoverse/slicc-kernel` + `@ai-ecoverse/wasi-pnpm` ("kernel and pnpm") and `@ai-ecoverse/wasm-coreutils` + `@ai-ecoverse/wasm-procps` ("coreutils and procps"), `go mod tidy` after every Go module update (plus import-path rewrites on majors), a manager for jsDelivr pins inside `src/`, and one for [`# renovate:` annotated pins in workflow files](#versions-pinned-in-workflow-files) | `renovate.json`: `{ "extends": ["github>ai-ecoverse/slicc-shared-web"] }` |
| `.github/workflows/node-ci.yml` | Reusable CI: `npm ci`, lint, Chromium's system libraries, integration tests, hotspots and the stack of every crash dump in the job summary, coverage/profiles/screenshots/crash dumps as artifacts. The browser itself comes from each repo's `pretest` | `jobs: { ci: { uses: ai-ecoverse/slicc-shared-web/.github/workflows/node-ci.yml@vX.Y.Z } }` |
| `biome.json` | Formatter settings and slicc's strict linter: cognitive complexity ≤ 25, functions ≤ 150 lines, no unused variables or imports, no floating or misused promises, naming conventions, `import type`/`export type`. Test files under `test/` get slicc's test exemptions | `biome.json`: `{ "extends": ["@ai-ecoverse/slicc-shared-web/biome"] }` |
| `tsconfig.json` | TypeScript base for Node's type stripping | `tsconfig.json`: `{ "extends": "@ai-ecoverse/slicc-shared-web/tsconfig.json", "include": ["src/**/*.ts"] }` |
| `lefthook.yml` | Pre-commit hooks: Biome, typecheck, no comments, no unit tests in git, AGENTS.md, and diff coverage over [only the unit tests the change reaches](#which-unit-tests-a-commit-runs) | `lefthook.yml`: `extends: [node_modules/@ai-ecoverse/slicc-shared-web/lefthook.yml]` |
| `mcr.config.mjs` | Unit-test coverage for JS and TS sources in `src/` (TS types are stripped first), written to `coverage/unit/lcov.info`. With `SLICC_UNIT_TESTS` set, `node --test` runs only those files ([below](#which-unit-tests-a-commit-runs)) | `test:unit`: `mcr -c node_modules/@ai-ecoverse/slicc-shared-web/mcr.config.mjs node --test 'test/unit/**/*.test.mjs'` |
| `bin/` | `slicc-lint` runs every check below plus Biome and, if the repo has one, `typecheck`. `slicc-lint-comments` runs the [slicc no-comment checker](https://github.com/ai-ecoverse/slicc/tree/main/packages/dev-tools/no-comment) at a pinned commit, allowing AGENTS.md and [`# renovate:` annotations](#versions-pinned-in-workflow-files) in workflow and action files. `slicc-agents-md`, `slicc-no-unit-tests` and `slicc-diff-cover` complete the set, and `slicc-unit-cover` is the diff-coverage hook. `slicc-minidump <file.dmp>...` prints a crash dump's stack, described [below](#crash-dumps). `slicc-memory-peak` prints the job's [memory peak](#memory-peak) | `lint`: `slicc-lint`, and the hooks above |
| `pnpmfile.mjs` | pnpm's counterpart to the Renovate preset: an `updateConfig` hook that adds `@ai-ecoverse/*` to `minimumReleaseAgeExclude`, so pnpm 12 doesn't hold back our own fresh releases (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) while third-party packages keep its age check | in a repo with a pnpm lockfile, as a [config dependency](https://pnpm.io/config-dependencies) in `pnpm-workspace.yaml`: `configDependencies: { '@ai-ecoverse/slicc-shared-web': X.Y.Z }` plus `pnpmfile: node_modules/.pnpm-config/@ai-ecoverse/slicc-shared-web/pnpmfile.mjs` |
| `harness/` | The CDP integration-test harness, described [below](#integration-test-harness) | `import { launch } from '@ai-ecoverse/slicc-shared-web/harness'`, and `--test-global-setup=node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs` |

Install it from npm, and pin the reusable workflow to the matching `vX.Y.Z` tag. Renovate keeps both current without the usual waiting period:

```sh
npm install --save-dev --save-exact @ai-ecoverse/slicc-shared-web
```

The hooks expect two scripts in each repo: `test:unit`, which writes `coverage/unit/lcov.info` (unit tests stay out of git), and, in TypeScript repos, `typecheck`. The reusable workflow expects `lint`, plus `test` for the integration tests, with a `pretest` that installs Chromium (`slicc-cdp install-browser --version <x.y.z.w>`, or `playwright-core install --no-shell chromium`). Its inputs `lint`, `test`, `chromium`, `chromium-cache` and `node-version` override those, and `timeout-minutes` (20 by default) gives a long job, such as a background-tab measurement, more time. `runs-on` (`ubuntu-latest` by default) picks the runner label, such as a self-hosted pool or one an earlier job chose; the caller decides which runner may run which code, so a fork's pull request should stay on a GitHub-hosted runner. With `chromium` on, Chromium's system libraries are installed with `playwright-core install-deps` only where it runs as root or `sudo -n true` works; on a runner without root (one with "no new privileges", say) the step is skipped with a notice and the image must already ship them. The `pretest` download needs no root either way. With `chromium` on, the workflow also caches Playwright's browser directory (`~/.cache/ms-playwright`, or `$PLAYWRIGHT_BROWSERS_PATH`) with `actions/cache`, keyed on the runner's OS and architecture and the `playwright-core` version in `package-lock.json`, so a warm `pretest` skips the download and a `playwright-core` bump starts a fresh cache. A repo without `playwright-core` in its lockfile gets no cache; `chromium-cache: false` turns it off. The diff-coverage hook runs `diff-cover` through `uvx`, so install [uv](https://docs.astral.sh/uv/) once.

## Rules every repo follows

- No comments anywhere, and no `.md` files except README.md and AGENTS.md. The one exception is the `# renovate:` line [above a pinned version in a workflow](#versions-pinned-in-workflow-files).
- Agent guidance committed to a repo lives in AGENTS.md only, at most 1,000 characters per file. The repo has no CLAUDE.md, not even as a symlink, since Claude reads AGENTS.md. The check covers tracked and untracked files; gitignored local files are personal and stay out of it.
- Unit tests stay out of git, in a gitignored `test/unit/`. The pre-commit hook requires them to execute every staged line in `src/`.

## Versions pinned in workflow files

Renovate updates `uses:` actions and `package.json` on its own, but not a version written into a workflow's `env:`, a `with:` input or a `run:` line. The preset reads [Renovate's documented annotation](https://docs.renovatebot.com/modules/manager/regex/#advanced-capture) on the line above such a pin, in `.github/workflows/*.yml` and any `action.yml`:

```yaml
# renovate: datasource=<npm|github-releases|github-tags|go|docker|…> depName=<name> [packageName=…] [versioning=…] [extractVersion=…] [registryUrl=…]
```

The optional fields go in that order. The version is the first one on the next line after a `:`, an `=` or an `@`, starting with a digit or `v` and a digit. Without `versioning=` it is compared as `semver-coerced`, so `24` and `v2.12.2` work too. One example per shape:

```yaml
env:
  # renovate: datasource=github-releases depName=rhysd/actionlint extractVersion=^v(?<version>.+)$
  ACTIONLINT: 1.7.7
```

```yaml
with:
  # renovate: datasource=github-tags depName=nodejs/node versioning=node
  node-version: 22.11.0
```

```yaml
# renovate: datasource=github-tags depName=owner/action
- uses: owner/action@v4.1.0
```

```yaml
# renovate: datasource=npm depName=playwright-core
- run: npm i -g playwright-core@1.63.0
```

When a command needs the version more than once, as actionlint's download does, put it in `env:` once and use the variable, so a single annotated value moves. Renovate's `github-actions` manager already updates ordinary `uses:` refs, by tag or commit SHA, so annotate a `uses:` only when its ref should follow some other datasource.

Pin only where a fixed version is genuinely needed. When a workflow rolls forward to whatever is certified, as with `@ai-ecoverse/slicc-kernel` and its certified siblings, resolve "the newest certified" at run time instead (from the npm `latest` dist-tag, say) rather than pinning and annotating it.

## Memory peak

The reusable workflow's last step, which runs even when an earlier one failed, writes one line to the log and the job summary. It gives the job's memory peak and limit in MiB, `nproc` and the runner's name, so a runner that later "lost communication" can be compared with the peak of the same job's good runs. The numbers come from cgroup v2 (`memory.peak`, `memory.max`), from the job's own cgroup first and then the root one, or else from cgroup v1 (`memory.max_usage_in_bytes`, `memory.limit_in_bytes`), and the line names the file each one came from. A value it can't read is `n/a`, and the step never fails the job. A repo whose `@ai-ecoverse/slicc-shared-web` predates the script still gets `nproc` and the runner name.

A workflow of its own (not this reusable one) gets the same line from the composite action, as its last step:

```yaml
      - uses: ai-ecoverse/slicc-shared-web/.github/actions/memory-peak@<tag or sha>
        if: always()
```

## Certification self-guard

`.github/actions/cert-self-guard` is a shared composite action for PR certification lanes. It inspects the PR's diff against its base (both paths of a rename included) and rejects certification-path edits with `cert-review: needs coordinator review` unless `cert-review-approved` was applied after the current head commit by a user whose GitHub repository permission is **admin or maintain**. Write permission is not enough. It reads the label application from the issue timeline and checks the labeler's current permission through the API, rather than trusting the event sender or the label's presence alone. Removing and reapplying the label replaces the approval event; an old application cannot qualify. Missing git history, API errors, stale heads, ambiguous group membership and truncated timeline evidence fail closed as `INCOMPLETE`.

The guard's assumption is that **workers never apply or remove `cert-review-approved`; only a lane coordinator does, after reading the certification-path change**. On `synchronize`, the guard itself removes that label automatically and blocks a touched PR until the coordinator approves its new head. A failed removal is red. This automated invalidation is not permission for workers to change the label manually. A re-run of the original synchronize event still requires fresh approval; run the subsequent label event instead.

On `merge_group`, the guard walks the first-parent merge ancestry from `head_sha` back to `base_sha`, resolves each merge's second parent to exactly one open PR, and inspects that member's actual merged delta. It checks approval against that queued head, not just whatever head the PR API currently returns. A moved head, an unexplained non-merge commit or an unapproved certification-path PR makes the group red. It does not call an LLM or run candidate code.

Callers use **one external `uses:` line pinned to a full commit SHA**, not a local action path or the PR's checkout. The composite executes its script from `github.action_path`, the downloaded pinned action directory. Each lane supplies one newline-separated `paths` list covering its certification workflows, reviewer/classifier/record tools and runners. The default list covers `.github/workflows/cert*.yml`, `.github/workflows/cert*.yaml`, `scripts/cert/**`, `tools/cert-review/**` and `.github/actions/cert-self-guard/**`. Inclusive repository-relative globs use Node's `path.matchesGlob`; negations are not supported. Include the caller's **entire cert workflow**, so changing the guard's own `uses:` line or pinned SHA is itself guarded. An empty or invalid list fails closed.

```yaml
permissions:
  contents: read
  pull-requests: read
  issues: write

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    with:
      ref: ${{ github.event.pull_request.base.sha || github.event.merge_group.head_sha }}
      fetch-depth: 0
      persist-credentials: false
  - name: Fetch the exact trees to inspect, without executing them
    env:
      HEAD: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
      BASE: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
    run: git fetch --no-tags origin "$BASE" "$HEAD"
  - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
    with:
      node-version: 24
  - uses: ai-ecoverse/slicc-shared-web/.github/actions/cert-self-guard@<full-commit-sha>
    with:
      paths: |
        .github/workflows/cert*.yml
        .github/workflows/cert*.yaml
        scripts/cert/**
        tools/cert-review/**
        scripts/cert-runner/**
      approval-label: cert-review-approved
```

The caller triggers `pull_request` (including `synchronize`, `labeled` and `unlabeled`) and `merge_group` and runs this metadata-only step separately from candidate execution. It needs Node 24+, complete local git objects for the exact base/head/group ancestry, `contents: read`, `pull-requests: read` and `issues: write` for automatic label invalidation. Use GitHub-hosted isolated runners for candidate build/test jobs, with read-only tokens, no secrets and `persist-credentials: false`. The guard neither executes their code nor needs review, signing or publishing credentials. No CODEOWNERS or code-owner ruleset requirement is imposed by this action.

Outputs are `status` (`PASS`, `FAIL`, `INCOMPLETE`), `touched` and a structured JSON `receipt` containing the exact head(s), changed/guarded paths, approval event, labeler permission and reason. Every non-PASS result exits nonzero. The receipt and job summary include this precise limitation:

> self-guard catches accidental cert-path edits; not enforced against a deliberate rewrite of the workflow

A `pull_request` workflow can be deliberately rewritten to skip the guard, change its inputs or fabricate a status. This is an accidental-self-certification guard, **not** an organization-required-workflow security boundary. Pinning the action stops accidental use of the PR's implementation but does not force a candidate-controlled workflow to call it. Ruleset changes or an organization-required workflow are a separate owner decision.

The committed public CLI integration regressions use real git repositories and a fake GitHub HTTP API. Run only this non-browser suite locally with `node --test test/integration/cert-self-guard.test.mjs`; CI also runs it with the full integration suite. It covers touched/untouched changes, a self-passing workflow/pin edit, rename paths, label timing, permission, approval followed by a push, API refusal and groups containing an unapproved or stale PR.

## Which unit tests a commit runs

The diff-coverage hook, `slicc-unit-cover`, runs only the unit tests that cover the staged change, then `slicc-diff-cover` on their `coverage/unit/lcov.info`, so every staged line in `src/` still has to run:

- **What counts as changed:** the staged files (`git diff --cached --name-only`). Since `test/unit/` is gitignored, files in it count as changed when they were modified after HEAD last moved (the last commit, checkout or pull).
- **Which tests run:** every `*.test.*` file in `test/unit/` that is changed, or whose static imports reach a changed file. The import graph is parsed with [acorn](https://github.com/acornjs/acorn), TypeScript after Node's type stripping. It follows `import`, `export … from`, `import()`, `require()` and `new URL(…, import.meta.url)` with literal paths, relative or through the `paths` of `tsconfig.json` (and the files it extends). A path may leave out its extension or name `index`, and `.js` also finds `.ts`. Type-only imports don't count, and nothing is followed into `node_modules/`.
- **Barrels are followed by name:** a test that imports `{ a, b }` from a module follows only what provides `a` and `b`: `export { a } from`, `export { default as a } from`, an imported binding exported again, and `export * from`, by the target's own exports. `const { a, b } = await import('…')` with a literal path is followed by name too. A name the module declares itself follows all of that module's imports. A namespace import (`import * as`), any other `import()` (bound to a namespace, with `.then`, or destructured with a computed key or a rest element), a `require()`, and an `export *` that leads outside the repo or into CommonJS (any `.cjs` or `.cts` file) all count as the whole module.
- **No code staged** (only docs, YAML, JSON or lockfiles): no unit tests and no diff coverage; the hook passes.
- **A staged file no unit test reaches:** no tests run, its lines show as uncovered, and diff coverage fails as before.
- **A file that won't parse:** one warning line, then every unit test.

The hook passes the list to the repo's own `test:unit` in `SLICC_UNIT_TESTS` (one path per line). A `--require` preload, which `slicc-unit-cover` and the shared `mcr.config.mjs` add to `NODE_OPTIONS`, makes the `node --test` process run the files on that list that its own patterns match, and none when the list is empty. Without the variable, `npm run test:unit` runs everything as before. To force a full run in the hook:

```sh
SLICC_UNIT_ALL=1 git commit
```
- Integration tests are committed and run in CI.

## Integration-test harness

`harness/` drives Chromium over raw CDP on `--remote-debugging-pipe`, as its only client, from `node --test`. Every page, service worker, shared worker and dedicated worker, nested ones included, starts paused, gets coverage (and the CPU profiler, when profiling is on) switched on in the same tick, and only then runs. Each test gets its own browser context and leaves `artifacts/<suite>/<test>/` behind: a screenshot per tab and a `console.log` of every target. Lines logged before the first test, such as an extension service worker's at startup, go into the first test's `console.log`. The global teardown merges the raw coverage into `coverage/` (console table, lcov, V8 HTML) and writes `artifacts/hotspots.md`.

CPU profiling is off by default. V8's sampler interrupts each page and worker thread every 100 µs with a signal, and the renderer SIGSEGVs in slicc-bios#114 all fault inside a signal handler walking the interrupted thread's frames, which points at it. Turn it on with `profile: true` or `SLICC_PROFILE=1` to get one CPU profile per target and snapshot in the test's artifact directory, and the 15 frames with the most self time in the repo's own scripts in `hotspots.md`. Without it, `hotspots.md` says that profiling is off.

`monocart-coverage-reports` is a peer dependency; pin it in the repo's `devDependencies`. The browser is the first of these:
- `launch({ executable })`;
- `$CHROME_PATH`;
- `findBrowser()` from `@ai-ecoverse/slicc-cdp`. It finds a Chrome for Testing that `npx slicc-cdp install-browser --version <x.y.z.w>` installed, or a system Chrome;
- `chromium.executablePath()` from `playwright-core`, after `npx playwright-core install chromium`.

Both packages are optional peers: pin whichever the repo uses. Neither is imported unless the step before it found nothing. Whatever the browser, its profile is a fresh `slicc-harness-*` directory in the temp dir. A repo describes what to serve and launches the browser once per test file:

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
| `intercept` | Remote URL prefixes answered from a disk cache in `node_modules/.cache/`. Registry documents (anything on a `registry.*` host but a `/-/….tgz` tarball: packuments, abbreviated or full, and dist-tags) are fetched fresh once per test process and only served from the disk cache when the registry can't be reached (a `4xx` is passed on) | none |
| `extensions` | Unpacked extension directories to load. They are loaded with `Extensions.loadUnpacked` (behind `--enable-unsafe-extension-debugging`) once the harness is attached, so their service workers start paused like every other target. Their scripts are covered and profiled like the repo's own, and tests then run in the default browser context, closing their tabs when they end, because Chrome does not run extensions in the per-test contexts | none |
| `persistent` | Run every test in the default browser context, on the launch's on-disk `slicc-harness-*` profile, instead of a fresh off-the-record context per test. Off-the-record contexts keep OPFS in memory, with a far smaller real budget than `navigator.storage.estimate()` reports, so a suite that stores hundreds of MB there needs this. When a test ends, its tabs are closed and `Storage.clearDataForOrigin` (`storageTypes: 'all'`) clears the server's origin, every origin a page in the context showed (popups the app opened included) and every origin the harness's tabs got a response from, so nothing leaks into the next test. If clearing fails, the test fails | `false` |
| `executable` | The Chromium binary. Without it, `$CHROME_PATH`, then slicc-cdp's `findBrowser()`, then playwright-core (see above) | found |
| `args` | Extra Chromium flags, such as `--host-resolver-rules` or `--ignore-certificate-errors` | none |
| `timeout` | How long `page.until` polls and `page.evaluate` waits, in ms | `30000` |
| `stallAfter` | How long one evaluation may run before the harness probes the test's targets, in ms | `30000` |
| `profile` | Record a CPU profile of every target, sampled every 100 µs | `true` if `SLICC_PROFILE=1`, else `false` |
| `realistic` | Run Chrome as a user would: headed, and without `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`, so a tab behind another one is hidden and throttled. For measuring background tabs. It needs a display: on CI, run the tests under `xvfb-run -a` | `false` |

`chrome.page(t)` opens a tab and returns the page API: `goto(path)`, `reload()`, `evaluate(fn, ...args)`, `until(fn, ...args)`, `press(key, ...modifiers)` (a key name like `Enter` or `F5`, or a single character typed with its US-layout key code), `type(text)`, `insert(text)`, `enter()`, `init(fn)` (runs in every new document), `expose(name, handler)` (a binding the page calls with a JSON string), `screenshot(file)`, `tab()` (another tab in the same context), `close()`, `send(method, params, ms)` (a raw CDP call in the tab's session), `errors`, `responses` and `dir` (the test's artifact directory). `chrome.pid` is the browser's process id and `chrome.profile` its `slicc-harness-*` profile directory in `$TMPDIR`. `goto` and `reload` wait until the new document is complete and no longer `about:blank`, and retry the navigation once if that never happens. `until` polls until the function returns a truthy value (not only strict `true`) and resolves with that value; the timeout error names the last result. `within(ms, fn, ...args)` is `until` with its own deadline, for a stage that should take a known time. Both stop at the deadline even if one evaluation never answers. Every CDP call has a deadline: `connect(url).send(method, params, sessionId, ms)` rejects with `<method>: no answer in <ms> ms` (60 s unless given), so a stuck page fails its test instead of hanging the run. A crash fails it at once instead:
- when the browser dies, every pending and later call rejects with `<method>: browser exited with <signal>` (or `with code <n>`);
- when a renderer crashes, every pending and later call to that target, and to the dedicated workers it started, rejects with `<method>: page renderer crashed (<status>, code <n>) at <url>` (or `worker`, `shared worker`, `service worker`), and `console.log` gets the same line;
- `until`, `within`, `goto` and `reload` stop retrying and rethrow it;
- both errors end with the last five lines of the browser's stderr, and each test keeps up to 200 lines it wrote during the test in `chrome-stderr.log`.
- a test that saw a renderer crash, or a browser that died of anything but `SIGKILL`, keeps Chrome's minidump of it as `<id>.dmp` in its artifact directory (see [Crash dumps](#crash-dumps)).

`chrome.cdp` is the browser's own pipe, the one the harness already drives, with no session of its own: test-only, unguarded access that bypasses everything a product guard would do, and never for product code. `send(method, params, sessionId)` makes a raw call at browser level, or in any session the browser has (the harness's auto-attached ones included); a protocol error rejects with the message and keeps the error object as `error.cdp`. `on(listener)` receives every event the browser sends, as `{ method, params, sessionId }`, until `off(listener)` or the function `on` returned. `waitEvent(method, predicate, ms)` resolves with the next matching event (call it before the action that causes the event); the predicate is optional, a predicate alone works too (`waitEvent(predicate, ms)`), and it rejects after `ms` (10 s unless given). `events` is an append-only array of every event since it was first read. That is the `{ send, waitEvent, events }` client the guard runner of `@ai-ecoverse/slicc-browsers` takes, so `run(set, { client, unguarded: chrome.cdp, … })` gives it the unguarded observer that 14 of its vectors need.

 When one evaluation runs past `stallAfter`, the harness probes once, without interrupting the wait:
- it adds a `pending` line to `console.log` for every navigation and request of the page that has no answer yet, with its age. A worker's script loads in the worker's own session, so its request is left out. Chrome holds CDP messages to a page while a navigation is waiting for its response, so an evaluation that hangs while the page is idle usually means one of these;
- it saves `stall-<n>.png` (a screenshot of the page, if the renderer still answers) in the test's artifact directory;
- when profiling is on, it saves a CPU profile sample of every page and worker in the test, including workers started by other workers, as `stall-<n>-<target>-<session>.cpuprofile`;
- it adds a line per target to `console.log`, saying whether that target is running or paused;
- on the first stall, it records a 10 s browser trace as `stall-1-trace.json` (open it in DevTools' Performance panel or Perfetto). The browser collects it with V8 CPU samples per thread, task, IPC, Blink and loading events, so it shows what a page's main thread is doing even when that thread no longer answers CDP. It logs each process's CPU time over the window, and for each renderer its main thread's task count, the call chain of its longest or still open task (function, file, line and URL of a request), and where its CPU samples fall. The targets are sampled after the trace starts, so their new profiles carry their call frames into it. A call that started before the trace shows only as a node id, since its frames were named before; a thread that is blocked keeps `Tracing.start` waiting, which the harness logs and traces through;
- the summary runs in the test process, which also serves the page's files and talks CDP, so it is linear in the trace's events: a busy page's half-million-event trace takes well under a second, and the page's fetches keep getting answers meanwhile;
- it adds a line for every debugger pause still held in the browser, in any target, with its id, URL, start time, reason and top call frames.

A pause in one target blocks every page in the same renderer process, so those pause lines name the culprit even when it isn't the page under test. The harness resumes its own coverage pauses (`beforeunload`, worker exits) within 10 s, even when collecting coverage fails. Downloads of intercepted URLs time out after 60 s and are tried up to three times; a `4xx` is not retried. `chrome.requests` lists the paths the server saw in this test, `chrome.overrides` is a `Map` of paths to bodies served instead of files, and `chrome.cdn` takes `status` (answer every intercepted request with it), `corrupt` (flip the last byte) and lists the intercepted `requests`. All of them reset with each test. `serve(options)` starts the same server on its own, for an `npm start`.

Why it works the way it does:

- Playwright detaches from shared workers, which resumes them early, so their coverage started late about half the time. Raw CDP keeps every worker paused until the profiler runs.
- `debugger;` pauses in `beforeunload` but not in `pagehide` or `pageswap`, so a `beforeunload` hook, installed after `Page.enable`, takes the coverage of a page before it navigates. The pause only answers CDP when the page itself starts the navigation, so `goto` and `reload` go through `location`, never `Page.navigate` or `Page.reload`; they schedule it with `setTimeout` in an isolated world of the page (so page code that replaces its timers can't stop it), so the `Runtime.evaluate` that starts it answers before the old document goes, which otherwise loses the race on a slow runner ("Inspected target navigated or closed"). Navigating away from `about:blank` skips the coverage dump so the first real load is not held in `beforeunload` for a useless snapshot.
- `goto` used to return as soon as the document swapped (`window.stale` cleared), which is before `readyState` is `complete` and before module scripts run. About 1 load in 20 then looked blank to the next assertion. It now waits for a complete, non-blank document.
- `takePreciseCoverage` resets the counters, so every snapshot is a delta, and all of them are kept and summed.
- monocart's `add()` from parallel test processes loses data, so each test writes raw JSON and the teardown merges it once.
- Coverage of a script served from `chrome.overrides` would be mapped onto the file on disk, so a path overridden during a test is left out of that test's coverage.
- A CI cache restored with a prefix key kept packuments from before a release, so pnpm in the page saw an outdated `latest` and failed with `ERR_PNPM_NO_MATCHING_VERSION`. Tarballs and versioned CDN files never change and stay cached forever; registry documents do change, so the disk copy is only the offline fallback.
- An unscoped packument cached at `registry.npmjs.org/<name>` sat where the tarball directory `registry.npmjs.org/<name>/-/` goes, so saving one after the other failed with `EISDIR` and pnpm in the page saw `ECONNREFUSED`. Registry documents are now cached as `<path>/index.json`; a file left at the old place is a miss and is removed when something needs its place.
- `--disable-extensions --disable-component-extensions-with-background-pages` keeps a Hangouts service worker out of every run.
- The attach event can arrive before `Target.createTarget` returns, so new tabs wait on a slot keyed by target id.
- A worker blocked in `Atomics.wait`, or one that is already gone, may never answer; snapshots give up after 3 s, and closing a context or the browser after 10 s. A call to a target that detaches or crashes fails instead of waiting forever, and a new tab that never attaches fails after 10 s.
- A WebSocket that has closed takes new messages without an error, and a crashed target never answers, so after a crash every call used to wait out its own deadline: a browser that died 4 s in showed up as `no answer` 15 minutes later. The harness now remembers the crash or the exit and fails each call with it.

## Cleanup

`close()` stops Chrome and removes its profile. It asks Chrome to close, waits up to 10 s for the exit, sends `SIGKILL`, waits up to 5 s more and then moves on with a warning, so a browser that ignores `Browser.close` or a missed exit never hangs teardown. A test process that ends without `close()` still leaves nothing running:
- on `exit` and on `SIGINT`, `SIGTERM` or `SIGHUP`, the harness kills every browser it started in that process, with all its helper processes (Chrome runs in its own process group), with `SIGKILL` and removes its profile and crash dump directory, then re-raises the signal so the process ends the way it would have;
- when the test process dies of `SIGKILL`, no handler runs. A watchdog, a `sh` in its own process group that reads a pipe from the test process, then gets end of file and kills Chrome's process group with `SIGKILL` at once. Chrome also shuts itself down when the CDP pipe closes, but that can take seconds. Only the profile stays behind;
- the first `launch()` in a process removes every `slicc-harness-*` directory in `$TMPDIR` that is older than a day, or older than a minute and no running process uses as its `--user-data-dir`. It never kills a process.

## Crash dumps

Chrome for Testing runs crashpad by default and ignores `--crash-dumps-dir` and `--enable-crash-reporter`: on Linux it writes every dump to `~/.config/google-chrome-for-testing/Crash Reports/pending/`. `launch` points it at a fresh directory per browser through `BREAKPAD_DUMP_LOCATION`, waits up to 10 s after a crash for crashpad to finish writing, copies the new dumps into the test's artifact directory and deletes the directory on `close()`. Nothing is uploaded.

Google publishes no symbols for Chrome for Testing: no Breakpad files next to the `chrome-linux64.zip` downloads, and the binary is stripped (only `.eh_frame` and a `.gnu_debuglink` to a file that isn't public). Chrome keeps frame pointers, though, so the stack walks cleanly as `module + offset`, and the dump carries crashpad's annotations: `ver`, `ptype` (`renderer`, `gpu-process`, `browser` and so on), the GPU (`gpu-gl-renderer` shows SwiftShader in CI), the page's origin, and V8 crash keys when V8 sets them.

`slicc-minidump <file.dmp>...` downloads a pinned, checksummed [`minidump-stackwalk`](https://github.com/rust-minidump/rust-minidump) 0.27.0 into `~/.cache/slicc-minidump/` (Linux x64 and macOS) and prints, per dump, the signal and address, the faulting module and offset, the annotations without the command-line switches, the crashing thread's first 40 frames and the module list with build ids. The reusable workflow runs it on every `artifacts/**/*.dmp`, writes the full report next to the dump as `<id>.txt` and puts everything above the module list into the job summary. To read a dump from a CI run locally:

```sh
gh run download <run-id> -n coverage-profiles-screenshots -D ci
npx slicc-minidump ci/artifacts/<suite>/<test>/*.dmp
```

A Linux dump reads fine on a Mac. Offsets are only comparable across dumps from the same `ver`. A frame in `chrome` with the `ud2` instruction and `SIGTRAP` is a deliberate `CHECK` or `IMMEDIATE_CRASH`; `SIGSEGV` with a wild address points at memory corruption, and a top frame in `libvk_swiftshader.so`, `libGLESv2.so` or `libEGL.so` at the software GPU.
