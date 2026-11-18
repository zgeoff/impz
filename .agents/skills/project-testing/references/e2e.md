# End-to-end journeys

A journey is one file in [`packages/daemon/e2e/`](../../../../packages/daemon/e2e/), named
`<kind>-<journey>.test.ts`, where `<kind>` is one of the testing skill's e2e prefixes, such as
`journey` or `enforce`. The harness runs it as its own `bun test` process against one
[dev instance](../../../../scripts/dev/dev.sh). A suite in
[`suites.ts`](../../../../packages/e2e-harness/src/suites.ts) lists the journey's name in its
`journeys`, and the harness finds the file by the name after `<kind>-`. The
[development runbook](../../../../docs/runbooks/development.md#end-to-end-tests) owns how to run the
harness, [`scripts/test-e2e.sh`](../../../../scripts/test-e2e.sh), and its flags.

The traps:

- Start the name of everything the journey makes with the suite's name prefix, its `prefix` field.
  The harness removes only what carries it.
- When a journey changes impd's settings, put them back in the journey. The next journey runs on the
  same instance.
- Before you run a journey alone, run its suite once through `scripts/test-e2e.sh --only <suite>`. A
  journey you run alone gets no reset before it and no fixture image build.
- A burst of connections, a long socket path or an exec during an idle wait each fail a journey in a
  way that looks like an impd bug. [Guest and host facts](#guest-and-host-facts) gives the fix.

## Contents

- [Suite fields](#suite-fields)
- [Writing a journey](#writing-a-journey)
- [Guest and host facts](#guest-and-host-facts)
- [Around each journey](#around-each-journey)
- [The baseline reset](#the-baseline-reset)
- [Sets, groups and acceptance](#sets-groups-and-acceptance)
- [Timing limits](#timing-limits)
- [Resources outside the instance](#resources-outside-the-instance)

## Suite fields

| Field      | Holds                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `prefix`   | the start of every name the suite's journeys make, such as `e2e-mv-`                                  |
| `images`   | the fixture images the suite needs: images the harness builds once per run, such as `e2e-tiny`        |
| `journeys` | the journey names, in run order                                                                       |
| `fixtures` | the extra hosts the harness starts for the suite, such as `host-b`, a second impd that a move goes to |
| `settings` | the impd settings, by `IMP_*` variable, the harness reboots the instance onto for the suite           |

## Writing a journey

1. Copy `setupTest()` from a journey of the same suite, or of any suite when you add a suite. It
   creates an `AsyncDisposableStack`, registers its disposal with `onTestFinished`, and returns the
   stack, a client for the instance, and the suite's name prefix from `getSuitePrefix`. Each test
   binds the result to `const ctx`.
2. Start the name of each imp, network, secret, OAuth client, token, image and template the journey
   makes with the name prefix.
3. Register the removal of each one with
   [`registerRemoval`](../../../../packages/e2e-harness/src/register-removal.ts), directly after the
   call that makes it. The stack runs removals in reverse order, so an imp goes before the template
   it boots and the network it joins.
4. Remove anything the baseline reset leaves, such as a registry container or an SSH key, with
   `ctx.stack.defer`.
5. Put a setting that every journey of the suite needs in the suite's `settings`. For a setting only
   one journey needs, import `runDevScript` and `instance` from `@impz/e2e-harness/instance`. Call
   `runDevScript('reboot', instance, { IMP_IDLE_TIMEOUT_S: '5' })` in the journey, with the `IMP_*`
   variables it needs. Then defer a reboot back onto the suite's `settings`, or a bare
   `runDevScript('reboot')` when the suite has none.

When you pass `--keep` to the harness, `registerRemoval` registers nothing, so the imps and images
stay for a look after the run. A removal you defer on the stack yourself still runs.

## Guest and host facts

- A burst of connections past a guest server's accept backlog leaves connections that the guest
  agent opened and the server never accepted. The guest kernel drops them about 17 s later, and
  `impz proxy` reports a lost connection. For a journey that holds many connections, use an echo
  server, and prove each connection with a round trip before you open the next.
- A unix socket path holds at most 107 bytes, and a session's `TMPDIR` alone can pass 80. Put the
  socket of an ssh-agent, or of an SSH unix-socket forward, in a directory under `/tmp`, as
  `startLocalSshAgent` in [`ssh.ts`](../../../../packages/e2e-harness/src/ssh.ts) does.
- To prove that something keeps an imp awake past its idle timeout, use
  [`waitAwakePastIdle`](../../../../packages/e2e-harness/src/awake-past-idle.ts). Run no exec in the
  imp while it waits: impd counts an exec as activity.

## Around each journey

- Before the first suite, the harness resets the baseline for every suite and builds each fixture
  image that impd lacks.
- After each journey, the harness resets the baseline for the suite's prefix. After a failed
  journey, it first reboots the instance onto the suite's settings.
- When that reset or reboot fails, the suite fails. The harness recreates the instance, and the
  suite's next journey runs on the new one. When the recreate fails, the run stops.
- When the `scale` suite passes, the harness skips its reset. The `restart` suite then runs on the
  imps and settings that `scale` left, and checks that impd adopts those imps again. No other suite
  carries state to the next.

To run one journey file alone, use the "One end-to-end journey" command in
[the skill](../SKILL.md#commands-and-what-they-need). The journey runs on whatever the instance
holds. The e2e preload keeps the shell's `IMP_*` variables, so a reboot in the journey takes the
shell's `IMP_RAM_BUDGET_MIB` and `IMP_IDLE_TIMEOUT_S` in place of the harness's values.

## The baseline reset

The baseline reset removes each imp, network, secret, OAuth client, token, image and template whose
name starts with the suite's prefix. It also deletes `broker-test-upstreams.json` from the
instance's data dir; a journey writes that file to point the broker at its test servers. First the
reset aborts any move a failed journey left open, because impd refuses to remove an imp in the
middle of a move. When impd refuses a removal, the reset fails.

The reset leaves these alone:

- The instance's settings.
- A registry container or an SSH key that a journey made.
- A fixture image. Its name holds a hash of its sources, so a changed fixture image builds anew and
  an unchanged one stays.

## Sets, groups and acceptance

The `acceptance` set is every suite. The `fast` set is the subset that CI runs, split into groups,
one per CI job, each with its own instance.

- `FAST_GROUPS` in [`suites.ts`](../../../../packages/e2e-harness/src/suites.ts) holds the groups.
- The `e2e-group` matrix in [`ci.yml`](../../../../.github/workflows/ci.yml) runs one job per group.
- [`suites.test.ts`](../../../../packages/e2e-harness/src/suites.test.ts) lists each set's suites,
  and checks that each suite sits in one group at most, that the groups make up the `fast` set, and
  that `ci.yml` runs each group.

When CI should run a new suite, add it to a group in `suites.ts`, and to the `fast` set's list in
`suites.test.ts`. Change `ci.yml` only when the number of groups changes. A suite outside every
group runs only in `acceptance`.

## Timing limits

A journey checks a measured duration against a limit with
[`checkLimit`](../../../../packages/e2e-harness/src/check-limit.ts). An overrun prints a warning. In
a run that includes `acceptance`, an overrun fails the journey.

## Resources outside the instance

Touch a resource outside the instance only when the journey can prove it made the resource. For a
new one, write an owner file beside it, as the `registry` suite does. The harness's own checks:

- When the harness resets an instance, it deletes the instance's data dir as root.
  [`wipe-target.ts`](../../../../packages/e2e-harness/src/wipe-target.ts) decides which data dirs
  and ZFS roots it may delete.
- The `registry` suite marks Docker's per-registry certificate directory with an owner file, and
  removes a stale directory only when that file's process is gone.
- The `boot-templates` suite drops the machine's caches and sets `primarycache` on the ZFS root only
  when `E2E_OWNS_ZFS_HOST=1`. Set that variable only where the run has the machine and the ZFS root
  to itself. The `zfs-shard` job in `ci.yml` sets it.
- A tailnet journey joins as `tag:imp-e2e`, never `tag:imp`, so a test node cannot reach a live
  impd. When the run's suites need Headscale, as
  [`pick-run-tailnet.ts`](../../../../packages/e2e-harness/src/pick-run-tailnet.ts) decides, the run
  starts Headscale in a container, and a second container that joins it as a tailnet member. A
  journey reads that member with `readTailnetMember`, and reaches the tailnet through it, never
  through this machine's own tailscaled.
