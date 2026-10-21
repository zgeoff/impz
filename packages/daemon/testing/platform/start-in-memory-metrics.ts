import { onTestFinished } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

interface MetricPoint {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: unknown;
}

export function startInMemoryMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  // an hour, so the periodic reader never exports on its own during a test
  const meterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
  });

  const isRegistered = metrics.setGlobalMeterProvider(meterProvider);

  if (!isRegistered) {
    throw new Error(
      'another meter provider is registered; this test would read none of its points',
    );
  }

  onTestFinished(async () => {
    metrics.disable();

    await meterProvider.shutdown();
  });

  return {
    readPoints: async (name: string): Promise<MetricPoint[]> => {
      await meterProvider.forceFlush();

      const metric = exporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .findLast((candidate) => candidate.descriptor.name === name);

      return (metric?.dataPoints ?? []).map((point) => ({
        attributes: point.attributes,
        value: point.value,
      }));
    },
  };
}
