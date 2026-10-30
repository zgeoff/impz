# Lifecycle bench results

Each table compares two builds of impd that ran on one CI runner, their rounds in turn. A cell holds
the median of a side's 2 rounds, and the change is against the baseline. The failed columns count
the steps that failed over both rounds, including the steps that arrange a sample, such as the
create and sleep before a wake. A level whose samples mostly failed has few latencies left, so its
change is no measure of either build.

## Setup

Every run is on a GitHub-hosted `ubuntu-24.04` runner with nested KVM, 4 vCPUs and Linux
7.0.0-1017-azure. impd runs in a dev instance on XFS with Firecracker v1.17.0, guest kernel 6.1.188,
a RAM budget of 12,288 MiB, 4 KiB guest pages, and KSM off. The bench creates each imp with 256 MiB,
takes 20 samples at each of the concurrency levels 1, 4, 16 and 64, and runs create, wake and
restore. A wake wakes an imp that went to sleep after an earlier wake, and a restore restores an
awake imp to a checkpoint. Before each side's timed run, 3 creates warm its boot template.

Each run lands on whichever runner GitHub assigns, so its CPU differs:

| Run           | Baseline                 | Candidate                         | CPU                       |
| ------------- | ------------------------ | --------------------------------- | ------------------------- |
| noise         | the branch               | the same tree, as an empty commit | AMD EPYC 9V45             |
| reuse         | the branch               | one kept guest connection         | AMD EPYC 9V74             |
| tick          | the branch               | one shared imp list per tick      | AMD EPYC 7763             |
| budget        | the branch               | the background work budget        | Intel Xeon Platinum 8370C |
| touched pages | one build on 2 MiB pages |                                   | AMD EPYC 7763             |

## Noise

Both sides run the same tree, so every change is the runner's own noise. At concurrency 1 to 16 a
p50 moves by up to 11%, a p95 by up to 13% and a p99 by up to 24%. At 64 the failures leave each
side a different set of samples, and the changes there run to 74%. A change at 1 to 16 counts only
past ±11% on the p50.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95 | baseline p99 | candidate p99 | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | ------------- | ------------ | ------------- | --------------- | ---------------- |
| create   | 1    | 215ms        | 223ms (+4%)   | 242ms        | 241ms (0%)    | 251ms        | 244ms (-3%)   | 0               | 0                |
| create   | 4    | 480ms        | 535ms (+11%)  | 525ms        | 557ms (+6%)   | 525ms        | 558ms (+6%)   | 0               | 0                |
| create   | 16   | 1831ms       | 1937ms (+6%)  | 2054ms       | 2238ms (+9%)  | 2056ms       | 2544ms (+24%) | 0               | 0                |
| create   | 64   | 6291ms       | 5025ms (-20%) | 8365ms       | 8037ms (-4%)  | 8382ms       | 8069ms (-4%)  | 0               | 39               |
| wake     | 1    | 71ms         | 71ms (0%)     | 76ms         | 86ms (+13%)   | 78ms         | 88ms (+13%)   | 0               | 0                |
| wake     | 4    | 142ms        | 138ms (-3%)   | 157ms        | 159ms (+1%)   | 164ms        | 170ms (+4%)   | 0               | 0                |
| wake     | 16   | 511ms        | 506ms (-1%)   | 576ms        | 555ms (-4%)   | 579ms        | 559ms (-3%)   | 0               | 0                |
| wake     | 64   | 3276ms       | 2746ms (-16%) | 3370ms       | 2839ms (-16%) | 3378ms       | 2849ms (-16%) | 34              | 34               |
| restore  | 1    | 220ms        | 214ms (-3%)   | 243ms        | 231ms (-5%)   | 250ms        | 242ms (-3%)   | 0               | 0                |
| restore  | 4    | 458ms        | 453ms (-1%)   | 495ms        | 486ms (-2%)   | 500ms        | 488ms (-2%)   | 0               | 0                |
| restore  | 16   | 1844ms       | 1874ms (+2%)  | 1926ms       | 2042ms (+6%)  | 1931ms       | 2053ms (+6%)  | 0               | 0                |
| restore  | 64   | 9378ms       | 2425ms (-74%) | 9784ms       | 2694ms (-72%) | 9797ms       | 2700ms (-72%) | 62              | 43               |

## The kept guest connection

impd keeps one idle connection to each guest's agent for the read-only calls ping, activity and
`services.list`, and the agent serves requests on a connection until it closes. No p50 at 1 to 16
moves past the noise except the restore at 16, which rises by 21%. The wake at 64 lost 80 of its
samples to failed arranges, so its change is no measure of the build. The change is dropped.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95  | baseline p99 | candidate p99  | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | -------------- | ------------ | -------------- | --------------- | ---------------- |
| create   | 1    | 294ms        | 325ms (+11%)  | 1007ms       | 1078ms (+7%)   | 1258ms       | 1191ms (-5%)   | 0               | 0                |
| create   | 4    | 691ms        | 745ms (+8%)   | 738ms        | 779ms (+6%)    | 738ms        | 834ms (+13%)   | 0               | 0                |
| create   | 16   | 3012ms       | 2961ms (-2%)  | 3363ms       | 3346ms (-1%)   | 3374ms       | 3351ms (-1%)   | 0               | 0                |
| create   | 64   | 8358ms       | 7640ms (-9%)  | 13412ms      | 13366ms (0%)   | 13447ms      | 13831ms (+3%)  | 0               | 47               |
| wake     | 1    | 100ms        | 93ms (-7%)    | 158ms        | 145ms (-8%)    | 166ms        | 146ms (-12%)   | 0               | 0                |
| wake     | 4    | 196ms        | 192ms (-2%)   | 230ms        | 244ms (+6%)    | 234ms        | 244ms (+4%)    | 0               | 0                |
| wake     | 16   | 732ms        | 762ms (+4%)   | 878ms        | 834ms (-5%)    | 882ms        | 1100ms (+25%)  | 0               | 2                |
| wake     | 64   | 3157ms       | 113ms (-96%)  | 3367ms       | 113ms (-97%)   | 3376ms       | 113ms (-97%)   | 34              | 80               |
| restore  | 1    | 310ms        | 326ms (+5%)   | 371ms        | 372ms (0%)     | 386ms        | 393ms (+2%)    | 0               | 0                |
| restore  | 4    | 688ms        | 699ms (+2%)   | 755ms        | 724ms (-4%)    | 785ms        | 731ms (-7%)    | 0               | 0                |
| restore  | 16   | 3095ms       | 3757ms (+21%) | 7636ms       | 7595ms (-1%)   | 7643ms       | 7604ms (-1%)   | 0               | 0                |
| restore  | 64   | 14716ms      | 14708ms (0%)  | 22129ms      | 18153ms (-18%) | 22151ms      | 18242ms (-18%) | 64              | 0                |

## The shared imp list

The idle, memory, governor and usage tickers read the imp list once per 250 ms window, and any imp
write starts a new read. The create p50 rises by 9%, 14% and 16% at 1, 4 and 16, and no figure
improves past the noise. The change is dropped.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95  | baseline p99 | candidate p99  | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | -------------- | ------------ | -------------- | --------------- | ---------------- |
| create   | 1    | 290ms        | 317ms (+9%)   | 411ms        | 387ms (-6%)    | 420ms        | 388ms (-8%)    | 0               | 0                |
| create   | 4    | 733ms        | 839ms (+14%)  | 769ms        | 899ms (+17%)   | 774ms        | 932ms (+20%)   | 0               | 0                |
| create   | 16   | 3039ms       | 3523ms (+16%) | 3243ms       | 3768ms (+16%)  | 3244ms       | 3777ms (+16%)  | 0               | 0                |
| create   | 64   | 10179ms      | 8000ms (-21%) | 14592ms      | 16371ms (+12%) | 14624ms      | 16400ms (+12%) | 0               | 31               |
| wake     | 1    | 94ms         | 96ms (+2%)    | 157ms        | 126ms (-20%)   | 160ms        | 133ms (-17%)   | 0               | 0                |
| wake     | 4    | 197ms        | 198ms (+1%)   | 259ms        | 244ms (-6%)    | 282ms        | 245ms (-13%)   | 0               | 0                |
| wake     | 16   | 714ms        | 737ms (+3%)   | 847ms        | 839ms (-1%)    | 852ms        | 846ms (-1%)    | 0               | 0                |
| wake     | 64   | 3602ms       | 4111ms (+14%) | 3831ms       | 4396ms (+15%)  | 3847ms       | 4406ms (+15%)  | 34              | 81               |
| restore  | 1    | 315ms        | 328ms (+4%)   | 354ms        | 405ms (+14%)   | 388ms        | 433ms (+12%)   | 0               | 0                |
| restore  | 4    | 710ms        | 742ms (+5%)   | 784ms        | 845ms (+8%)    | 803ms        | 851ms (+6%)    | 0               | 0                |
| restore  | 16   | 2952ms       | 3129ms (+6%)  | 3291ms       | 3359ms (+2%)   | 3297ms       | 3370ms (+2%)   | 0               | 0                |
| restore  | 64   | 14988ms      | 15198ms (+1%) | 18660ms      | 17655ms (-5%)  | 19022ms      | 17655ms (-7%)  | 29              | 57               |

## The background work budget

The RAM governor's admission lane serves a waiting foreground admit before the enforce tick, a
memory grow, a template build or a restart's reconcile. At most 4 wakes and 4 template restores run
at once, in two pools, so a wake that falls back to a template boot never waits on its own pool. A
wake takes its slot before it checks for a stop, so a wake still queued when impd stops leaves its
snapshot in place, and a test in `imp-vm-ops.test.ts` pins that every imp is asleep afterwards.

At 16 the p50 falls by 39% for creates, 41% for wakes and 45% for restores, and at 1 and 4 it stays
within 3%. At 64 the baseline failed 62 creates and 81 wake steps, and the budget failed none. The
change is kept.

Restores at 64 still fail on both sides. A restore boots the checkpoint's kernel, which the cap does
not cover, and 64 kernel boots on 4 vCPUs pass the agent's deadline. impd's log shows two more
effects of that load: an agent timeout counts as a fault of the boot template, so impd removes a
healthy template while other restores map it, and those restores then boot the kernel too.

| scenario | conc | baseline p50 | candidate p50 | baseline p95 | candidate p95  | baseline p99 | candidate p99  | baseline failed | candidate failed |
| -------- | ---- | ------------ | ------------- | ------------ | -------------- | ------------ | -------------- | --------------- | ---------------- |
| create   | 1    | 253ms        | 253ms (0%)    | 743ms        | 775ms (+4%)    | 781ms        | 797ms (+2%)    | 0               | 0                |
| create   | 4    | 588ms        | 584ms (-1%)   | 647ms        | 637ms (-2%)    | 648ms        | 649ms (0%)     | 0               | 0                |
| create   | 16   | 2481ms       | 1514ms (-39%) | 2717ms       | 2515ms (-7%)   | 2726ms       | 2591ms (-5%)   | 0               | 0                |
| create   | 64   | 11568ms      | 6296ms (-46%) | 17206ms      | 10864ms (-37%) | 17220ms      | 11200ms (-35%) | 62              | 0                |
| wake     | 1    | 77ms         | 77ms (0%)     | 85ms         | 83ms (-2%)     | 98ms         | 98ms (0%)      | 0               | 0                |
| wake     | 4    | 165ms        | 168ms (+2%)   | 179ms        | 191ms (+7%)    | 186ms        | 200ms (+8%)    | 0               | 0                |
| wake     | 16   | 645ms        | 379ms (-41%)  | 736ms        | 732ms (-1%)    | 798ms        | 743ms (-7%)    | 0               | 0                |
| wake     | 64   | 3305ms       | 2787ms (-16%) | 3526ms       | 7347ms (+108%) | 3540ms       | 7931ms (+124%) | 81              | 0                |
| restore  | 1    | 250ms        | 256ms (+2%)   | 279ms        | 276ms (-1%)    | 281ms        | 280ms (0%)     | 0               | 0                |
| restore  | 4    | 551ms        | 570ms (+3%)   | 575ms        | 597ms (+4%)    | 594ms        | 616ms (+4%)    | 0               | 0                |
| restore  | 16   | 2443ms       | 1334ms (-45%) | 2624ms       | 2448ms (-7%)   | 2632ms       | 2464ms (-6%)   | 0               | 0                |
| restore  | 64   | 13840ms      | 1009ms (-93%) | 15168ms      | 1033ms (-93%)  | 15168ms      | 1033ms (-93%)  | 113             | 125              |

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

## Untested

- Every run is on a nested runner with 4 vCPUs, never on a real host, whose CPUs and disk move each
  figure.
- Each comparison has 2 rounds of 20 samples on one runner. A gain under the noise needs more rounds
  to show.
- No run uses 2 MiB pages for the latency comparison, or turns KSM on.
- The concurrency levels stop at 64, and the imps hold 256 MiB each.
- The touched-page measurement is one run of one workload.
