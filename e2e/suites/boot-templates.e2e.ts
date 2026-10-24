import { expect, onTestFinished, test } from 'bun:test';
import {
  checkShapeTemplateAbsent,
  readIsnSecret,
  readMac,
  readSessionOutput,
  readShapeTemplateKeys,
  removeShapeTemplates,
  waitForShapeTemplate,
} from '../lib/boot-template-guest';
import {
  getU32Span,
  parseLoggedGuestSteps,
  parseLoggedSteps,
  pickPercentile,
} from '../lib/boot-template-timing';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, requireImp, runImp, runInImp, runShellInImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { instance, readImpdLogSince, runChecked, runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// Each test boots a memory size of its own, so a template one test leaves
// under --keep is no other test's.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('boot-templates'), stack, client };
}

test('it makes the template of a shape on its second boot and restores it as imps with their own name, MAC, address, disk and CRNG', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}make-a`;
  const spare = `${ctx.prefix}make-x`;
  const second = `${ctx.prefix}make-b`;
  const third = `${ctx.prefix}make-c`;

  const started = new Date();

  registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(304));

  await removeShapeTemplates(304);
  await runImp('new', first, '--image', image, '--memory', '304', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);

  const afterFirst = await readShapeTemplateKeys(304);

  await runImp('new', spare, '--image', image, '--memory', '304', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);

  const key = await waitForShapeTemplate(304);

  await runImp('new', second, '--image', image, '--memory', '304', '--cpus', '1', '--disk', '6g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runImp('new', third, '--image', image, '--memory', '304', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, third));

  await waitForExec(third);

  const log = await readImpdLogSince(started);
  const row = await requireImp(second);

  const consoleLog = await runInContainer([
    'cat',
    `/var/lib/imp/imps/${row.id}/run/firecracker.log`,
  ]);

  const hostname = await runInImp(second, 'hostname');
  const secondMac = await readMac(second);
  const thirdMac = await readMac(third);
  const df = await runInImp(second, 'df', '-k', '/');
  const route = await runShellInImp(second, 'ip -4 route show default');

  const sizeKib = Number(df.trim().split('\n').at(-1)?.split(/\s+/v)[1]);

  expect(afterFirst).toStrictEqual([]);
  expect(log).toContain(`INFO impd.boot boot template ${key.slice(0, 12)} built in `);
  expect(log).toContain(`imp=${second} restored boot template ${key.slice(0, 12)}`);
  expect(log).toContain(`imp=${third} restored boot template ${key.slice(0, 12)}`);
  expect(consoleLog.stdout).toContain('boot: claim: crng reseeded from a 64-byte seed');
  expect(hostname).toBe(second);
  expect(secondMac).not.toBe('06:00:a9:fe:ff:fe');
  expect(thirdMac).not.toBe('06:00:a9:fe:ff:fe');
  expect(secondMac).not.toBe(thirdMac);

  // ext4 keeps some of the 6 GiB for itself.
  expect(sizeKib / (1024 * 1024)).toBeGreaterThan(5.8);
  expect(route).toContain('via');
});

test('it keys TCP with its own secret in each restored imp', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}isn-a`;
  const spare = `${ctx.prefix}isn-x`;
  const second = `${ctx.prefix}isn-b`;
  const third = `${ctx.prefix}isn-c`;

  await checkShapeTemplateAbsent(288);

  registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(288));

  await runImp('new', first, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(288);
  await runImp('new', second, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runImp('new', third, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, third));

  await waitForExec(third);

  const firstSecret = await readIsnSecret(first);
  const secondSecret = await readIsnSecret(second);
  const thirdSecret = await readIsnSecret(third);

  // Two guests that share the kernel's net_secret land within a few hundred.
  const again = await readIsnSecret(second);

  expect(getU32Span(secondSecret, again)).toBeLessThan(100_000);
  expect(getU32Span(secondSecret, thirdSecret)).toBeGreaterThan(100_000);
  expect(getU32Span(firstSecret, secondSecret)).toBeGreaterThan(100_000);
  expect(getU32Span(firstSecret, thirdSecret)).toBeGreaterThan(100_000);
});

test('it records each restored boot as its own cold boot, again after a restart restores the template', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}cold-a`;
  const spare = `${ctx.prefix}cold-x`;
  const second = `${ctx.prefix}cold-b`;
  const third = `${ctx.prefix}cold-c`;

  await checkShapeTemplateAbsent(320);

  registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(320));

  await runImp('new', first, '--image', image, '--memory', '320', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '320', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(320);
  await runImp('new', second, '--image', image, '--memory', '320', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runImp('new', third, '--image', image, '--memory', '320', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, third));

  await waitForExec(third);

  const before = await readSessionOutput(second);
  const other = await readSessionOutput(third);

  const restarted = new Date();

  await runImp('stop', second);
  await runImp('start', second);
  await waitForExec(second);

  const after = await readSessionOutput(second);
  const log = await readImpdLogSince(restarted);

  expect(log).toContain(`imp=${second} restored boot template`);
  expect(other.bootId).not.toBe(before.bootId);
  expect(after.bootId).not.toBe(before.bootId);

  expect(after.coldBoots.map((boot) => boot.bootId).slice(0, 2)).toStrictEqual([
    after.bootId,
    before.bootId,
  ]);
});

test('it sleeps and wakes a restored imp like any other', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}sleep-a`;
  const spare = `${ctx.prefix}sleep-x`;
  const second = `${ctx.prefix}sleep-b`;

  const started = new Date();

  await checkShapeTemplateAbsent(336);

  registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(336));

  await runImp('new', first, '--image', image, '--memory', '336', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '336', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(336);
  await runImp('new', second, '--image', image, '--memory', '336', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runShellInImp(second, 'echo kept > /root/marker');
  await runImp('sleep', second);

  const asleep = await requireImp(second);
  const marker = await runInImp(second, 'cat', '/root/marker');
  const log = await readImpdLogSince(started);

  expect(log).toContain(`imp=${second} restored boot template`);
  expect(asleep.state).toBe('sleeping');
  expect(marker).toBe('kept');
});

test('it times impz new from a template: the wall time and its spans', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}time-a`;
  const spare = `${ctx.prefix}time-x`;
  const walls: number[] = [];
  const spans: Record<string, number[]> = {};
  const guestSpans: Record<string, number[]> = {};

  await checkShapeTemplateAbsent(352);

  registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(352));

  await runImp('new', first, '--image', image, '--memory', '352', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '352', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(352);

  for (let index = 0; index < 10; index += 1) {
    const name = `${ctx.prefix}time-${String(index)}`;

    const created = new Date();

    const wallStarted = performance.now();

    await runImp('new', name, '--image', image, '--memory', '352', '--cpus', '1');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);

    walls.push(performance.now() - wallStarted);

    const log = await readImpdLogSince(created);

    const createdSteps = parseLoggedSteps(log, name, 'created in');
    const restoredSteps = parseLoggedSteps(log, name, 'restored boot template');
    const vmMs = Object.values(restoredSteps).reduce((sum, durationMs) => sum + durationMs, 0);

    const found = {
      ...restoredSteps,
      ...createdSteps,
      cli: Math.round((walls.at(-1) ?? 0) - (createdSteps['total'] ?? 0)),
      finish: (createdSteps['boot'] ?? 0) - vmMs,
    };

    for (const [step, durationMs] of Object.entries(found)) {
      spans[step] = [...(spans[step] ?? []), durationMs];
    }

    const guestSteps = parseLoggedGuestSteps(log, name, 'restored boot template');

    for (const [step, durationMs] of Object.entries(guestSteps)) {
      guestSpans[step] = [...(guestSpans[step] ?? []), durationMs];
    }

    await runImp('rm', name);
  }

  const medians = Object.fromEntries(
    Object.entries(spans).map(([step, values]) => [step, pickPercentile(values, 0.5)]),
  );

  writeMetric('bootTemplateNewMs', {
    p50: Math.round(pickPercentile(walls, 0.5)),
    p95: Math.round(pickPercentile(walls, 0.95)),
    count: walls.length,
  });

  writeMetric('bootTemplateNewSpansP50Ms', medians);

  writeMetric(
    'bootTemplateNewGuestStepsP50Ms',
    Object.fromEntries(
      Object.entries(guestSpans).map(([step, values]) => [step, pickPercentile(values, 0.5)]),
    ),
  );

  expect(spans['agent']).toHaveLength(10);

  expect(
    Object.fromEntries(Object.entries(guestSpans).map(([step, values]) => [step, values.length])),
  ).toMatchObject({
    claim: 10,
    mount: 10,
    grow: 10,
    network: 10,
    inner: 10,
    root: 10,
    services: 10,
    ready: 10,
  });
});

test.skipIf(!config.ownsZfsHost)(
  'it times the guest steps of impz new from a template on a ZFS host that caches no data',
  async () => {
    const ctx = await setupTest();

    const image = resolveImageName('e2e-ws');
    const first = `${ctx.prefix}cold-time-a`;
    const spare = `${ctx.prefix}cold-time-x`;
    const agentSpans: number[] = [];
    const guestSpans: Record<string, number[]> = {};

    await checkShapeTemplateAbsent(368);

    registerRemoval(ctx.stack, config.keep, () => removeShapeTemplates(368));

    await runImp('new', first, '--image', image, '--memory', '368', '--cpus', '2');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

    await waitForExec(first);
    await runImp('new', spare, '--image', image, '--memory', '368', '--cpus', '2');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

    await waitForExec(spare);
    await runImp('rm', spare);
    await waitForShapeTemplate(368);

    // A production guest pays tens of microseconds for each page it first
    // touches after a restore; with its caches warm, a test host pays a few.
    await runChecked([
      'docker',
      'exec',
      instance.container,
      'sh',
      '-c',
      'zfs set primarycache=metadata "$IMP_ZFS_ROOT"',
    ]);

    ctx.stack.defer(async () => {
      await runChecked([
        'docker',
        'exec',
        instance.container,
        'sh',
        '-c',
        'zfs inherit primarycache "$IMP_ZFS_ROOT"',
      ]);
    });

    for (let index = 0; index < 10; index += 1) {
      const name = `${ctx.prefix}cold-time-${String(index)}`;

      await runChecked(['sudo', '--non-interactive', 'sysctl', '--quiet', 'vm.drop_caches=3']);

      const created = new Date();

      await runImp('new', name, '--image', image, '--memory', '368', '--cpus', '2');

      registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

      await waitForExec(name);

      const log = await readImpdLogSince(created);

      agentSpans.push(parseLoggedSteps(log, name, 'restored boot template')['agent'] ?? 0);

      const guestSteps = parseLoggedGuestSteps(log, name, 'restored boot template');

      for (const [step, durationMs] of Object.entries(guestSteps)) {
        guestSpans[step] = [...(guestSpans[step] ?? []), durationMs];
      }

      await runImp('rm', name);
    }

    writeMetric('bootTemplateColdAgentMs', {
      p50: pickPercentile(agentSpans, 0.5),
      max: pickPercentile(agentSpans, 1),
      count: agentSpans.length,
    });

    writeMetric(
      'bootTemplateColdGuestStepsP50Ms',
      Object.fromEntries(
        Object.entries(guestSpans).map(([step, values]) => [step, pickPercentile(values, 0.5)]),
      ),
    );

    expect(agentSpans).toSatisfyAll((durationMs: number) => durationMs > 0);

    expect(
      Object.fromEntries(Object.entries(guestSpans).map(([step, values]) => [step, values.length])),
    ).toMatchObject({
      claim: 10,
      mount: 10,
      grow: 10,
      network: 10,
      inner: 10,
      root: 10,
      services: 10,
      ready: 10,
    });
  },
);
