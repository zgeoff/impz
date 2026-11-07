import { expect, onTestFinished, test } from 'bun:test';
import { spanExporter } from '@impz/shared/test-utils/register-tracing';
import invariant from 'tiny-invariant';
import { buildMockImpRecord } from '../../test-utils/imps/build-mock-imp-record';
import { startInMemoryMetrics } from '../../test-utils/platform/start-in-memory-metrics';
import type { LoggedImpEvent } from '../db/imp-log-entry';
import { createEventBus } from '../events/event-bus';
import { startImpTelemetry } from './imp-telemetry';
import type { ResourceDelta } from './resource-delta';

test('it records imp.lifecycle.transitions per reason', async () => {
  const recorded = startInMemoryMetrics();
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpAdded',
    imp: buildMockImpRecord(),
  });

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'held',
    imp: buildMockImpRecord(),
  });

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'held',
    imp: buildMockImpRecord(),
  });

  bus.publish({ seq: 1, at: new Date(), ev: 'ImpRemoved', imp: buildMockImpRecord() });

  stop();

  const points = await recorded.readPoints('imp.lifecycle.transitions');

  expect(points).toStrictEqual([
    { attributes: { reason: 'created' }, value: 1 },
    { attributes: { reason: 'held' }, value: 2 },
    { attributes: { reason: 'removed' }, value: 1 },
  ]);
});

test('it records imp.lifecycle.duration per timed reason', async () => {
  const recorded = startInMemoryMetrics();
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: buildMockImpRecord(),
    detail: { durationMs: 900 },
  });

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: buildMockImpRecord(),
    detail: { durationMs: 40 },
  });

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'held',
    imp: buildMockImpRecord(),
    detail: { durationMs: 5 },
  });

  stop();

  const points = await recorded.readPoints('imp.lifecycle.duration');

  expect(points).toStrictEqual([
    { attributes: { reason: 'booted' }, value: expect.objectContaining({ count: 1, sum: 900 }) },
    { attributes: { reason: 'woke' }, value: expect.objectContaining({ count: 1, sum: 40 }) },
  ]);
});

test('it records imp.governor.decisions per decision', async () => {
  const recorded = startInMemoryMetrics();
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  for (const decision of ['refused', 'admitted', 'refused'] as const) {
    bus.publish({
      seq: 1,
      at: new Date(),
      ev: 'GovernorDecision',
      decision,
      name: 'dev',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    });
  }

  stop();

  const points = await recorded.readPoints('imp.governor.decisions');

  expect(points).toStrictEqual([
    { attributes: { decision: 'refused' }, value: 2 },
    { attributes: { decision: 'admitted' }, value: 1 },
  ]);
});

test('it records a span per timed transition, with each step a child in turn', () => {
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  bus.publish({
    seq: 1,
    at: new Date('2026-10-02T12:00:00.900Z'),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: buildMockImpRecord({ name: 'dev' }),
    detail: { durationMs: 900, steps: { 'boot.tap': 100, 'boot.vm': 800 } },
  });

  stop();

  const spans = spanExporter.getFinishedSpans().map((span) => ({
    name: span.name,
    startMs: span.startTime[0] * 1000 + span.startTime[1] / 1e6,
    endMs: span.endTime[0] * 1000 + span.endTime[1] / 1e6,
    parentSpanId: span.parentSpanContext?.spanId,
    attributes: span.attributes,
  }));

  const rootSpanId = spanExporter.getFinishedSpans().at(-1)?.spanContext().spanId;

  expect(spans).toStrictEqual([
    {
      name: 'boot.tap',
      startMs: Date.parse('2026-10-02T12:00:00.000Z'),
      endMs: Date.parse('2026-10-02T12:00:00.100Z'),
      parentSpanId: rootSpanId,
      attributes: {},
    },
    {
      name: 'boot.vm',
      startMs: Date.parse('2026-10-02T12:00:00.100Z'),
      endMs: Date.parse('2026-10-02T12:00:00.900Z'),
      parentSpanId: rootSpanId,
      attributes: {},
    },
    {
      name: 'imp.boot',
      startMs: Date.parse('2026-10-02T12:00:00.000Z'),
      endMs: Date.parse('2026-10-02T12:00:00.900Z'),
      parentSpanId: undefined,
      attributes: { 'imp.name': 'dev' },
    },
  ]);
});

test('it puts the trigger and the cold boot reason on the span', () => {
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: buildMockImpRecord({ name: 'dev' }),
    detail: { durationMs: 40, trigger: 'exec', coldBootReason: 'no-snapshot' },
  });

  stop();

  const attributes = spanExporter.getFinishedSpans().map((span) => span.attributes);

  expect(attributes).toStrictEqual([
    { 'imp.name': 'dev', 'imp.trigger': 'exec', 'imp.cold_boot_reason': 'no-snapshot' },
  ]);
});

test('it records no span for a transition without a duration', () => {
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  bus.publish({
    seq: 1,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: buildMockImpRecord(),
  });

  stop();

  expect(spanExporter.getFinishedSpans()).toStrictEqual([]);
});

test('it reads the imps by state into imp.imps', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map([['sleeping', 3]])),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  const points = await recorded.readPoints('imp.imps');

  expect(points).toStrictEqual([
    { attributes: { state: 'creating' }, value: 0 },
    { attributes: { state: 'running' }, value: 0 },
    { attributes: { state: 'sleeping' }, value: 3 },
    { attributes: { state: 'stopped' }, value: 0 },
    { attributes: { state: 'error' }, value: 0 },
  ]);
});

test('it reads the RAM in use into imp.ram.used', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  const points = await recorded.readPoints('imp.ram.used');

  expect(points).toStrictEqual([{ attributes: {}, value: 600 }]);
});

test('it reads the RAM budget into imp.ram.budget', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  const points = await recorded.readPoints('imp.ram.budget');

  expect(points).toStrictEqual([{ attributes: {}, value: 4096 }]);
});

test('it reads the disk the imps take on their own into imp.disk.used', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
    readDiskUsedBytes: () => 3_221_225_472,
  });

  onTestFinished(stop);

  const points = await recorded.readPoints('imp.disk.used');

  expect(points).toStrictEqual([{ attributes: {}, value: 3_221_225_472 }]);
});

test('it reads 1 into imp.host.reboot_needed while a kernel oops needs a reboot', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
    readRebootReason: () => 'a kernel oops',
  });

  onTestFinished(stop);

  const points = await recorded.readPoints('imp.host.reboot_needed');

  expect(points).toStrictEqual([{ attributes: {}, value: 1 }]);
});

test('it reads 0 into imp.host.reboot_needed while the host needs no reboot', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
    readRebootReason: () => null,
  });

  onTestFinished(stop);

  const points = await recorded.readPoints('imp.host.reboot_needed');

  expect(points).toStrictEqual([{ attributes: {}, value: 0 }]);
});

test('it reads no gauge once stopped', async () => {
  const recorded = startInMemoryMetrics();

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map([['running', 2]])),
    readRam: () => Promise.resolve({ usedMib: 600, budgetMib: 4096 }),
  });

  onTestFinished(stop);
  stop();

  const points = await recorded.readPoints('imp.imps');

  expect(points).toStrictEqual([]);
});

test('it feeds each sampler pass to the CPU, network and awake instruments', async () => {
  const recorded = startInMemoryMetrics();
  const listeners: ((deltas: readonly ResourceDelta[]) => void)[] = [];

  const stop = startImpTelemetry({
    events: createEventBus<LoggedImpEvent>(),
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
    subscribeResources: (listener) => {
      listeners.push(listener);

      return () => {};
    },
  });

  onTestFinished(stop);

  const [listener] = listeners;

  invariant(listener);

  listener([
    {
      intervalMs: 5000,
      cpuPercent: 50,
      cpuUsec: 2_500_000,
      throttledUsec: 500_000,
      netRxBytes: 1000,
      netTxBytes: 30,
    },
    {
      intervalMs: 5000,
      cpuPercent: 150,
      cpuUsec: 7_500_000,
      throttledUsec: 500_000,
      netRxBytes: 1000,
      netTxBytes: 30,
    },
  ]);

  const usage = await recorded.readPoints('imp.cpu.usage');
  const utilization = await recorded.readPoints('imp.cpu.utilization');
  const throttled = await recorded.readPoints('imp.cpu.throttled');
  const network = await recorded.readPoints('imp.network.io');
  const awake = await recorded.readPoints('imp.awake.time');

  expect(usage).toStrictEqual([{ attributes: {}, value: 2 }]);

  expect(utilization).toStrictEqual([
    { attributes: {}, value: expect.objectContaining({ count: 2, sum: 200 }) },
  ]);

  expect(throttled).toStrictEqual([{ attributes: {}, value: 1 }]);

  expect(network).toStrictEqual([
    { attributes: { direction: 'rx' }, value: 2000 },
    { attributes: { direction: 'tx' }, value: 60 },
  ]);

  expect(awake).toStrictEqual([{ attributes: {}, value: 10 }]);
});

test('it stays inert without a registered meter provider', () => {
  const bus = createEventBus<LoggedImpEvent>();

  const stop = startImpTelemetry({
    events: bus,
    readStateCounts: () => Promise.resolve(new Map()),
    readRam: () => Promise.resolve({ usedMib: 0, budgetMib: 4096 }),
  });

  onTestFinished(stop);

  expect(() => {
    bus.publish({
      seq: 1,
      at: new Date(),
      ev: 'ImpChanged',
      reason: 'booted',
      imp: buildMockImpRecord(),
      detail: { durationMs: 900, steps: { 'boot.vm': 900 } },
    });

    stop();
  }).not.toThrow();
});
