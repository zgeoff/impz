# Lifecycle bench results

Each table compares two builds of impd that ran on one CI runner, their rounds in turn, the baseline
first in each round. A cell holds the median of a side's 2 rounds, and the change is against the
baseline. The failed columns count the steps that failed over both rounds, including the steps that
arrange a sample, such as the create and sleep before a wake. A level whose samples mostly failed
has few latencies left, so its change is no measure of either build.

## Setup

Every run is on a GitHub-hosted `ubuntu-24.04` runner with nested KVM, 4 vCPUs and Linux
7.0.0-1017-azure. impd runs in a dev instance on XFS with Firecracker v1.17.0, guest kernel 6.1.188,
a RAM budget of 12,288 MiB, 4 KiB guest pages, and KSM off. The bench creates each imp with 256 MiB,
takes 20 samples at each of the concurrency levels 1, 4, 16 and 64, and runs create, wake and
restore. A restore restores an awake imp to a checkpoint. In these runs, the first round of each
level woke imps that had just been created and slept once, and each later round woke imps that had
woken before. At concurrency 16, half of the wakes are first wakes after a create, and at 64, with
one round, all of them are. The bench now wakes and sleeps each new imp once before its first timed
wake, so a later run times only wakes after an earlier wake. Before each side's timed run, 3 creates
of the same size warm its boot template.

Each run lands on whichever runner GitHub assigns, so its CPU differs. The reuse and tick runs
predate the fix that makes impd wait for Firecracker's API socket to listen, so their level 64 still
shows the failures that the socket race caused.

| Run           | Baseline                            | Candidate                         | CPU                       |
| ------------- | ----------------------------------- | --------------------------------- | ------------------------- |
| noise         | the branch                          | the same tree, as an empty commit | Intel Xeon Platinum 8370C |
| reuse         | the branch before the socket fix    | one kept guest connection         | AMD EPYC 7763             |
| tick          | the branch before the socket fix    | one shared imp list per tick      | AMD EPYC 7763             |
| budget        | the branch with the budget reverted | the branch                        | AMD EPYC 9V45             |
| touched pages | one build on 2 MiB pages            |                                   | AMD EPYC 7763             |

## Noise

Both sides run the same tree, so every change is the runner's own noise. At concurrency 1 to 16 a
p50 moves by up to 14% and a p95 by up to 18%, and the second side runs slower in most rows. No step
fails at any level. A change at 1 to 16 counts only past ±14% on the p50.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95  | baseline p99 | candidate p99  | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | -------------- | ------------ | -------------- | --------------- | ---------------- |
| create   | 1    | 233ms        | 266ms (+14%)  | 254ms        | 286ms (+13%)   | 273ms        | 297ms (+9%)    | 0               | 0                |
| create   | 4    | 571ms        | 640ms (+12%)  | 596ms        | 703ms (+18%)   | 604ms        | 706ms (+17%)   | 0               | 0                |
| create   | 16   | 1583ms       | 1691ms (+7%)  | 2383ms       | 2784ms (+17%)  | 2496ms       | 2810ms (+13%)  | 0               | 0                |
| create   | 64   | 5945ms       | 6656ms (+12%) | 10529ms      | 11791ms (+12%) | 10719ms      | 12519ms (+17%) | 0               | 0                |
| wake     | 1    | 77ms         | 76ms (-1%)    | 82ms         | 83ms (+1%)     | 86ms         | 91ms (+6%)     | 0               | 0                |
| wake     | 4    | 161ms        | 161ms (0%)    | 189ms        | 172ms (-9%)    | 194ms        | 172ms (-11%)   | 0               | 0                |
| wake     | 16   | 351ms        | 361ms (+3%)   | 752ms        | 746ms (-1%)    | 762ms        | 757ms (-1%)    | 0               | 0                |
| wake     | 64   | 2386ms       | 2003ms (-16%) | 6601ms       | 6105ms (-8%)   | 7129ms       | 6982ms (-2%)   | 0               | 0                |
| restore  | 1    | 246ms        | 273ms (+11%)  | 270ms        | 296ms (+10%)   | 280ms        | 303ms (+8%)    | 0               | 0                |
| restore  | 4    | 548ms        | 613ms (+12%)  | 585ms        | 654ms (+12%)   | 590ms        | 672ms (+14%)   | 0               | 0                |
| restore  | 16   | 1403ms       | 1503ms (+7%)  | 2279ms       | 2641ms (+16%)  | 2337ms       | 2672ms (+14%)  | 0               | 0                |
| restore  | 64   | 5542ms       | 6185ms (+12%) | 9919ms       | 11523ms (+16%) | 10253ms      | 11931ms (+16%) | 0               | 0                |

## The kept guest connection

impd keeps one idle connection to each guest's agent for the read-only calls ping, activity and
`services.list`, and the agent serves requests on a connection until it closes. One p50 at 1 to 16
moves past the noise: the wake at 16 falls by 15%, and the wake at 64 rises by 21%. The create p50
rises by 9 to 12% at 1 and 4. The change is dropped.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95 | baseline p99 | candidate p99 | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | ------------- | ------------ | ------------- | --------------- | ---------------- |
| create   | 1    | 291ms        | 326ms (+12%)  | 308ms        | 380ms (+23%)  | 324ms        | 437ms (+35%)  | 0               | 0                |
| create   | 4    | 723ms        | 788ms (+9%)   | 773ms        | 880ms (+14%)  | 783ms        | 892ms (+14%)  | 0               | 0                |
| create   | 16   | 1938ms       | 1975ms (+2%)  | 3071ms       | 3256ms (+6%)  | 3095ms       | 3291ms (+6%)  | 0               | 0                |
| create   | 64   | 7578ms       | 8302ms (+10%) | 13264ms      | 14345ms (+8%) | 13449ms      | 14615ms (+9%) | 0               | 0                |
| wake     | 1    | 98ms         | 97ms (-1%)    | 165ms        | 151ms (-8%)   | 170ms        | 176ms (+4%)   | 0               | 0                |
| wake     | 4    | 206ms        | 215ms (+4%)   | 283ms        | 246ms (-13%)  | 291ms        | 248ms (-15%)  | 0               | 0                |
| wake     | 16   | 599ms        | 507ms (-15%)  | 955ms        | 963ms (+1%)   | 968ms        | 971ms (0%)    | 0               | 0                |
| wake     | 64   | 2253ms       | 2715ms (+21%) | 7950ms       | 8487ms (+7%)  | 8911ms       | 9361ms (+5%)  | 0               | 0                |
| restore  | 1    | 331ms        | 330ms (0%)    | 404ms        | 373ms (-8%)   | 419ms        | 397ms (-5%)   | 0               | 0                |
| restore  | 4    | 734ms        | 732ms (0%)    | 827ms        | 870ms (+5%)   | 859ms        | 883ms (+3%)   | 0               | 0                |
| restore  | 16   | 1917ms       | 1929ms (+1%)  | 3289ms       | 3244ms (-1%)  | 3298ms       | 3259ms (-1%)  | 0               | 0                |
| restore  | 64   | 7709ms       | 7594ms (-1%)  | 13728ms      | 13203ms (-4%) | 13994ms      | 13736ms (-2%) | 0               | 64               |

## The shared imp list

The idle, memory, governor and usage tickers read the imp list once per 250 ms window, and any imp
write starts a new read. No p50 at 1 to 16 moves past the noise, and the create p50 rises by 9 to
11%. The change is dropped.

| scenario | conc | baseline p50 | candidate p50  | baseline p95 | candidate p95    | baseline p99 | candidate p99    | baseline failed | candidate failed |
| -------- | ---- | ------------ | -------------- | ------------ | ---------------- | ------------ | ---------------- | --------------- | ---------------- |
| create   | 1    | 287ms        | 319ms (+11%)   | 318ms        | 392ms (+23%)     | 324ms        | 407ms (+26%)     | 0               | 0                |
| create   | 4    | 736ms        | 799ms (+9%)    | 789ms        | 864ms (+10%)     | 806ms        | 882ms (+9%)      | 0               | 0                |
| create   | 16   | 1943ms       | 2145ms (+10%)  | 3107ms       | 3266ms (+5%)     | 3133ms       | 3332ms (+6%)     | 1               | 0                |
| create   | 64   | 4507ms       | 8028ms (+78%)  | 13295ms      | 13529ms (+2%)    | 13717ms      | 13952ms (+2%)    | 36              | 0                |
| wake     | 1    | 96ms         | 93ms (-3%)     | 142ms        | 158ms (+11%)     | 179ms        | 160ms (-11%)     | 0               | 0                |
| wake     | 4    | 201ms        | 203ms (+1%)    | 236ms        | 244ms (+3%)      | 241ms        | 253ms (+5%)      | 0               | 0                |
| wake     | 16   | 497ms        | 505ms (+2%)    | 888ms        | 867ms (-2%)      | 895ms        | 872ms (-3%)      | 0               | 0                |
| wake     | 64   | 2775ms       | 2671ms (-4%)   | 8104ms       | 7799ms (-4%)     | 8860ms       | 8532ms (-4%)     | 1               | 0                |
| restore  | 1    | 324ms        | 304ms (-6%)    | 380ms        | 382ms (+1%)      | 420ms        | 384ms (-9%)      | 0               | 0                |
| restore  | 4    | 743ms        | 720ms (-3%)    | 822ms        | 767ms (-7%)      | 834ms        | 779ms (-7%)      | 0               | 0                |
| restore  | 16   | 1851ms       | 1755ms (-5%)   | 3176ms       | 3115ms (-2%)     | 3210ms       | 3168ms (-1%)     | 0               | 0                |
| restore  | 64   | 1017ms       | 7479ms (+635%) | 1127ms       | 13091ms (+1062%) | 1127ms       | 13452ms (+1094%) | 62              | 0                |

## The background work budget

The RAM governor's admission lane serves a waiting foreground admit before the enforce tick, a
memory grow, a template build or a restart's reconcile. At most 4 wakes and 4 template restores run
at once, in two pools, so a wake that falls back to a template boot never waits on its own pool. A
wake takes its slot before it checks for a stop, so a wake still queued when impd stops leaves its
snapshot in place, and a test in `imp-vm-ops.test.ts` pins that every imp is asleep afterwards.

At 16 the p50 falls by 27% for creates and by 36% for wakes and restores. At 64 the baseline refused
34 wakes for the RAM budget and the budget refused none, the wake p50 falls by 33%, and the restore
p50 by 47%. At 1 and 4 the p50 moves by 0 to 15%, inside the noise but for one create at 15%. The
change is kept.

The cap moves time from the middle of a burst to its tail: at 64 the wake p95 rises by 124%, because
the last wakes of the burst wait for a slot.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95  | baseline p99 | candidate p99  | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | -------------- | ------------ | -------------- | --------------- | ---------------- |
| create   | 1    | 198ms        | 221ms (+12%)  | 266ms        | 240ms (-10%)   | 268ms        | 242ms (-10%)   | 0               | 0                |
| create   | 4    | 456ms        | 525ms (+15%)  | 479ms        | 603ms (+26%)   | 513ms        | 609ms (+19%)   | 0               | 0                |
| create   | 16   | 1762ms       | 1294ms (-27%) | 1978ms       | 2209ms (+12%)  | 1984ms       | 2211ms (+11%)  | 0               | 0                |
| create   | 64   | 5252ms       | 5302ms (+1%)  | 8662ms       | 9105ms (+5%)   | 8680ms       | 9434ms (+9%)   | 0               | 0                |
| wake     | 1    | 72ms         | 72ms (0%)     | 78ms         | 78ms (0%)      | 82ms         | 82ms (0%)      | 0               | 0                |
| wake     | 4    | 143ms        | 143ms (0%)    | 162ms        | 173ms (+7%)    | 169ms        | 177ms (+5%)    | 0               | 0                |
| wake     | 16   | 511ms        | 327ms (-36%)  | 564ms        | 611ms (+8%)    | 567ms        | 614ms (+8%)    | 0               | 0                |
| wake     | 64   | 2956ms       | 1988ms (-33%) | 3058ms       | 6839ms (+124%) | 3065ms       | 7513ms (+145%) | 34              | 0                |
| restore  | 1    | 212ms        | 229ms (+8%)   | 240ms        | 261ms (+9%)    | 246ms        | 281ms (+14%)   | 0               | 0                |
| restore  | 4    | 464ms        | 496ms (+7%)   | 494ms        | 519ms (+5%)    | 498ms        | 565ms (+13%)   | 0               | 0                |
| restore  | 16   | 1915ms       | 1228ms (-36%) | 2047ms       | 2053ms (0%)    | 2052ms       | 2110ms (+3%)   | 0               | 0                |
| restore  | 64   | 9577ms       | 5122ms (-47%) | 9948ms       | 8850ms (-11%)  | 9964ms       | 9058ms (-9%)   | 0               | 0                |

## Touched pages on a 2 MiB sleep

`scripts/bench/measure-touched-pages.ts` writes 128 MiB into a 1 GiB imp, puts it to sleep, wakes
it, reads the 128 MiB back and puts it to sleep again. A 2 MiB sleep writes a mincore diff, which
holds every pool page the guest touched, read or written. The measurement compares that with the 4
KiB pages whose bytes changed between the two sleeps, which a dirty-page diff would write. Its
output is in [touched-pages.json](./results/touched-pages.json).

| Sleep | Pool pages held | Memory file on disk | Changed 4 KiB pages | Changed, in 2 MiB pages |
| ----- | --------------- | ------------------- | ------------------- | ----------------------- |
| cold  | 218 MiB         | 199 MiB             |                     |                         |
| woken | 220 MiB         | 202 MiB             | 9.3 MiB             | 72 MiB                  |

The woken guest held 220 MiB at its second sleep, while 9.3 MiB of its pages changed. The touched
pages are about 24 times the changed ones, and the changed pages fall in 72 MiB of 2 MiB pages, a
third of the touched ones.

## Socket race under load

Before the socket fix, most runs failed many steps at 64. impd's logs showed the first Firecracker
API call of a start refused with `ECONNREFUSED` just after the socket file appeared. A template
restore counted that as a fault of the template and removed it while other restores mapped it, so
the rest booted the kernel at once and passed the agent's deadline. impd now connects to the socket
before its first call, and the noise and budget runs after the fix show no refused call, no removed
template and no failed step at 64 beyond the RAM refusals.

## Untested

- Every run is on a nested runner with 4 vCPUs, never on a real host, whose CPUs and disk move each
  figure.
- Each comparison has 2 rounds of 20 samples on one runner, and the baseline always runs first in a
  round. A gain under the noise needs more rounds to show.
- No run uses 2 MiB pages for the latency comparison, or turns KSM on.
- The concurrency levels stop at 64, and the imps hold 256 MiB each.
- The touched-page measurement is one run of one workload.
