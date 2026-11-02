---
name: project-ci-design
description:
  "imp's test budget and required checks, the one ci-design rule it replaces (its own CI workflows
  in place of bun-checks.yml), and how a new job becomes a required check. Load it beside ci-design
  before you add or change a workflow, a job or a step in this repo."
metadata:
  kind: rule-set
---

# imp CI design

## Facts

| Fact            | Where                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test budget     | 3 min                                                                                                                                                                               |
| Required checks | the `required_status_checks` rule in [`.github/rulesets/main.json`](../../../.github/rulesets/main.json); `gh api repos/zgeoff/impz/rules/branches/main` shows what GitHub enforces |

## Departures

- Add each CI job to one of imp's own workflows in
  [`.github/workflows/`](../../../.github/workflows/): most often
  [`ci.yml`](../../../.github/workflows/ci.yml), or [`nix.yml`](../../../.github/workflows/nix.yml)
  when the job runs `nix`. The Jobs section of [ci-design](../ci-design/SKILL.md) has the repo call
  `bun-checks.yml` and add CI work as a package script, but that workflow has no input for what
  imp's jobs need: KVM for the microVM suites, Docker, Go, root for the host networking lane, and a
  ZFS pool.

## The required checks

- Match each ruleset entry to the check name that GitHub shows: the job's `name:`, or its id when it
  has none. The workflows call these jobs the gates, and no gate sets a `name:`.
- Rename a gate and its ruleset entry in the same pull request. Otherwise GitHub waits for a check
  that never reports.
- Add new test work to a job that a gate already waits on, when one runs the same kind of work: a
  unit shard to `checks-unit`, a lane to `checks-lanes`, a VM suite to an `e2e-group` row, or a ZFS
  suite to a `zfs-shard` row. The `checks`, `e2e` and `zfs` gates need those jobs, so the work needs
  no new ruleset entry.
- When a gate waits on other jobs, give it `if: always()` and a step that fails unless each job it
  needs has the result `success`, as `checks` does.
- When a new job must be a gate of its own, add its check name to the ruleset in the same pull
  request.
- Put a job that runs only on `main` below the gates in `ci.yml`, with
  `if: github.event_name == 'push'`, as `release` does.
