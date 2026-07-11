---
description: Commit everything on disk to main, push, and validate the deploy goes green
argument-hint: [optional commit message]
allowed-tools: Bash(git status:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(gh auth status:*), Bash(gh run list:*), Bash(gh run watch:*), Bash(gh run view:*)
---

Ship every change on disk to production `main` and confirm the deployment passes.

## How shipping works in this repo
- Push to `main` → the **CI** workflow runs (typecheck / lint / test / 500-game sim, then Playwright **e2e**).
- When **CI** succeeds on `main`, the **Deploy** workflow (`workflow_run` trigger) fires and deploys to Fly.io. It *gracefully skips but still concludes `success`* if `FLY_API_TOKEN` is unset.
- So **"deployment passes" = the CI run AND the Deploy run for this exact commit both conclude `success`.**
- Convention (CLAUDE.md): commit straight to `main`, never a branch or PR.

## Current state (auto-collected)
- Branch: !`git rev-parse --abbrev-ref HEAD`
- Working tree: !`git status --short`
- Unpushed commits: !`git log --oneline @{u}..HEAD 2>/dev/null || echo "(no upstream tracking configured)"`

## Steps — do these in order; stop and report if any step fails

1. **Preflight.**
   - The branch must be `main` (this repo deploys only from `main`). If it isn't, stop and tell the user — do not switch branches for them.
   - Confirm `gh auth status` is authenticated. If not, stop and ask the user to run `! gh auth login`.

2. **Commit everything on disk.**
   - If the working tree has changes: `git add -A`, then show the user `git status --short` of what's staged.
   - Commit message: if `$ARGUMENTS` is non-empty, use it verbatim. Otherwise write a concise, conventional message that summarizes the staged diff (`git diff --cached --stat` + a look at the changes). End the message with this repo's standard commit trailers (`Co-Authored-By` / `Claude-Session`).
   - If the tree is clean but there are unpushed commits, skip committing and continue.
   - If the tree is clean AND nothing is unpushed, report "nothing to ship" and stop.

3. **Push.** `git push origin main`. Then capture the shipped commit: `git rev-parse HEAD` (call it `SHA`).

4. **Validate CI.**
   - Find the CI run for `SHA`:
     ```
     gh run list --workflow=CI --branch=main --limit=20 \
       --json databaseId,headSha,status --jq 'map(select(.headSha=="SHA"))[0].databaseId'
     ```
     GitHub takes a few seconds to register the run after a push — if this comes back empty, just call it again (2–3 tries). Don't use `sleep`.
   - Watch it to completion: `gh run watch <CI_ID> --exit-status`. CI + e2e can take 20–40 minutes, so **run this in the background** (`run_in_background: true`) and let it re-invoke you on exit. A non-zero exit means CI failed → run `gh run view <CI_ID>` (and `--log-failed`) to see which job broke, report it, and stop.
   - **Flaky-test note:** the server `test/chaos.test.ts` soak test is timing-sensitive and occasionally times out (~100s) under CI load — a failure there does **not** mean the pushed commit is broken. If that (or another clearly-flaky, unrelated test) is the only failure, tell the user and offer to re-run CI with `gh run rerun <CI_ID> --failed` (a green re-run then triggers Deploy) instead of reporting the change as broken.

5. **Validate Deploy.**
   - Once CI is green, find the Deploy run it triggered:
     ```
     gh run list --workflow=Deploy --event=workflow_run --limit=20 \
       --json databaseId,headSha,status,createdAt --jq 'map(select(.headSha=="SHA"))[0].databaseId'
     ```
     The `workflow_run` trigger lags CI completion by a bit — retry a few times if empty. If a Deploy run never appears after CI success, report that Deploy didn't trigger and stop.
   - Watch it: `gh run watch <DEPLOY_ID> --exit-status` (background again). Non-zero = deploy failed → `gh run view <DEPLOY_ID> --log-failed`, report, and stop.

6. **Report success.** Give the user:
   - the shipped commit SHA + subject,
   - the CI and Deploy run URLs (`gh run view <id> --json url --jq .url`),
   - whether Deploy actually deployed to Fly.io or merely skipped (no `FLY_API_TOKEN`), and
   - that production (https://huutopussi.online/) is updated.
