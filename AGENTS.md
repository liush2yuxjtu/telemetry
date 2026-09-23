<!-- verify-shift-left:start -->
## Pre-PR verification

Use /verify skill every time BEFORE we make a PR

- Canonical skill source: `liush2yuxjtu/claude-runtime-verification-skills@0d585c02bbeaa756e45865dd0a36f84d1b08f589`.
- Run relevant existing tests locally through `/verify` before PR creation.
- Keep test files in the repository; shift their execution left instead of deleting coverage.
- Preserve remote CI only for checks that genuinely require remote, production, deployment, secret, runner, or environment-specific execution.
- Do not open a PR on `FAIL` or `BLOCKED`. `SKIP` is only valid when the skill says no executable runtime behavior applies.

<!-- verify-shift-left:end -->

<!-- vercel-deploy-budget:start -->
## Vercel deploy budget

Every push to `main` triggers a billed Vercel production build. Preview deployments are disabled for this project, so branch pushes do not build on Vercel.

- Batch work: do not push to `main` after every small change. Collect related commits on a branch and land them in one squash merge.
- Do not push doc-only or agent-config-only changes (`*.md`, `.agents/`, `.claude/`) to `main` on their own; let them ride with the next real code change.
- Do not run `vercel deploy` or `vercel --prod` unless the user explicitly asks for a deploy.
- If a production build fails, reproduce and fix it locally with `/verify` before pushing again. Never push repeatedly just to see whether the Vercel build passes.
<!-- vercel-deploy-budget:end -->
