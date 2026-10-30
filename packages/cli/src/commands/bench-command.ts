import { watchEvents } from '@impz/client';
import { BENCH_ARGS } from '../bench/bench-args';
import { BENCH_SCENARIOS } from '../bench/bench-scenarios';
import { buildBenchReport } from '../bench/build-bench-report';
import { findBenchFailure } from '../bench/find-bench-failure';
import { formatBenchReport } from '../bench/format-bench-report';
import { parseBenchLevels } from '../bench/parse-bench-levels';
import { pickBenchScenarios } from '../bench/pick-bench-scenarios';
import { runBench } from '../bench/run-bench';
import { withStopSignal } from '../bench/with-stop-signal';
import { defineCommand } from '../cli/define-command';
import { runAction } from '../cli/run-action';
import { formatJson } from '../output/format-output';
import { parseDuration } from '../parse/parse-duration';
import { parseCount, parseSize } from '../parse/parse-size';

export const benchCommand = defineCommand({
  name: 'bench',
  description: 'Time creates, wakes and restores on this host at rising concurrency',
  args: BENCH_ARGS,
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const io = ctx.extensions.impz.io;

      const scenarios = pickBenchScenarios(
        ctx.values.scenarios ?? 'create,wake,restore',
        BENCH_SCENARIOS,
      );

      const levels = parseBenchLevels(ctx.values.concurrency);
      const samples = parseCount(ctx.values.samples, 'samples');

      const limitMs =
        ctx.values['limit-p50-ms'] === undefined
          ? null
          : parseCount(ctx.values['limit-p50-ms'], 'limit-p50-ms');

      const settings = {
        memoryMib: ctx.values.memory === undefined ? null : parseSize(ctx.values.memory),
        image: ctx.values.image ?? null,
        awakeMs: parseDuration(ctx.values.awake) * 1000,
      };

      // an imp name is a DNS label of at most 31 characters, too short for a
      // whole UUID; the bench refuses names that exist and removes only imps
      // it created, so a shared ID costs a refused run, never another's imp
      const runID = crypto.randomUUID().replaceAll('-', '').slice(0, 12);

      const startedAt = new Date();

      const before = await client.system.info();

      const results = await withStopSignal(process, (signal) =>
        runBench(
          {
            client,
            watchEvents,
            now: () => performance.now(),
            wait: io.sleep,
            onProgress: (line) => {
              io.printError(line);
            },
            signal,
          },
          { runID, scenarios, levels, samples, settings },
        ),
      );

      const after = await client.system.info();

      const report = buildBenchReport({
        runID,
        startedAt,
        label: ctx.values.label ?? null,
        before,
        after,
        settings: { ...settings, levels, samples },
        results,
      });

      const output = ctx.values.json === true ? formatJson(report) : formatBenchReport(report);

      io.print(output);

      const failure = findBenchFailure(results, limitMs);

      if (failure !== null) {
        throw new Error(failure);
      }
    }),
});
