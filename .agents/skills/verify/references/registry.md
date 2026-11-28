# The verify registry

The registry, [`create-verify-registry.ts`](../../../../scripts/verify/create-verify-registry.ts),
takes its globs from two files. When SKILL.md says to add a glob to a feature's `paths`, to
`.shared()` or to `.ignore()`, add it to one of the lists in these files:

- [`feature-paths.ts`](../../../../scripts/verify/feature-paths.ts) holds `featurePaths`, each
  feature's `paths`; `sharedPaths`, which the registry passes to `.shared()`; and `ignoredPaths`,
  which it passes to `.ignore()`.
- [`core-paths.ts`](../../../../scripts/verify/core-paths.ts) holds `corePaths`, which every feature
  on `local` holds.

Write each glob relative to the repo root. Edit the rest of a feature, such as its name and summary,
in `create-verify-registry.ts`.

## Features on `local`

`featurePaths` builds the `paths` of each feature that runs on `local` from these lists:

- `corePaths`, the packages and globs that every journey on `local` runs: the `local` app in
  `packages/testing`, the API contract, the client, and the parts of impd that create, list, sleep
  and destroy an imp. It also holds each file that impd reads but that you can't trace to a journey.
  Each entry has a comment on why it is there.
- the feature's `packages`, each a package folder that its journey runs whole, such as
  `packages/cli`. List only the folder: `feature-paths.ts` adds the folder of each workspace package
  it depends on at run time, from each `package.json` as it loads.
- the feature's `paths`, the globs for the parts of a package that its journey runs, such as the
  event routes in `packages/daemon`. List only the globs: `feature-paths.ts` adds the folders of
  that package's workspace dependencies itself, as for a package in `packages`.

When `feature-paths.ts` adds dependency folders, it never adds a package that `corePaths` splits
into globs, such as `packages/daemon`, as a whole folder. It also never adds `packages/mcp`: the CLI
and impd import it at start, but only an MCP journey calls it. Name `packages/mcp` in the `packages`
of each feature whose journey calls an MCP tool.

A journey reaches a path when its actions, its reads or the CLI commands it runs run that path. impd
loads every route and the MCP server at start, and `bun verify doctor` runs before every journey,
but neither puts a path in a feature. A change that breaks the start still fails each journey that
the change flags.

## Features on a real VM

A feature that runs on `local-kvm` holds the `vm` list in `feature-paths.ts` and the impd folders of
its own journey, such as `packages/daemon/src/imps/exec/` for an exec. The `vm` list holds what a
stand-in VM never runs, such as the guest agent, the kernel and the image a journey boots. Its
journey runs the rest of impd too, but a change to the rest of impd gets its verdict from the
features on `local`, which start in seconds where a real VM takes over a minute.

## Add a path

1. Put each path in the list for the journeys that reach it:
   - Add a path that one journey or a few reach to the `packages` or `paths` of those features.
   - Add a path that every journey on `local` reaches to `corePaths`, with a comment on why.
   - Add a file that impd reads, but that you can't trace to a journey, to `corePaths`. An extra
     journey run costs less than a missed feature.
   - Add a path that only a real VM runs to the `vm` list.
   - Add a file that the running app never reads, such as a test or a test helper, to
     `ignoredPaths`. `bun verify gate` never asks for a verdict on a change to an ignored file, even
     when a feature's glob matches it too.
   - Add a verify helper that `bun verify up` runs to `sharedPaths`.
2. For each glob you add to `corePaths`, a feature or `sharedPaths`, check that an entry in
   [`skill-gate.json`](../../../../.claude/skill-gate.json) matches it, such as
   `{ "match": "packages/cli/**", "skills": ["verify"] }`. With the entry, the skill-gate hook
   blocks an edit to a matching file until the agent loads this skill. The hook is a separate check
   from `bun verify gate`. For a glob you remove, delete an entry that only it used.
3. Run `bun run test scripts/verify/feature-paths.test.ts`. Expect: the test passes. It fails when:
   - a tracked file that a feature or `sharedPaths` holds matches no `verify` entry in
     `skill-gate.json`;
   - a sample file flags other features than the test expects;
   - a tracked file matches no feature, shared or ignore glob.

   Fix the glob or the entry named in the failure, and run the test again. When you move a path on
   purpose, change the features that the test expects for its sample file.

4. Run `bun verify lint`, and fix each failure it reports.

Put the features and the globs in any order. A changed file that no ignore glob matches counts for
every feature whose glob matches it. The order of the features sets only the row order of
`bun verify features` and the report.

After you add a feature, write its file under `references/`, and run the steps in
[Edit the skill and the registry](../SKILL.md#edit-the-skill-and-the-registry).
