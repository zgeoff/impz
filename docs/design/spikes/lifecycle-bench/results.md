# Lifecycle bench results

Each table compares two builds of impd that ran on one CI runner, their rounds in turn, the baseline
first in each round. A cell holds the lower median of a side's 2 rounds, which is the smaller of the
two figures, and the change is against the baseline. The failed columns count the steps that failed
over both rounds, including the steps that arrange a sample, such as the create and sleep before a
wake. A level whose samples mostly failed has few latencies left, so its change is no measure of
either build.

## Setup

Every run is on a GitHub-hosted `ubuntu-24.04` runner with nested KVM, 4 vCPUs and Linux
7.0.0-1017-azure. impd runs in a dev instance on XFS with Firecracker v1.17.0, guest kernel 6.1.188,
a RAM budget of 12,288 MiB, 4 KiB guest pages, and KSM off. The bench creates each imp with 256 MiB,
asks for 20 samples at each of the concurrency levels 1, 4, 16 and 64, and runs create, wake and
restore. The bench times whole bursts, so a round takes 20, 20, 32 and 64 samples at those levels. A
restore restores an awake imp to a checkpoint. In these runs, the first round of each level woke
imps that had just been created and slept once, and each later round woke imps that had woken
before. At concurrency 16, half of the wakes are first wakes after a create, and at 64, with one
round, all of them are. The bench now wakes and sleeps each new imp once before its first timed
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

| scenario | conc | baseline p50 | candidate p50  | baseline p95 | candidate p95   | baseline p99 | candidate p99   | baseline failed | candidate failed |
| -------- | ---- | ------------ | -------------- | ------------ | --------------- | ------------ | --------------- | --------------- | ---------------- |
| create   | 1    | 233 ms       | 266 ms (+14%)  | 254 ms       | 286 ms (+13%)   | 273 ms       | 297 ms (+9%)    | 0               | 0                |
| create   | 4    | 571 ms       | 640 ms (+12%)  | 596 ms       | 703 ms (+18%)   | 604 ms       | 706 ms (+17%)   | 0               | 0                |
| create   | 16   | 1583 ms      | 1691 ms (+7%)  | 2383 ms      | 2784 ms (+17%)  | 2496 ms      | 2810 ms (+13%)  | 0               | 0                |
| create   | 64   | 5945 ms      | 6656 ms (+12%) | 10529 ms     | 11791 ms (+12%) | 10719 ms     | 12519 ms (+17%) | 0               | 0                |
| wake     | 1    | 77 ms        | 76 ms (-1%)    | 82 ms        | 83 ms (+1%)     | 86 ms        | 91 ms (+6%)     | 0               | 0                |
| wake     | 4    | 161 ms       | 161 ms (0%)    | 189 ms       | 172 ms (-9%)    | 194 ms       | 172 ms (-11%)   | 0               | 0                |
| wake     | 16   | 351 ms       | 361 ms (+3%)   | 752 ms       | 746 ms (-1%)    | 762 ms       | 757 ms (-1%)    | 0               | 0                |
| wake     | 64   | 2386 ms      | 2003 ms (-16%) | 6601 ms      | 6105 ms (-8%)   | 7129 ms      | 6982 ms (-2%)   | 0               | 0                |
| restore  | 1    | 246 ms       | 273 ms (+11%)  | 270 ms       | 296 ms (+10%)   | 280 ms       | 303 ms (+8%)    | 0               | 0                |
| restore  | 4    | 548 ms       | 613 ms (+12%)  | 585 ms       | 654 ms (+12%)   | 590 ms       | 672 ms (+14%)   | 0               | 0                |
| restore  | 16   | 1403 ms      | 1503 ms (+7%)  | 2279 ms      | 2641 ms (+16%)  | 2337 ms      | 2672 ms (+14%)  | 0               | 0                |
| restore  | 64   | 5542 ms      | 6185 ms (+12%) | 9919 ms      | 11523 ms (+16%) | 10253 ms     | 11931 ms (+16%) | 0               | 0                |

## The kept guest connection

impd keeps one idle connection to each guest's agent for the read-only calls ping, activity and
`services.list`, and the agent serves requests on a connection until it closes. One p50 at 1 to 16
moves past the noise: the wake at 16 falls by 15%, and the wake at 64 rises by 21%. The create p50
rises by 9 to 12% at 1 and 4. The change is dropped.

| scenario | conc | baseline p50 | candidate p50  | baseline p95 | candidate p95  | baseline p99 | candidate p99  | baseline failed | candidate failed |
| -------- | ---- | ------------ | -------------- | ------------ | -------------- | ------------ | -------------- | --------------- | ---------------- |
| create   | 1    | 291 ms       | 326 ms (+12%)  | 308 ms       | 380 ms (+23%)  | 324 ms       | 437 ms (+35%)  | 0               | 0                |
| create   | 4    | 723 ms       | 788 ms (+9%)   | 773 ms       | 880 ms (+14%)  | 783 ms       | 892 ms (+14%)  | 0               | 0                |
| create   | 16   | 1938 ms      | 1975 ms (+2%)  | 3071 ms      | 3256 ms (+6%)  | 3095 ms      | 3291 ms (+6%)  | 0               | 0                |
| create   | 64   | 7578 ms      | 8302 ms (+10%) | 13264 ms     | 14345 ms (+8%) | 13449 ms     | 14615 ms (+9%) | 0               | 0                |
| wake     | 1    | 98 ms        | 97 ms (-1%)    | 165 ms       | 151 ms (-8%)   | 170 ms       | 176 ms (+4%)   | 0               | 0                |
| wake     | 4    | 206 ms       | 215 ms (+4%)   | 283 ms       | 246 ms (-13%)  | 291 ms       | 248 ms (-15%)  | 0               | 0                |
| wake     | 16   | 599 ms       | 507 ms (-15%)  | 955 ms       | 963 ms (+1%)   | 968 ms       | 971 ms (0%)    | 0               | 0                |
| wake     | 64   | 2253 ms      | 2715 ms (+21%) | 7950 ms      | 8487 ms (+7%)  | 8911 ms      | 9361 ms (+5%)  | 0               | 0                |
| restore  | 1    | 331 ms       | 330 ms (0%)    | 404 ms       | 373 ms (-8%)   | 419 ms       | 397 ms (-5%)   | 0               | 0                |
| restore  | 4    | 734 ms       | 732 ms (0%)    | 827 ms       | 870 ms (+5%)   | 859 ms       | 883 ms (+3%)   | 0               | 0                |
| restore  | 16   | 1917 ms      | 1929 ms (+1%)  | 3289 ms      | 3244 ms (-1%)  | 3298 ms      | 3259 ms (-1%)  | 0               | 0                |
| restore  | 64   | 7709 ms      | 7594 ms (-1%)  | 13728 ms     | 13203 ms (-4%) | 13994 ms     | 13736 ms (-2%) | 0               | 64               |

## The shared imp list

The idle, memory, governor and usage tickers read the imp list once per 250 ms window, and any imp
write starts a new read. No p50 at 1 to 16 moves past the noise, and the create p50 rises by 9 to
11%. The change is dropped.

| scenario | conc | baseline p50 | candidate p50   | baseline p95 | candidate p95     | baseline p99 | candidate p99     | baseline failed | candidate failed |
| -------- | ---- | ------------ | --------------- | ------------ | ----------------- | ------------ | ----------------- | --------------- | ---------------- |
| create   | 1    | 287 ms       | 319 ms (+11%)   | 318 ms       | 392 ms (+23%)     | 324 ms       | 407 ms (+26%)     | 0               | 0                |
| create   | 4    | 736 ms       | 799 ms (+9%)    | 789 ms       | 864 ms (+10%)     | 806 ms       | 882 ms (+9%)      | 0               | 0                |
| create   | 16   | 1943 ms      | 2145 ms (+10%)  | 3107 ms      | 3266 ms (+5%)     | 3133 ms      | 3332 ms (+6%)     | 1               | 0                |
| create   | 64   | 4507 ms      | 8028 ms (+78%)  | 13295 ms     | 13529 ms (+2%)    | 13717 ms     | 13952 ms (+2%)    | 36              | 0                |
| wake     | 1    | 96 ms        | 93 ms (-3%)     | 142 ms       | 158 ms (+11%)     | 179 ms       | 160 ms (-11%)     | 0               | 0                |
| wake     | 4    | 201 ms       | 203 ms (+1%)    | 236 ms       | 244 ms (+3%)      | 241 ms       | 253 ms (+5%)      | 0               | 0                |
| wake     | 16   | 497 ms       | 505 ms (+2%)    | 888 ms       | 867 ms (-2%)      | 895 ms       | 872 ms (-3%)      | 0               | 0                |
| wake     | 64   | 2775 ms      | 2671 ms (-4%)   | 8104 ms      | 7799 ms (-4%)     | 8860 ms      | 8532 ms (-4%)     | 1               | 0                |
| restore  | 1    | 324 ms       | 304 ms (-6%)    | 380 ms       | 382 ms (+1%)      | 420 ms       | 384 ms (-9%)      | 0               | 0                |
| restore  | 4    | 743 ms       | 720 ms (-3%)    | 822 ms       | 767 ms (-7%)      | 834 ms       | 779 ms (-7%)      | 0               | 0                |
| restore  | 16   | 1851 ms      | 1755 ms (-5%)   | 3176 ms      | 3115 ms (-2%)     | 3210 ms      | 3168 ms (-1%)     | 0               | 0                |
| restore  | 64   | 1017 ms      | 7479 ms (+635%) | 1127 ms      | 13091 ms (+1062%) | 1127 ms      | 13452 ms (+1094%) | 62              | 0                |

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

| scenario | conc | baseline p50 | candidate p50  | baseline p95 | candidate p95   | baseline p99 | candidate p99   | baseline failed | candidate failed |
| -------- | ---- | ------------ | -------------- | ------------ | --------------- | ------------ | --------------- | --------------- | ---------------- |
| create   | 1    | 198 ms       | 221 ms (+12%)  | 266 ms       | 240 ms (-10%)   | 268 ms       | 242 ms (-10%)   | 0               | 0                |
| create   | 4    | 456 ms       | 525 ms (+15%)  | 479 ms       | 603 ms (+26%)   | 513 ms       | 609 ms (+19%)   | 0               | 0                |
| create   | 16   | 1762 ms      | 1294 ms (-27%) | 1978 ms      | 2209 ms (+12%)  | 1984 ms      | 2211 ms (+11%)  | 0               | 0                |
| create   | 64   | 5252 ms      | 5302 ms (+1%)  | 8662 ms      | 9105 ms (+5%)   | 8680 ms      | 9434 ms (+9%)   | 0               | 0                |
| wake     | 1    | 72 ms        | 72 ms (0%)     | 78 ms        | 78 ms (0%)      | 82 ms        | 82 ms (0%)      | 0               | 0                |
| wake     | 4    | 143 ms       | 143 ms (0%)    | 162 ms       | 173 ms (+7%)    | 169 ms       | 177 ms (+5%)    | 0               | 0                |
| wake     | 16   | 511 ms       | 327 ms (-36%)  | 564 ms       | 611 ms (+8%)    | 567 ms       | 614 ms (+8%)    | 0               | 0                |
| wake     | 64   | 2956 ms      | 1988 ms (-33%) | 3058 ms      | 6839 ms (+124%) | 3065 ms      | 7513 ms (+145%) | 34              | 0                |
| restore  | 1    | 212 ms       | 229 ms (+8%)   | 240 ms       | 261 ms (+9%)    | 246 ms       | 281 ms (+14%)   | 0               | 0                |
| restore  | 4    | 464 ms       | 496 ms (+7%)   | 494 ms       | 519 ms (+5%)    | 498 ms       | 565 ms (+13%)   | 0               | 0                |
| restore  | 16   | 1915 ms      | 1228 ms (-36%) | 2047 ms      | 2053 ms (0%)    | 2052 ms      | 2110 ms (+3%)   | 0               | 0                |
| restore  | 64   | 9577 ms      | 5122 ms (-47%) | 9948 ms      | 8850 ms (-11%)  | 9964 ms      | 9058 ms (-9%)   | 0               | 0                |

## Touched pages on a 2 MiB sleep

`packages/daemon/bench/measure-touched-pages.ts` writes 128 MiB into a 1 GiB imp, puts it to sleep,
wakes it, reads the 128 MiB back and puts it to sleep again. A 2 MiB sleep writes a mincore diff,
which holds every pool page the guest touched, read or written. The measurement compares that with
the 4 KiB pages whose bytes changed between the two sleeps, which a dirty-page diff would write. Its
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
- Each comparison has 2 rounds of 20 to 64 samples on one runner, and the baseline always runs first
  in a round. A gain under the noise needs more rounds to show.
- No run uses 2 MiB pages for the latency comparison, or turns KSM on.
- The concurrency levels stop at 64, and the imps hold 256 MiB each.
- The touched-page measurement is one run of one workload.
