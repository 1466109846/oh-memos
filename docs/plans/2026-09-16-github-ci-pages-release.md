# GitHub CI and Architecture Pages Release Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Push all pending project code to `1466109846/oh-memos` and verify successful CI, Docker publishing, and the architecture page linked by the READMEs.

**Architecture:** Retain the existing Node, Python, Docker, and GitHub Pages workflows. Repair their confirmed checkout/dependency issues, point current repository links at the requested owner, and publish the static architecture assets under `/oh-memos/architecture/` through Actions Pages.

**Tech Stack:** GitHub Actions; Node.js 20/22; TypeScript 5 and Vitest 3; Python 3.11 and pytest 8; Docker Buildx; static GitHub Pages.

## Evidence and authorization

- The user explicitly requested committing and pushing all current code to the existing origin, with working CI and the architecture page.
- `origin` is `https://github.com/1466109846/oh-memos.git`; its default branch is `main` and the current account has admin access.
- The current feature branch is four commits ahead of `origin/main`, with no divergence, plus the pending 3.1.9 implementation and configuration changes.
- Remote CI run `33873407997` failed on Node 20 and 22 because the README generator test assumes the checkout uses CRLF.
- New confirmed-vector tests import `qdrant_client`, which the CI base installation currently omits.
- The architecture artifact layout is already correct, but GitHub Pages is not configured for this repository, and current links still reference the previous owner.
- The untracked root `NUL` is an incidental Windows device-name artifact, not project code. Existing ignore rules exclude credentials, memory data, and packaged binaries.

## Task 1: Reproduce and repair the CI contracts

**Files:** `mcp-server-node/src/readme-changelog.test.ts`, `scripts/generate-readme-changelog.mjs`, `.github/workflows/ci.yml`, `.gitignore`.

1. Reproduce the README test failure in a clean LF snapshot without local environment files.
2. Exercise explicit LF and CRLF inputs and verify replacement preserves their line endings and surrounding text.
3. Correct the generator comment to describe checkout-dependent line endings.
4. Install the Qdrant client explicitly for Python contract tests and retain the intended pytest major version.
5. Ignore only the incidental root `NUL` artifact; retain all source, tests, and documentation.

## Task 2: Align repository links and Pages deployment

**Files:** both root READMEs, MCP README/package metadata, `pyproject.toml`, architecture HTML/JSON, `.github/workflows/deploy-architecture.yml`.

1. Update current repository, issue, workflow badge, clone, and Pages URLs to `1466109846` while retaining historical changelog records.
2. Make README changes trigger the existing architecture deployment and retain the `architecture/` staging directory.
3. Record the CI fixes in the changelog and regenerate both README summaries.
4. Configure this repository to publish GitHub Pages through Actions.

## Task 3: Verify, commit, and push

1. Run hook matcher, deploy-hook synchronization, and README generation checks.
2. Run the Node build, full Vitest suite, both protocol harnesses, schema budget/semantic checks, and package boundary check in a clean checkout.
3. Run all offline Python contracts, excluding only the existing live API integration files.
4. Review the full pending diff and receive an independent code review.
5. Commit all intended source/tests/docs, fast-forward `main`, and push without force.
6. Follow CI, Docker publishing, and architecture deployment for the exact pushed commit; repair any observed failures and verify the resulting runs.
7. Fetch the public architecture page and its HTML/JSON assets, confirm the README target is accessible, and save the result through project MCP.

## Validation commands

```sh
node scripts/lint-hook-matchers.mjs
node scripts/sync-deploy-hooks.mjs
node scripts/generate-readme-changelog.mjs
```

From `mcp-server-node`: `npm ci`, `npm run build`, `npm test`, `npm run test:protocol`, `npm run schema:budget`, `npm run schema:semantic`, and `npm run test:pack`.

Python: `pytest -q tests/ --ignore=tests/test_search_project.py --ignore=tests/test_graph_data.py`.

Final public endpoint: `https://1466109846.github.io/oh-memos/architecture/`.
