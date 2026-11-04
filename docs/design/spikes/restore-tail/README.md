# Spike: the slow tail of boot template restores

On a production imp host, the target host, 5 of 12 boot template restores on 3 November took 5 to 21
times the median `agent` step. This spike finds where that time goes, so that the team knows whether
to change impd's restore path. [results.md](./results.md) holds every table.

A boot template is a memory snapshot of a booted guest whose agent waits for a claim. impd creates
or starts an imp by restoring a template and sending a claim, in which impd gives the guest the
imp's name, network and disk. impd logs each restore's steps to the host's systemd journal. The
`agent` step runs from impd's receipt of the guest's answer to the claim until the guest agent
answers a ping.

## Question

Over 9 hours on 3 November, local time UTC+11, the median `agent` step of 12 restores took 107 ms,
and the 5 slowest took 574 to 2,255 ms. Which step holds the extra time? Is a slow restore the first
one after the host or impd starts, or one that runs beside other restores?

## Answer

- No step of impd's restore path causes the tail: the host as a whole stalls. In each slow restore,
  steps that share nothing but the host slow down together. impd's `setup` step, which sets up the
  imp's network tap, takes 15 to 53 times its median in the 7 fast restores, and starting
  Firecracker takes 8 to 29 times. The guest's mount of the imp's disk takes 4 to 36 times.
- In 4 of the 5 slow restores, the mount holds most of the `agent` step. The guest starts the mount
  as soon as it answers the claim, so a mount can outlast an `agent` step that starts late.
- Each of the 5 slow restores ran while no other restore ran. At 11:56, home B and home C took 90
  and 78 ms, and home D, which started about 10 s after home C ended, took 927 ms.
- A start explains at most the restores just after it. The first restore after impd restarted at
  15:49 took 86 ms, and 4 of the 5 slow restores came 3 to 7 hours after the host booted. The 2
  restores right after the host boot, at 08:35 and outside the window, were slow too, within 25 s of
  impd building the template and booting 2 imps.
- The journal holds no CPU, memory-pressure or disk-latency figures, so the spike can't name the
  resource that stalls.

The spike recommends that impd keep its restore path and log the host's pressure-stall figures and
CPU steal time with each restore, so that the next slow restore shows the resource.

## Run it

**CAUTION:** `impz bench` creates and destroys imps on the host that your `impz` config points at.
On a production host, keep it at one create at a time, as below.

To time 10 creates from a checkout, run the CLI from source, which has the `bench` command:

```sh
bun packages/cli/src/main.ts bench create --concurrency 1 --samples 10 --memory 512M --json
```

Expect: one JSON report on stdout after about 15 s, with the create's p50 and p95 under
`results[0].latencyMs`. When the host has no template for 512 MiB imps, impd boots the kernel for
the first creates while it builds one. Each restore's `agent` step is in the host's journal, in the
`restored boot template` line of an imp whose name starts with `bench-<run ID>`, where `<run ID>` is
the report's `runID`.

To read the 9 hours of restores, run the journal command in [results.md](./results.md#setup) on the
target host.

## Results

- [results.md](./results.md): the per-step tables, each suspected cause, other work on the host and
  the bench run.
- [results/bench-create-idle.json](./results/bench-create-idle.json): the bench report.

## Untested

The bench ran one create at a time and put no stress load on the production host, so no run shows
which resource stalls. [results.md](./results.md#untested) gives the test that settles it.
