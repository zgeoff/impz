import { watchEvents } from '@impz/client';
import { jsonArg } from '../args/common-args';
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
  args: {
    scenarios: {
      type: 'positional',
      description: `scenarios, comma-separated: ${BENCH_SCENARIOS.map((scenario) => scenario.name).join(', ')} (default: create,wake,restore)`,
      required: false,
    },
    concurrency: {
      type: 'string',
      description: 'how many imps take the timed step at once, comma-separated',
      default: '1,4,16,64',
    },
    samples: {
      type: 'string',
      description: 'the fewest timed steps at each concurrency',
      default: '20',
    },
    memory: { type: 'string', description: "each imp's memory (default: the host's)" },
    image: { type: 'string', description: "each imp's image (default: the host's)" },
    awake: {
      type: 'string',
      description: 'how long an imp stays awake before a scenario puts it to sleep (30s, 2m)',
      default: '0',
    },
    label: { type: 'string', description: 'a name for this machine, kept with the results' },
    'limit-p50-ms': {
      type: 'string',
      description: 'fail when the median at any concurrency passes this many ms',
    },
    json: jsonArg,
  },
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

      const runID = crypto.randomUUID().replaceAll('-', '').slice(0, 12);

      const startedAt = new Date();

      const before = await client.system.info();

      const results = await withStopSignal(process, (signal) =>
        runBench(
          {
            client,
            watchEvents,
            now: () => performance.now(),
            wait: (durationMs) => Bun.sleep(durationMs),
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
