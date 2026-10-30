# Spike: lifecycle bench experiments

This spike runs `impz bench` on CI's KVM runner to decide which of three changes to impd's lifecycle
paths to keep. It also measures how much more a 2 MiB sleep writes than the pages a guest changed.
[results.md](./results.md) holds every table.

## Question

Does any of three changes make creates, wakes and restores faster at concurrency 1, 4, 16 and 64
without losing work: one kept guest connection for read-only unary calls, one shared imp list per
lifecycle tick, or a background work budget that admits foreground wakes first and caps concurrent
restores? And does the mincore diff of a 2 MiB sleep write much more than a dirty-page diff would?

## Answer

- Keep the background work budget. At concurrency 16 it cuts the p50 of creates by 39%, of wakes by
  41% and of restores by 45%, and at 64 it ends every failed create and wake. At 1 and 4 it stays
  within 3%.
- Drop the kept guest connection. No p50 at 1 to 16 improves past the runner's noise of ±11%, and
  the restore at 16 rises by 21%.
- Drop the shared imp list. It raises the p50 of creates by 9 to 16% and improves nothing.
- A woken 2 MiB guest that read 128 MiB back held 220 MiB of pool pages at its next sleep, while 9.3
  MiB of its 4 KiB pages changed: the mincore diff writes about 24 times what changed.

Land the budget, and weigh a dirty-page diff for 2 MiB sleeps in the vm runtime design.

## Run it

```sh
impz bench create,wake,restore --concurrency 1,4,16,64 --samples 20 --memory 256m \
  --label <host> --json > <host>.json
```

[Setup](./results.md#setup) gives the runner, the versions and the settings. The CI comparison and
the touched-page measurement run as the [bench job](../../../runbooks/development.md#the-bench-job)
describes.

## Results

[results.md](./results.md) holds the tables, and [results/](./results/) holds each run's JSON
reports.

## Untested

Every run is on a nested 4-CPU runner, never on a real host; [Untested](./results.md#untested) lists
the rest.
