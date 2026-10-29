// Each round runs every arm once, in order, so a long run's drift falls on
// each arm alike; docs/runbooks/development.md#the-bench-job runs it.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import * as z from 'zod';
import { formatBenchCompare } from './format-bench-compare';
import type { ArmReport } from './format-bench-compare';
import { parseBenchArmsArgs } from './parse-bench-arms-args';
import type { BenchArm } from './parse-bench-arms-args';

const IMPZ = resolve(import.meta.dir, '..', 'impz');
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

  for (let round = 1; round <= args.rounds; round += 1) {
    for (const arm of args.arms) {
      console.error(`bench arms: round ${String(round)}, ${arm.name}`);

      const json = await runArm(arm, args.benchArgs);

      writeFileSync(join(args.out, `${arm.name}-${String(round)}.json`), json);

      reports.push({ arm: arm.name, json });
    }
  }

  const table = formatBenchCompare(reports);

  console.log(table);

  const summary = process.env['GITHUB_STEP_SUMMARY'];

  if (summary !== undefined) {
    appendFileSync(summary, `${table}\n`);
  }
}

async function runArm(arm: BenchArm, benchArgs: readonly string[]): Promise<string> {
  const checkout = resolve(arm.checkout);
  const dev = join(checkout, 'scripts', 'dev', 'dev.sh');

  const devEnv = {
    ...process.env,
    IMP_KERNEL: join(checkout, '.cache', 'ci', 'vmlinux'),
    IMP_SYSTEM_DRIVE: join(checkout, '.cache', 'ci', 'imp-system.squashfs'),
  };

  await $`${dev} up`.env(devEnv);

  try {
    const shownToken = await $`${dev} token`.env(devEnv).text();

    const token = shownToken.trim();
    const cliEnv = { ...process.env, IMP_URL: 'http://localhost:7070', IMP_TOKEN: token };

    await waitForInfo(cliEnv, (info) => info.defaults?.image !== null);

    // the warm-up's creates build the boot template, so every arm's timed
    // run starts with the cache warm
    await $`${IMPZ} bench create --concurrency 1 --samples 3`.env(cliEnv).quiet();

    await waitForInfo(cliEnv, (info) => (info.host?.bootTemplates ?? 1) > 0);

    return await $`${IMPZ} bench ${benchArgs} --label ${arm.name} --json`.env(cliEnv).text();
  } finally {
    await $`${dev} down`.env(devEnv);
  }
}

async function waitForInfo(
  env: Readonly<Record<string, string | undefined>>,
  isReady: (info: z.infer<typeof InfoSchema>) => boolean,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    const shown = await $`${IMPZ} info --json`.env(env).quiet().nothrow();

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
