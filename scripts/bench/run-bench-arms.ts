// Each round runs every arm once, in order, so a long run's drift falls on
// each arm alike; docs/runbooks/development.md#the-bench-job runs it.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import * as z from 'zod';
import { buildDevLayout } from '../lib/build-dev-layout.ts';
import { buildWarmUpArgs } from './build-warm-up-args';
import { formatBenchCompare } from './format-bench-compare';
import type { ArmReport } from './format-bench-compare';
import { parseBenchArmsArgs } from './parse-bench-arms-args';
import type { BenchArm } from './parse-bench-arms-args';

const IMPZ = resolve(import.meta.dir, '..', 'impz');
const CONTAINER = process.env['IMP_DEV_NAME'] ?? 'imp-dev';
const READY_TIMEOUT_MS = 600_000;
const POLL_MS = 2000;

const InfoSchema = z.looseObject({
  defaults: z.looseObject({ image: z.string().nullable() }).optional(),
  host: z.looseObject({ bootTemplates: z.number().nullable() }).optional(),
});

async function main(): Promise<void> {
  const args = parseBenchArmsArgs(process.argv.slice(2));

  if (typeof args === 'string') {
    console.error(args);
    process.exit(2);
  }

  mkdirSync(args.out, { recursive: true });

  const reports: ArmReport[] = [];
  const failed: string[] = [];

  for (let round = 1; round <= args.rounds; round += 1) {
    for (const arm of args.arms) {
      const run = `${arm.name}-${String(round)}`;

      console.error(`bench arms: round ${String(round)}, ${arm.name}`);

      const ran = await runArm(arm, args.benchArgs, join(args.out, `${run}.impd.log`));

      if (ran.json === null) {
        failed.push(run);
      } else {
        writeFileSync(join(args.out, `${run}.json`), ran.json);

        reports.push({ arm: arm.name, json: ran.json });
      }

      if (!ran.isPassed) {
        console.error(`bench arms: ${run} failed; its impd log is in ${run}.impd.log`);
      }
    }
  }

  const table = formatBenchCompare(reports);

  console.log(table);

  const summary = process.env['GITHUB_STEP_SUMMARY'];

  if (summary !== undefined) {
    appendFileSync(summary, `${table}\n`);
  }

  if (failed.length > 0) {
    console.error(`bench arms: no report from ${failed.join(', ')}`);
    process.exit(1);
  }
}

interface ArmRun {
  readonly json: string | null;
  readonly isPassed: boolean;
}

// A bench that fails still prints its report when it finished, so a failed
// arm keeps its numbers; one that died mid-run has none.
async function runArm(
  arm: BenchArm,
  benchArgs: readonly string[],
  logPath: string,
): Promise<ArmRun> {
  const checkout = resolve(arm.checkout);
  const dev = join(checkout, 'scripts', 'dev', 'dev.sh');

  const devEnv = {
    ...process.env,
    IMP_KERNEL: join(checkout, '.cache', 'ci', 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(checkout, '.cache', 'ci', 'imp-system.squashfs'),
  };

  await $`${dev} ${['up']}`.env(devEnv);

  try {
    const shownToken = await $`${dev} ${['token']}`.env(devEnv).text();

    const token = shownToken.trim();
    const layout = buildDevLayout({ env: devEnv, root: checkout, cwd: process.cwd() });
    const cliEnv = { ...process.env, IMP_URL: layout.apiURL, IMP_TOKEN: token };

    await waitForInfo(cliEnv, (info) => info.defaults?.image !== null);

    // the warm-up's creates build the boot template, so every arm's timed
    // run starts with the cache warm
    await $`${IMPZ} ${buildWarmUpArgs(benchArgs)}`.env(cliEnv).quiet();

    await waitForInfo(cliEnv, (info) => (info.host?.bootTemplates ?? 1) > 0);

    const bench = await $`${IMPZ} ${['bench', ...benchArgs, '--label', arm.name, '--json']}`
      .env(cliEnv)
      .quiet()
      .nothrow();

    process.stderr.write(bench.stderr);

    const json = bench.stdout.toString();

    return { json: json.trim() === '' ? null : json, isPassed: bench.exitCode === 0 };
  } finally {
    const logs = await $`docker logs ${CONTAINER}`.quiet().nothrow();

    writeFileSync(logPath, Buffer.concat([logs.stdout, logs.stderr]));

    await $`${dev} ${['down']}`.env(devEnv);
  }
}

async function waitForInfo(
  env: Readonly<Record<string, string | undefined>>,
  isReady: (info: z.infer<typeof InfoSchema>) => boolean,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    const shown = await $`${IMPZ} ${['info', '--json']}`.env(env).quiet().nothrow();

    const info: unknown = shown.exitCode === 0 ? shown.json() : null;
    const parsed = InfoSchema.safeParse(info);

    if (parsed.success && isReady(parsed.data)) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error('bench arms: impd never got ready to bench');
    }

    await Bun.sleep(POLL_MS);
  }
}

await main();
