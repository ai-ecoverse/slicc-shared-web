# slicc-shared-web

Configuration shared by SLICC's web repos ([slicc-bios](https://github.com/ai-ecoverse/slicc-bios), [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel), [slicc-spectrum](https://github.com/ai-ecoverse/slicc-spectrum), and whatever comes next), so a rule changes in one place.

| File | What it is | How a repo uses it |
|---|---|---|
| `default.json` | Root Renovate preset: automerge on, one dependency per PR, exact pins, 7-day release age (14 for majors, 0 for vulnerability fixes and for our own `@ai-ecoverse` packages and `github.com/ai-ecoverse/*` Go modules, which also jump the PR queue), `<upstream>-<build>` versions of our own `@ai-ecoverse` packages, such as `9.12.0-6`, which Renovate would otherwise skip as prereleases, never past the npm `latest` dist-tag (only `<upstream>-slicc.<n>` ones for `@ai-ecoverse/fnox` and its `@ai-ecoverse/fnox-*` platform packages), one PR each, majors included, for the certified pairs `@ai-ecoverse/slicc-kernel` + `@ai-ecoverse/wasi-pnpm` ("kernel and pnpm") and `@ai-ecoverse/wasm-coreutils` + `@ai-ecoverse/wasm-procps` ("coreutils and procps"), `go mod tidy` after every Go module update (plus import-path rewrites on majors), a manager for jsDelivr pins inside `src/`, and one for [`# renovate:` annotated pins in workflow files](#versions-pinned-in-workflow-files) | `renovate.json`: `{ "extends": ["github>ai-ecoverse/slicc-shared-web"] }` |
| `.github/workflows/node-ci.yml` | Reusable CI: `npm ci`, lint, Chromium's system libraries, integration tests, hotspots and the stack of every crash dump in the job summary, coverage/profiles/screenshots/crash dumps as artifacts. The browser itself comes from each repo's `pretest` | `jobs: { ci: { uses: ai-ecoverse/slicc-shared-web/.github/workflows/node-ci.yml@vX.Y.Z } }` |
| `biome.json` | Formatter settings and slicc's strict linter: cognitive complexity ≤ 25, functions ≤ 150 lines, no unused variables or imports, no floating or misused promises, naming conventions, `import type`/`export type`. Test files under `test/` get slicc's test exemptions | `biome.json`: `{ "extends": ["@ai-ecoverse/slicc-shared-web/biome"] }` |
| `tsconfig.json` | TypeScript base for Node's type stripping | `tsconfig.json`: `{ "extends": "@ai-ecoverse/slicc-shared-web/tsconfig.json", "include": ["src/**/*.ts"] }` |
| `lefthook.yml` | Pre-commit hooks: Biome, typecheck, no comments, no unit tests in git, AGENTS.md, and diff coverage over [only the unit tests the change reaches](#which-unit-tests-a-commit-runs) | `lefthook.yml`: `extends: [node_modules/@ai-ecoverse/slicc-shared-web/lefthook.yml]`, and `prepare`: `slicc-install-hooks` plus the committed `.githooks/` it writes ([one hooks directory per worktree](#one-hooks-directory-per-worktree)) |
| `mcr.config.mjs` | Unit-test coverage for JS and TS sources (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`) in `src/` or the `slicc.unitSources` directories (TS types are stripped first; TS that strip-only mode rejects, such as enums and parameter properties, is transformed with [amaro](https://github.com/nodejs/amaro) under the tests too, through an `--import` loader the config adds to `NODE_OPTIONS`, and its coverage is mapped back to the `.ts` lines; the same loader resolves a relative `./x.js`, `.mjs` or `.cjs` that isn't on disk to its `.ts`, `.mts` or `.cts` sibling, and imports a `.json` module, such as a package whose `main` is JSON, without `with { type: 'json' }`), written to `coverage/unit/lcov.info`. Every source file is in it, tested or not, and paths are matched relative to the repo root, so a checkout under a dot-directory such as `~/.bb/` still reports untested files to diff coverage. With `SLICC_UNIT_TESTS` set, `node --test` runs only those files ([below](#which-unit-tests-a-commit-runs)) | `test:unit`: `mcr -c node_modules/@ai-ecoverse/slicc-shared-web/mcr.config.mjs node --test 'test/unit/**/*.test.mjs'` |
| `bin/` | `slicc-lint` runs every check below plus Biome and, if the repo has one, `typecheck`. Every step prints its own `<step>: PASS …` line, and slicc-lint checks for it: a step that exits 0 without one fails the run with exit 70 (`slicc-lint: FAIL <step> (no PASS line from it)`), so a check that silently stops early can't pass. The last line, `slicc-lint: PASS`, comes only after every step has printed its PASS, and a gate can require it. `slicc-lint-comments` runs the [slicc no-comment checker](https://github.com/ai-ecoverse/slicc/tree/main/packages/dev-tools/no-comment) at a pinned commit, allowing AGENTS.md and [`# renovate:` annotations](#versions-pinned-in-workflow-files) in workflow and action files. `slicc-agents-md`, `slicc-no-unit-tests` and `slicc-diff-cover` complete the set, and `slicc-unit-cover` is the diff-coverage hook. `slicc-minidump <file.dmp>...` prints a crash dump's stack, described [below](#crash-dumps). `slicc-memory-peak` prints the job's [memory peak](#memory-peak). `slicc-install-hooks` installs the hooks into [this worktree's own directory](#one-hooks-directory-per-worktree), and on Windows does nothing and exits 0, so `npm ci` works there | `lint`: `slicc-lint`, and the hooks above |
| `pnpmfile.mjs` | pnpm's counterpart to the Renovate preset: an `updateConfig` hook that adds `@ai-ecoverse/*` to `minimumReleaseAgeExclude`, so pnpm 12 doesn't hold back our own fresh releases (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) while third-party packages keep its age check | in a repo with a pnpm lockfile, as a [config dependency](https://pnpm.io/config-dependencies) in `pnpm-workspace.yaml`: `configDependencies: { '@ai-ecoverse/slicc-shared-web': X.Y.Z }` plus `pnpmfile: node_modules/.pnpm-config/@ai-ecoverse/slicc-shared-web/pnpmfile.mjs` |
| `harness/` | The CDP integration-test harness, described [below](#integration-test-harness) | `import { launch } from '@ai-ecoverse/slicc-shared-web/harness'`, and `--test-global-setup=node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs` |
| `testing/` | Git fixtures that pass the AI git wrapper: `initFixtureRepo(dir, { hooks })` inits a throwaway repo with its own identity, no signing and no template hooks (`hooks: false` sets `core.hooksPath` to `/dev/null`), `commit(dir, message)` commits what is staged without `--no-verify`, and `commitAll(dir, message)` stages with `git add -A -- :/` first, all ignoring global and system git config, so a global `core.hooksPath` never runs in the fixture. Use them instead of `git add -A`, `git add .` or `--no-verify` in a test, which the wrapper refuses when an AI tool runs the suite | `import { commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing'` |

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

`.github/actions/cert-self-guard` is a shared composite action for PR certification lanes. It inspects the PR's diff against its base (both paths of a rename included) and rejects certification-path edits with `cert-review: needs coordinator review` unless `cert-review-approved` was applied after the current head **arrived at GitHub** by a user whose GitHub repository permission is **admin or maintain**. The arrival time is the earliest `created_at` from `commits/{sha}/check-suites`, or, if unavailable, the PR timeline's latest matching head-push event. If neither server-side source is available, approval is `INCOMPLETE`. The client-controlled committer date is retained only as information in the receipt; it never authorizes approval. Write permission is not enough. It reads the label application from the issue timeline and checks the labeler's current permission through the API, rather than trusting the event sender or the label's presence alone. Removing and reapplying the label replaces the approval event; an old application cannot qualify. Missing git history, API errors, stale heads, ambiguous group membership and truncated timeline evidence fail closed as `INCOMPLETE`.

The guard's assumption is that **workers never apply or remove `cert-review-approved`; only a lane coordinator does, after reading the certification-path change**. The permission API cannot distinguish a coordinator from a worker: all agents act as `trieloff`, an admin. Coordinator-only labelling is therefore a **procedural assumption**, not something the permission check enforces. Approval is **head-bound, cleared on any later push**. On `synchronize`, the guard compares the latest label application with the current head's server-side arrival before invalidating it. An old application (not newer than that arrival) is removed automatically and a touched PR is blocked until its new head is approved. If the coordinator already approved the new head after the push but before a delayed synchronize job starts, the label is **kept** and the ordinary admin/maintain permission check still applies. A permission lookup failure leaves that newer label in place but returns `INCOMPLETE`; keeping the label is not itself approval. If arrival/timing evidence is unavailable, the guard conservatively removes the label, returns `INCOMPLETE`, and records that reason. This is deliberately strict even when the PR does not touch certification paths: a present label with unknown timing is still invalidated and returns `INCOMPLETE`. A known stale label on an untouched PR is removed without blocking that PR (`PASS`). A failed removal is also red `INCOMPLETE`. This automated invalidation is not permission for workers to change the label manually. Re-running an old synchronize event does not clear a newer head-bound approval.

On `merge_group`, the guard walks the first-parent merge ancestry from `head_sha` back to `base_sha`, resolves each merge's second parent to exactly one open PR, and inspects that member's actual merged delta. It checks approval against that queued head, not just whatever head the PR API currently returns. A moved head, an unexplained non-merge commit or an unapproved certification-path PR makes the group red. This assumes the queue's **merge-commit method** with two-parent synthetic merges; squash/rebase or any other unexplained ancestry fails closed. It does not call an LLM or run candidate code.

Callers use **one external `uses:` line pinned to a full commit SHA**, not a local action path or the PR's checkout. The composite executes its script from `github.action_path`, the downloaded pinned action directory. Each lane supplies one newline-separated `paths` list covering its certification workflows, reviewer/classifier/record tools and runners. The default list covers `.github/workflows/cert*.yml`, `.github/workflows/cert*.yaml`, `scripts/cert/**`, `tools/cert-review/**` and `.github/actions/cert-self-guard/**`. Inclusive repository-relative globs are matched fail-closed, with dot semantics: a path counts as touched when Node's `path.matchesGlob` matches it, when the glob matches it with `**` crossing dot segments and `*` matching a leading dot (`dotGlob` in `changes.mjs`), or, for a literal `X/**` glob, when it starts with `X/`. So `tools/cert-review/.npmrc` and `scripts/cert/a/.b/c.mjs` need the label too; `matchesGlob` alone skips them. Negations are not supported. Include the caller's **entire cert workflow**, so changing the guard's own `uses:` line or pinned SHA is itself guarded. An empty or invalid list fails closed.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled, ready_for_review]
  merge_group:
    types: [checks_requested]

permissions:
  contents: read
  checks: read
  pull-requests: write

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

The caller uses the triggers shown above and runs this metadata-only step separately from candidate execution. It needs Node 24+, **`actions/checkout` with `fetch-depth: 0`** (for merge-base and group ancestry), complete local git objects for the exact base/head/group ancestry, `contents: read`, **`checks: read`** for server-side head-arrival evidence and **`pull-requests: write`** for automatic label invalidation. A failed DELETE is red `INCOMPLETE`; the integration suite covers a permission-denied DELETE. Use GitHub-hosted isolated runners for candidate build/test jobs, with read-only tokens, no secrets and `persist-credentials: false`. The guard neither executes their code nor needs review, signing or publishing credentials. No CODEOWNERS or code-owner ruleset requirement is imposed by this action.

Outputs are `status` (`PASS`, `FAIL`, `INCOMPLETE`), `touched` and a structured JSON `receipt` containing the exact head(s), changed/guarded paths, approval event, labeler permission and reason. Every non-PASS result exits nonzero. The receipt and job summary include this precise limitation:

> self-guard catches accidental cert-path edits; not enforced against a deliberate rewrite of the workflow

A `pull_request` workflow can be deliberately rewritten to skip the guard, change its inputs or fabricate a status. This is an accidental-self-certification guard, **not** an organization-required-workflow security boundary. Pinning the action stops accidental use of the PR's implementation but does not force a candidate-controlled workflow to call it. Ruleset changes or an organization-required workflow are a separate owner decision.

The committed public CLI integration regressions use real git repositories and a fake GitHub HTTP API. Run only this non-browser suite locally with `node --test test/integration/cert-self-guard.test.mjs`; CI also runs it with the full integration suite. It covers touched/untouched changes, a self-passing workflow/pin edit, rename paths, label timing against **server-side arrival** (including a backdated committer date), permission, approval followed by a push, delayed synchronize preserving a post-push approval, unknown arrival causing conservative invalidation, API refusal and groups containing an unapproved or stale PR.

## Certification review (cert-review v2)

`.github/workflows/cert-review.yml` is a reusable workflow that certifies every non-draft pull request into `main` and sets one **`cert-review` commit status** on its head (created by `github-actions[bot]`, its `target_url` the run attempt that wrote it, always `success` or `failure`). It is a commit status, not a check run: GitHub attaches a check run created with `GITHUB_TOKEN` to an older check suite, so a ruleset that requires it reports it as expected forever (B28, slicc-extension#133). The caller grants `checks: read` and `statuses: write`. It follows Lars's 2026-10-19 model: no approval or label gates (draft status decides), findings as line comments on the diff, an LLM that reads and never runs PR code, and a separate job that validates the closed verdict schema and posts it. The design note is `slicc-agent-plan/cert-review-v2.md`; the reference implementation is slicc-extension's (B28).

A caller (`.github/workflows/cert-review.yml` in the repo, its only cert workflow):

```yaml
name: cert-review
on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled, unlabeled, edited]
  merge_group:
permissions:
  contents: read
concurrency:
  group: ${{ (((github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.event.label.name != 'cert-review-approved') || (github.event.action == 'edited' && !github.event.changes.base)) && format('cert-review-noop-{0}', github.run_id) || format('cert-review-{0}-{1}', github.event_name == 'pull_request' && 'leg' || 'pr', github.event.pull_request.number || github.event.merge_group.head_sha) }}
  cancel-in-progress: ${{ github.event_name != 'merge_group' }}
jobs:
  cert:
    name: cert
    uses: ai-ecoverse/slicc-shared-web/.github/workflows/cert-review.yml@<sha>
    permissions:
      contents: read
      actions: read
      checks: read
      statuses: write
      issues: write
      pull-requests: write
    with:
      tools-ref: <the same sha>
      rules: scripts/cert/review.txt
      loud: |
        src/**
    secrets:
      AWS_BEARER_TOKEN_BEDROCK: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
```

- **Ready and approval re-run themselves** (`cert-rerun.yml`): under an org "require workflows" ruleset, cert-review starts only on `opened`, `synchronize` and `reopened`, so marking a pull request ready, adding or removing `cert-review-approved`, or moving its base to `main` starts nothing. Each repository also has a small second caller (the workflow must not be named `cert-review`):

  ```yaml
  name: cert-rerun
  on:
    pull_request_target:
      branches: [main]
      types: [ready_for_review, labeled, unlabeled, edited]
  permissions: {}
  jobs:
    rerun:
      uses: ai-ecoverse/slicc-shared-web/.github/workflows/cert-rerun.yml@<sha>
      permissions:
        actions: write
      with:
        tools-ref: <the same sha>
  ```

  It runs only main's code (no checkout of the pull request) with `actions: write` and nothing else, so it never writes `cert-review`. It does nothing for a fork, a draft, a label other than the approval label (added or removed), or an edit that doesn't change the base. Otherwise it finds the newest run of the caller on the head for this pull request (`actions/runs?event=pull_request_target&head_sha=`, the caller's path or that path `@refs/heads/main`, a `workflows/` or `required_workflows/` URL of this repository) and re-runs all its jobs. A run still in progress read the pull request before this event (its plan decided draft or the guard read the label already, and post can only turn a pass into a failure), so it is cancelled first and then re-run. One cert-rerun runs per pull request at a time, and a run another event already re-ran is a skip. No run at all fails cert-rerun visibly (push, or close and reopen). The re-run's plan reads draft, base and fork from the live pull request and fails as incomplete if the head moved, and post sets success only while the pull request is open, ready, into `main` and at this head. No pull request needs a manual "re-run all jobs". Its runs are on another path, so plan, post and the merge group never count them as cert-review runs.
- **Jobs** (`cert / …`): `self-guard` (cert-self-guard v1.24.2, pinned), `plan` (read-only: fork, draft, cert path, not behaviour, too large, or review), `review` (Claude on Bedrock with Read/Glob/Grep only, no Bash/Write/Web, structured output in `verdict.schema.json`, `contents: read`, the key in that step only), `post` (the only writer of `cert-review`: validates the verdict, re-anchors comments into diff hunks, posts one review, `REQUEST_CHANGES` on a failure, and runs a code-only prompt-injection and opaque-file scan that can only fail a pass), and `merge group` (code only: each member's newest run of the caller on its head must have certified it; it waits while that run is still queued or running, up to 7 minutes shared across the members, passes over finished noop runs only, and stops at the first member that isn't certified). GitHub API reads are retried on 5xx and network errors, and both fallbacks also run when a job is cancelled.
- **CI evidence** (`evidence-workflow`, `evidence-artifacts`, optional): for a repository whose certification needs pull-request code to run (tests, scripted scenarios), that code runs in the repository's own CI workflow on `pull_request`, with no secrets and a read-only token, and uploads artifacts. The `evidence` job (`contents`/`actions: read`, no secrets, no pull-request code) waits up to `evidence-wait-minutes` for that workflow's newest `pull_request` run on the head (this repository, this pull request), takes the newest finished `push` run on the base branch at or behind the base, downloads the artifacts whose names match by id, checks each zip's sha256 against its digest, unpacks it into `<side>/<artifact id>/` without links, binary files and the head side's images (no code can scan an image's text; main's images stay) or more than four times `evidence-max-mb` in total, scans the head side's text for bidi or zero-width controls and reviewer-aimed text, and uploads one `cert-review-evidence` artifact that the review downloads by id. Post checks that the run's only evidence artifact has the evidence job's id and digest. The newest artifact of each name is taken, and only if it was made in the run's latest attempt; unsafe names are skipped. The prompt names both runs; the head side is data written by the pull request's code. A missing run, artifact or digest, or another evidence artifact, is `incomplete: evidence`, never a review; an injection hit in the evidence fails the check in code, except under `evidence-notes` (globs of `<artifact>/<path>` the caller marks as upstream data, such as a dependency tarball's diff), where it is a suspect note for the review. The evidence workflow is part of the cert path (every workflow is in the default guard paths).
- **Code check** (`code-check`, optional): a command the `evidence` job runs from the caller's tree at main (on the bootstrap `pull_request` leg, the head's), after `npm ci --ignore-scripts`, with `BASE_SHA` (the merge base), `HEAD_SHA` (fetched as objects, never checked out on `pull_request_target`) and a read-only `GH_TOKEN`. A non-zero exit, or no result, is a fail finding in code with the output's verdict line; the full output is evidence for the review. slicc-bios runs its pin release-state this way, so the pull request's own code can't make it pass.
- **The rules** file is the caller's own section of the prompt ("the repository and what to certify"), read from `main`; the frame around it (untrusted text, severity, tests, answer format) is shared in `.github/cert-review/frame.txt`. A missing rules file stops the review, which reads as `incomplete`.
- **tools-ref** must be the sha in the caller's `uses:`; the plan reads the caller that runs (main's tip, `github.sha`, on `pull_request_target`) and fails closed on a mismatch. The rules and the review's workspace come from that same commit, not from the pull request's possibly stale `base.sha`; `base.sha` only anchors the diff.
- **Job names:** the caller's job may have any name; the merge group matches the called jobs by their ` / post`, ` / plan` and ` / self-guard` suffixes.
- **Security boundary:** `pull_request_target` runs main's caller, prompt and post code, so a pull request can't change its own cert path. Every workflow and action is in the default guard paths, so a pull request can't add its own check writer without the coordinator's `cert-review-approved`. The merge group accepts only runs of the caller's path on `pull_request_target`.
- **Bootstrap (one pull request per repo, no ruleset flip):** the switching pull request's caller also lists `pull_request:` with the same types, in a concurrency group of its own (`cert-review-leg-<n>`), so the two legs never cancel each other. While main's caller has no `pull_request_target`, that leg certifies the switching pull request with its own code (under the coordinator's label) and the merge group accepts its run. Once main has it, the leg is a no-op and only `pull_request_target` runs count. A follow-up removes the leg.
- **Secrets never get posted:** post withholds any verdict that carries a value this run holds (the Bedrock key, the job token; raw, JSON-escaped, base64, base64url, hex or URL-encoded) or a known token shape (`gh[pousr]_`, `github_pat_`, `AKIA`/`ASIA`, `ABSK`, a JWT, a PEM block): the check is `incomplete: verdict carries a secret` and nothing is posted. Other long mixed-case runs (a lockfile's sha512 integrity, a base64 quote) are redacted in place and posted.
- **The last writer:** GitHub enforces the newest `cert-review` status, and any workflow's `GITHUB_TOKEN` with `statuses: write` writes as `github-actions[bot]`, so a status written *after* ours can't be caught by this workflow. A pull request can add such a workflow only under the coordinator's `cert-review-approved` (every workflow is a guard path), and the org "require workflows" ruleset makes the merge depend on this workflow's own run, not on the status (slicc-agent-plan/cert-review-v2-probe.md). Apply that ruleset per repository.
- **A second writer fails closed:** post and the merge group list every `cert-review` status and check run on the head. A status not created by `github-actions[bot]`, or whose `target_url` isn't an attempt of a run of the caller on the right event and head, a check run from another app or whose `external_id` names no such run, a second write for one run attempt, or a state that the attempt's post (or merge group) job contradicts, fails the check and opens one alert issue.
- **The injection scan** (code, on added lines outside the guard paths): bidirectional and zero-width controls and text aimed at the reviewer (a `"verdict": "pass"` literal, "as the cert reviewer", generic override phrases that name the reviewer or verdict) force a failure; generic phrases alone ("system prompt", "ignore previous instructions") are a note, and the review is told those lines are suspect. `injection-allow` (globs, read from main's caller, so guard-protected) exempts test fixtures from the aimed rule; controls are never exempt.
- **The one label:** `cert-review-approved` is the single exception to "no labels" (PM, provisional): it applies only to pull requests that change the certifier, it can't turn a failure into a pass (success needs the guard's approval and a pass verdict), and the approver is an agent. Dropping it is the `approval-label` input plus the guard step, with nothing else depending on it.
- **Releases** carry no cert line: merged on main means certified; supply-chain provenance stays a code-only check in each repo.

## One hooks directory per worktree

Without it, every worktree of a repo shares `.git/hooks/` with the main clone, and each `lefthook install` repoints that one hook at its own worktree's lefthook, so a commit anywhere runs with whichever worktree installed last, until that worktree is deleted. A repo rolls it out in one PR: `package.json` installs the hooks with

```json
"prepare": "slicc-install-hooks"
```

and the PR commits the `.githooks/` directory that the first `npm install` writes.

- **What it does:** sets one shared, relative `core.hooksPath` of `.githooks` (`<dir>/.githooks` for a package in a subdirectory of the repo), runs `lefthook install --force` with its output pointed at this worktree's gitignored `node_modules/.git-hooks/`, and writes a shim into `.githooks/` for every hook lefthook installed that has none yet. It never overwrites an existing shim. Git resolves a relative `core.hooksPath` against the top of the worktree a commit runs in, so each worktree runs its own committed shim, and the shim runs that worktree's own `node_modules/.git-hooks/<hook>`. No `extensions.worktreeConfig`, no per-worktree config, and `core.bare` stays where it is, so worktrees of a bare repo work too. Running it again changes nothing.
- **Hooks are never shared:** whatever another worktree installs later, removing a worktree removes only its own hooks, and a moved checkout keeps working. Lefthook's own `postinstall` refuses the custom `core.hooksPath`, writes nothing and doesn't fail the install, and git never reads `.git/hooks/` once `core.hooksPath` is set, so `allowScripts` needs no entry for lefthook.
- **A worktree that never ran `npm install`** fails every commit with `pre-commit: run npm install`, since its shim finds no `node_modules/.git-hooks/pre-commit`.
- **A checkout without the committed `.githooks/`** (a branch cut before the rollout PR) has no shim, so its commits run no hooks until it merges or rebases onto the rollout.
- **A hook type added to `lefthook.yml` later** needs `npm install` again in each worktree, and its new shim committed: lefthook skips its own hook sync while `core.hooksPath` is set.
- **Lefthook's `core.hooksPath is set locally` notice** on commits is expected. Don't follow its advice to unset `core.hooksPath`: that sends every worktree back to the shared `.git/hooks/`.
- **Clones set up by the previous version** (2.1.1, 1.29.3), which set an absolute per-worktree `core.hooksPath` into a `worktree-hooks/` directory: it unsets that in the current worktree's `config.worktree`. It leaves `extensions.worktreeConfig` and the moved `core.bare` alone.
- **Outside a git checkout** (a packed tarball, say) it does nothing and exits 0.

## Which unit tests a commit runs

The diff-coverage hook, `slicc-unit-cover`, runs only the unit tests that cover the staged change, then `slicc-diff-cover` on their `coverage/unit/lcov.info`, so every staged line in `src/` still has to run:

- **Which directories are source:** `src/` by default, anywhere in the path, as before. A repo whose code lives elsewhere lists its directories in `package.json`: `"slicc": { "unitSources": ["extension", "six", "scripts"] }`, repo-relative, without `.` or `..` segments. `mcr.config.mjs` then collects coverage only from those directories, and the hook treats a staged file outside them as no code. A malformed list fails the hook.
- **What counts as changed:** the staged files (`git diff --cached --name-only`), and nothing else. `test/unit/` is gitignored, and repos that keep their unit tests in a store outside git sync the whole store into it before a commit, which brings in tests for code that is on other branches; so a unit test that is new or edited runs only when its imports reach a staged file, like any other. One that reaches nothing staged adds no coverage to the staged lines.
- **Committing a merge, cherry-pick or rebase:** while `MERGE_HEAD` or `CHERRY_PICK_HEAD` exists, or a rebase is running and has stopped at `REBASE_HEAD`, only lines that are new against `HEAD` and against each of those commits count: conflict resolutions and edits made during the merge, not what the other side brought, which was covered where it was written. Diff coverage checks only those lines; the tests that run and the missing-lcov check follow the files that hold them, and files where the merge itself deleted lines. A merge with no changes of its own is no code staged. A revert counts as usual.
- **A unit test for code this tree doesn't have:** a test whose imports reach a staged file but also a code module under the sources that doesn't exist, isn't gitignored and isn't a staged deletion (a store test for a module on another branch) is skipped, and the hook names it in one line before the count. A missing `new URL(…, import.meta.url)` target, a missing non-code file such as `.wasm` or `.json`, and a missing file outside the sources or gitignored (a build output such as `dist/` or a bundled worker) don't skip the test.
- **Which tests run:** every `*.test.*` file in `test/unit/` that is changed, or whose static imports reach a changed file. The import graph is parsed with [acorn](https://github.com/acornjs/acorn), TypeScript after Node's type stripping, or amaro's transform where stripping isn't enough. It follows `import`, `export … from`, `import()`, `require()` and `new URL(…, import.meta.url)` with literal paths, relative or through the `paths` of `tsconfig.json` (and the files it extends). A path may leave out its extension or name `index`, and `.js` also finds `.ts`. Type-only imports don't count, and nothing is followed into `node_modules/`.
- **Barrels are followed by name:** a test that imports `{ a, b }` from a module follows only what provides `a` and `b`: `export { a } from`, `export { default as a } from`, an imported binding exported again, and `export * from`, by the target's own exports. `const { a, b } = await import('…')` with a literal path is followed by name too. A name the module declares itself follows all of that module's imports. A namespace import (`import * as`), any other `import()` (bound to a namespace, with `.then`, or destructured with a computed key or a rest element), a `require()`, and an `export *` that leads outside the repo or into CommonJS (any `.cjs` or `.cts` file) all count as the whole module.
- **No code staged** (only docs, YAML, JSON or lockfiles): no unit tests and no diff coverage; the hook passes.
- **A staged file no unit test reaches:** no tests run, its lines show as uncovered, and diff coverage fails as before.
- **A staged source file missing from the lcov:** the hook fails and names it, so no file passes diff coverage just because nothing measured it. `.jsx` and `.tsx` files are not transformed for coverage, so staging one under the sources fails the hook too.
- **A file that won't parse:** one warning line, then every unit test.

The hook passes the list to the repo's own `test:unit` in `SLICC_UNIT_TESTS` (one path per line). A selection of more than `SLICC_UNIT_BATCH` files (60 by default) runs in batches of that size, one `test:unit` run each with its own coverage in `coverage/unit/batch-N/` (the shared `mcr.config.mjs` writes to `SLICC_UNIT_COVERAGE_DIR` when it's set), and `slicc-diff-cover` gets every batch's `lcov.info`; diff-cover counts a line covered when any batch covered it. The hook ends with one verdict line over all batches, `slicc-unit-cover: PASS …` or `slicc-unit-cover: FAIL …` (the first failing batch stops the run and fails it; diff coverage then doesn't run). That keeps the coverage merge, which grows with the number of test files, small enough for a memory-capped hook on a widely imported file. A `--require` preload, which `slicc-unit-cover` and the shared `mcr.config.mjs` add to `NODE_OPTIONS`, makes the `node --test` process run the files on that list that its own patterns match, and none when the list is empty. Without the variable, `npm run test:unit` runs everything as before. In the hook the same preload bounds each test file's process (with the default `--test-isolation=process`; `none` runs no such processes, so nothing is bounded): every test gets `--test-timeout` (`SLICC_UNIT_TIMEOUT` ms, 60000 by default, `0` turns all of these bounds off), a file still running `SLICC_UNIT_TIMEOUT` ms after its tests ended (its top-level `after()` hooks get that long too) is ended, and a file whose event loop is blocked, or that has no test running and nothing finishing, for `SLICC_UNIT_TIMEOUT` + 5 s (one that hangs at top level, or a `before()` hook running that long) is killed; a test's own longer `timeout` is honoured. The FAIL verdict names each test that timed out and each file that was ended (`… was still running 60000ms after its tests ended, open handles kept it alive (TCPServerWrap)`) or killed, and such a file fails even when its tests passed. A value of either variable that isn't a whole number of milliseconds up to 2147483647 (the longest `setTimeout` delay) fails the hook before any test runs, rather than silently turning its bound off. Each `test:unit` run also has a wall-clock limit, `SLICC_UNIT_BATCH_TIMEOUT` ms (600000 by default, `0` for none): past it the run's whole process group is killed and the FAIL verdict names the batch and its files, which catches anything the per-file bounds miss, such as a test with an unlimited `timeout` of its own. To force a full run in the hook:

```sh
SLICC_UNIT_ALL=1 git commit
```
- Integration tests are committed and run in CI.

## Integration-test harness

`harness/` drives Chromium over raw CDP on `--remote-debugging-pipe`, as its only client, from `node --test`. Every page, service worker, shared worker and dedicated worker, nested ones included, starts paused, gets coverage (and the CPU profiler, when profiling is on) switched on in the same tick, and only then runs. Each test gets its own browser context and leaves `artifacts/<suite>/<test>/` behind: a screenshot per tab and a `console.log` of every target. Lines logged before the first test, such as an extension service worker's at startup, go into the first test's `console.log`. The global teardown merges the raw coverage into `coverage/` (console table, lcov, V8 HTML) and writes `artifacts/hotspots.md`.

CPU profiling is off by default. V8's sampler interrupts each page and worker thread every 100 µs with a signal, and the renderer SIGSEGVs in slicc-bios#114 all fault inside a signal handler walking the interrupted thread's frames, which points at it. Turn it on with `profile: true` or `SLICC_PROFILE=1` to get one CPU profile per target and snapshot in the test's artifact directory, and the 15 frames with the most self time in the repo's own scripts in `hotspots.md`. Without it, `hotspots.md` says that profiling is off.

`monocart-coverage-reports` is a peer dependency (2.13 or later, 3.x included); pin it in the repo's `devDependencies`. The harness works with both majors: 3.x's `/util` entry has only a named `Util` export and 2.x's a default one, and CI runs the recorder and the unit-cover hook on 2.13.2 and the latest 3.x. The browser is the first of these:
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
| `coverage` | URL prefixes whose `.js`/`.mjs` scripts count for coverage. `node_modules/` never does. A `.map` next to a file is used. `[]` collects nothing: without profiling, no target gets the debugger, the profiler, exit breakpoints or a `beforeunload` pause, and workers don't wait for the harness to start | `['/']` |
| `exits` | `{ urlPath: [regex, ...] }`: a breakpoint on the first line matching each pattern in that worker script, where the harness takes the worker's coverage and profile before it closes itself | none |
| `intercept` | Remote URL prefixes answered from a disk cache in `node_modules/.cache/`. Registry documents (anything on a `registry.*` host but a `/-/….tgz` tarball: packuments, abbreviated or full, and dist-tags) are fetched fresh once per test process and only served from the disk cache when the registry can't be reached (a `4xx` is passed on) | none |
| `extensions` | Unpacked extension directories to load. They are loaded with `Extensions.loadUnpacked` (behind `--enable-unsafe-extension-debugging`) once the harness is attached, so their service workers start paused like every other target. Their scripts are covered and profiled like the repo's own, and tests then run in the default browser context, closing their tabs when they end, because Chrome does not run extensions in the per-test contexts | none |
| `extension` | Load the [harness extension](#harness-extension). `false`, or `SLICC_HARNESS_EXTENSION=0` in the environment, leaves it out; any other value of either is an error | `true` |
| `persistent` | Run every test in the default browser context, on the launch's on-disk `slicc-harness-*` profile, instead of a fresh off-the-record context per test. Off-the-record contexts keep OPFS in memory, with a far smaller real budget than `navigator.storage.estimate()` reports, so a suite that stores hundreds of MB there needs this. When a test ends, its tabs are closed and `Storage.clearDataForOrigin` (`storageTypes: 'all'`) clears the server's origin, every origin a page in the context showed (popups the app opened included) and every origin the harness's tabs got a response from, so nothing leaks into the next test. If clearing fails, the test fails | `false` |
| `executable` | The Chromium binary. Without it, `$CHROME_PATH`, then slicc-cdp's `findBrowser()`, then playwright-core (see above) | found |
| `args` | Extra Chromium flags, such as `--host-resolver-rules` or `--ignore-certificate-errors` | none |
| `timeout` | How long `page.until` polls and `page.evaluate` waits, in ms | `30000` |
| `stallAfter` | How long one evaluation may run before the harness probes the test's targets, in ms | `30000` |
| `profile` | Record a CPU profile of every target, sampled every 100 µs | `true` if `SLICC_PROFILE=1`, else `false` |
| `realistic` | Run Chrome as a user would: headed, and without `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`, so a tab behind another one is hidden and throttled. For measuring background tabs. It needs a display: on CI, run the tests under `xvfb-run -a` | `false` |

`chrome.page(t)` opens a tab and returns the page API: `goto(path)`, `reload()`, `evaluate(fn, ...args)`, `until(fn, ...args)`, `press(key, ...modifiers)` (a key name like `Enter` or `F5`, or a single character typed with its US-layout key code), `type(text)`, `insert(text)`, `enter()`, `init(fn)` (runs in every new document), `expose(name, handler)` (a binding the page calls with a JSON string), `screenshot(file)`, `tab()` (another tab in the same context), `close()`, `send(method, params, ms)` (a raw CDP call in the tab's session), `errors`, `responses` and `dir` (the test's artifact directory). `chrome.pid` is the browser's process id and `chrome.profile` its `slicc-harness-*` profile directory in `$TMPDIR`. `goto` and `reload` wait until the new document is complete and no longer `about:blank`, and retry the navigation once if that never happens. `until` polls until the function returns a truthy value (not only strict `true`) and resolves with that value; the timeout error names the last result. `within(ms, fn, ...args)` is `until` with its own deadline, for a stage that should take a known time. `run(fn, ...args)` or `run(options, fn, ...args)` is for a job that may outlast the `timeout`: it starts `fn` in the page without holding a `Runtime.evaluate` open, then polls it every `everyMs` (1 s) with short evaluates, and resolves or rejects with the job's own result. It decides slow from hung by progress, not by the clock. Progress is a change in `marker` (a function run in the page at each poll, such as `() => window.done`) or in what `progress` returns (an async function run in Node, such as a probe of a process tree's CPU time). With either one set, a job whose progress stays the same for `quietMs` (60 s) fails with `<label>: no progress for N s after M s`, the last marker and progress values, and the page's pending requests and navigations. `maxMs` (30 min) is the outer bound for a job that keeps moving but never ends. Without a `marker` or `progress` only `maxMs` applies. `label` defaults to the start of `fn`'s source. The job's value must survive `returnByValue`, as with `evaluate`. Both stop at the deadline even if one evaluation never answers. Every CDP call has a deadline: `connect(url).send(method, params, sessionId, ms)` rejects with `<method>: no answer in <ms> ms` (60 s unless given), so a stuck page fails its test instead of hanging the run. A crash fails it at once instead:
- when the browser dies, every pending and later call rejects with `<method>: browser exited with <signal>` (or `with code <n>`);
- when a renderer crashes, every pending and later call to that target, and to the dedicated workers it started, rejects with `<method>: page renderer crashed (<status>, code <n>) at <url>` (or `worker`, `shared worker`, `service worker`), and `console.log` gets the same line. A service worker that Chrome stops and starts again reports `Inspector.targetCrashed` and then `Inspector.targetReloadedAfterCrash`: its calls work again from the restart on, it isn't called crashed when it restarts within 200 ms, and the harness runs its held start in each session of its own, so the restarted worker doesn't stay paused at start;
- `until`, `within`, `goto` and `reload` stop retrying and rethrow it;
- both errors end with the last five lines of the browser's stderr, and each test keeps up to 200 lines it wrote during the test in `chrome-stderr.log`.
- a test that saw a renderer crash, or a browser that died of anything but `SIGKILL`, keeps Chrome's minidump of it as `<id>.dmp` in its artifact directory (see [Crash dumps](#crash-dumps)).

`chrome.cdp` is the browser's own pipe, the one the harness already drives, with no session of its own: test-only, unguarded access that bypasses everything a product guard would do, and never for product code. `send(method, params, sessionId, ms)` makes a raw call at browser level, or in any session the browser has (the harness's auto-attached ones included), and rejects with `<method>: no answer in <ms> ms` after the caller's `ms` (60 s unless given); a protocol error rejects with the message and keeps the error object as `error.cdp`. `on(listener)` receives every event the browser sends, as `{ method, params, sessionId }`, until `off(listener)` or the function `on` returned. `waitEvent(method, predicate, ms)` resolves with the next matching event (call it before the action that causes the event); the predicate is optional, a predicate alone works too (`waitEvent(predicate, ms)`), and it rejects after `ms` (10 s unless given). `events` is an append-only array of every event since it was first read. That is the `{ send, waitEvent, events }` client the guard runner of `@ai-ecoverse/slicc-browsers` takes, so `run(set, { client, unguarded: chrome.cdp, … })` gives it the unguarded observer that 14 of its vectors need.

 When one evaluation runs past `stallAfter`, the harness probes once, without interrupting the wait:
- it adds a `pending` line to `console.log` for every navigation and request of the page that has no answer yet, with its age. A worker's script loads in the worker's own session, so its request is left out. Chrome holds CDP messages to a page while a navigation is waiting for its response, so an evaluation that hangs while the page is idle usually means one of these;
- it saves `stall-<n>.png` (a screenshot of the page, if the renderer still answers) in the test's artifact directory;
- when profiling is on, it saves a CPU profile sample of every page and worker in the test, including workers started by other workers, as `stall-<n>-<target>-<session>.cpuprofile`;
- it adds a line per target to `console.log`, saying whether that target is running or paused;
- on the first stall, it records a 10 s browser trace as `stall-1-trace.json` (open it in DevTools' Performance panel or Perfetto). The browser collects it with V8 CPU samples per thread, task, IPC, Blink and loading events, so it shows what a page's main thread is doing even when that thread no longer answers CDP. It logs each process's CPU time over the window, and for each renderer its main thread's task count, the call chain of its longest or still open task (function, file, line and URL of a request), and where its CPU samples fall. The targets are sampled after the trace starts, so their new profiles carry their call frames into it. A call that started before the trace shows only as a node id, since its frames were named before; a thread that is blocked keeps `Tracing.start` waiting, which the harness logs and traces through;
- the summary runs in the test process, which also serves the page's files and talks CDP, so it is linear in the trace's events: a busy page's half-million-event trace takes well under a second, and the page's fetches keep getting answers meanwhile;
- it adds a line for every debugger pause still held in the browser, in any target, with its id, URL, start time, reason and top call frames.

Coverage is kept as one entry per script URL, each worker's counts summed into it as the worker's coverage is taken, so a run of thousands of workers keeps no more than its distinct scripts. A worker paused at its exit breakpoint is resumed as soon as its coverage and profile are taken; the profile is written to disk after. A pause in one target blocks every page in the same renderer process, so those pause lines name the culprit even when it isn't the page under test. The harness resumes its own coverage pauses (`beforeunload`, worker exits) within 10 s, even when collecting coverage fails. Any other pause in a session of its own, such as a `debugger;` statement, it resumes too, unless a test debugs that target in a session it attached itself (with `Target.attachToTarget` on `chrome.cdp`, say, and `Debugger.enable`): then that pause stays held for `Debugger.evaluateOnCallFrame` until the test resumes it. The harness never resumes a session the test attached, nor a start the test holds with its own `Target.setAutoAttach` and `waitForDebuggerOnStart`, sends it no commands and takes no coverage, console lines or profiles from it. Downloads of intercepted URLs time out after 60 s and are tried up to three times; a `4xx` is not retried. `chrome.requests` lists the paths the server saw in this test, `chrome.overrides` is a `Map` of paths to bodies served instead of files, and `chrome.cdn` takes `status` (answer every intercepted request with it), `corrupt` (flip the last byte) and lists the intercepted `requests`. All of them reset with each test. `serve(options)` starts the same server on its own, for an `npm start`.

Why it works the way it does:

- Playwright detaches from shared workers, which resumes them early, so their coverage started late about half the time. Raw CDP keeps every worker paused until the profiler runs.
- `debugger;` pauses in `beforeunload` but not in `pagehide` or `pageswap`, so a `beforeunload` hook, installed after `Page.enable`, takes the coverage of a page before it navigates. The pause only answers CDP when the page itself starts the navigation, so `goto` and `reload` go through `location`, never `Page.navigate` or `Page.reload`; they schedule it with `setTimeout` in an isolated world of the page (so page code that replaces its timers can't stop it), so the `Runtime.evaluate` that starts it answers before the old document goes, which otherwise loses the race on a slow runner ("Inspected target navigated or closed"). Navigating away from `about:blank` skips the coverage dump so the first real load is not held in `beforeunload` for a useless snapshot.
- `goto` used to return as soon as the document swapped (`window.stale` cleared), which is before `readyState` is `complete` and before module scripts run. About 1 load in 20 then looked blank to the next assertion. It now waits for a complete, non-blank document.
- `takePreciseCoverage` resets the counters, so every snapshot is a delta, and all of them are kept and summed.
- monocart's `add()` from parallel test processes loses data, so each test writes raw JSON and the teardown merges it once.
- Coverage of a script served from `chrome.overrides` would be mapped onto the file on disk, so a path overridden during a test is left out of that test's coverage.
- A CI cache restored with a prefix key kept packuments from before a release, so pnpm in the page saw an outdated `latest` and failed with `ERR_PNPM_NO_MATCHING_VERSION`. Tarballs and versioned CDN files never change and stay cached forever; registry documents do change, so the disk copy is only the offline fallback.
- An unscoped packument cached at `registry.npmjs.org/<name>` sat where the tarball directory `registry.npmjs.org/<name>/-/` goes, so saving one after the other failed with `EISDIR` and pnpm in the page saw `ECONNREFUSED`. Registry documents are now cached as `<path>/index.json`; a file left at the old place is a miss and is removed when something needs its place.
- `--disable-component-extensions-with-background-pages` keeps a Hangouts service worker out of every run, and the fresh profile has no other extension. A launch with no extension at all keeps `--disable-extensions`. No extension goes on the command line (`--load-extension`, `--disable-extensions-except`): every extension, the harness's and a test's, loads once, through `Extensions.loadUnpacked`, because a second load gives an extension two service workers and drops its first runtime port. Once they are loaded, `launch()` fails if any target belongs to an extension it did not load.
- The attach event can arrive before `Target.createTarget` returns, so new tabs wait on a slot keyed by target id.
- A worker blocked in `Atomics.wait`, or one that is already gone, may never answer; snapshots give up after 3 s, and closing a context or the browser after 10 s. A call to a target that detaches or crashes fails instead of waiting forever, and a new tab that never attaches fails after 10 s.
- A WebSocket that has closed takes new messages without an error, and a crashed target never answers, so after a crash every call used to wait out its own deadline: a browser that died 4 s in showed up as `no answer` 15 minutes later. The harness now remembers the crash or the exit and fails each call with it.

## Harness extension

Real users run content-script extensions, such as password managers and Grammarly, and each one adds an isolated JavaScript world with origin `chrome-extension://<id>` to every frame of every page. Over raw CDP, `Runtime.executionContextCreated` reports it as `{ origin: 'chrome-extension://<id>', auxData: { isDefault: false, type: 'isolated' } }`. slicc-cdp#377: bios's guard took that world for a protected page and refused everything, and CI never saw it because the harness's Chrome had no extension. So every browser `launch()` starts now carries one by default.

`harness/extension/` is an MV3 extension with no permissions, only a content script on `<all_urls>`, in all frames, at `document_start`. It sets `data-slicc-harness-extension="<id>"` on `document.documentElement`. On a page whose URL has the query flag `slicc-extension-frame` (`/?slicc-extension-frame`), it also adds a hidden `<iframe>` of its own `chrome-extension://<id>/frame.html` to the top frame, for testing extension-origin frames. Its manifest has a fixed `key`, so its id is always `ankmbodmgimjemnojmeddfcdlbocolob`, exported as `EXTENSION_ID` (and its directory as `EXTENSION_PATH`) from the harness. `chrome.extension` is `{ id, path }` for a launch that loaded it and `null` for one that didn't, so a test can assert either.

Chrome gets `--headless=new`, which runs extensions, and `--enable-unsafe-extension-debugging`. Once attached, the harness loads the extension directory with `Extensions.loadUnpacked` and `enableInIncognito: true`, so it runs in the default context and in the off-the-record context each test gets, and tests stay in their own contexts. If it loads with any other id, or not at all, `launch()` fails rather than going on without it. Its script is not counted for coverage.

A lane that can't have it opts out explicitly, in one of two ways:
- `launch({ extension: false })`, for one launch;
- `SLICC_HARNESS_EXTENSION=0` in the test process's environment, for every launch. `1` or unset loads it; any other value is an error, so a typo never turns it off.

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
